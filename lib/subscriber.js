var childProcess = require('child_process');
var events = require('events');
var path = require('path');
var Q = require('q');
var util = require('util');
var zephyr = require('zephyr');

var db = require('./db.js');
var error = require('./error.js');
var message = require('./message.js');
var Principal = require('./principal.js').Principal;
var queue = require('./queue.js');
var zuser = require('./zuser.js');

function subscriptionToZephyrTriple(sub) {
  if (sub.instanceKey == null)
    return [sub.classKey, '*', sub.recipient];
  return [sub.classKey, sub.instanceKey, sub.recipient];
}

function Subscriber() {
  events.EventEmitter.call(this);

  // Dedicated database connection, so queries don't starve us out.
  this.dbConnection_ = db.createConnection();
  // A queue to ensure we process messages serially.
  this.queue_ = new queue.JobQueue(this.processMessage_.bind(this));
  // Active inner demons.
  this.innerDemons_ = { };

  // Listen for notices.
  zephyr.on('notice', this.onNotice_.bind(this));
}
util.inherits(Subscriber, events.EventEmitter);

Subscriber.prototype.onNotice_ = function(notice) {
  var msg = message.noticeToMessage(notice);
  if (msg)
    this.queue_.addJob(msg);
};

Subscriber.prototype.processMessage_ = function(msg) {
  // Save to the database.
  return this.dbConnection_.saveMessage(msg).then(function(ret) {
    // We didn't save the message. Don't do anything.
    if (!ret)
      return;

    msg.id = ret.id;
    this.emit('message', msg, ret.userIds);
  }.bind(this));
};

Subscriber.prototype.spawnInnerDemon_ = function(principal) {
  if (this.innerDemons_[principal])
    return this.innerDemons_[principal];

  console.log('Spawning inner demon for %s', principal);
  this.innerDemons_[principal] = new InnerDemon(principal);

  this.innerDemons_[principal].on('message', function(msg) {
    if (msg.recipient != principal) {
      console.error('Got message with bad recipient!', principal, msg);
    }
    this.queue_.addJob(msg);
  }.bind(this));

  this.innerDemons_[principal].on('exit', function(code) {
    console.log('Demon for %s exited with code %d', principal, code);
    delete this.innerDemons_[principal];
  }.bind(this));

  return this.innerDemons_[principal];
};

Subscriber.prototype.refreshPrivateSubs = function(user, creds) {
  var innerDemon = this.spawnInnerDemon_(user.principal);
  return db.getUserPrivateSubscriptions(user).then(function(subs) {
    return innerDemon.subscribeTo(subs.map(subscriptionToZephyrTriple), creds);
  });
};

// Sort of odd to have this guy wrap all the zephyr functions, but oh
// well. The idea is that is the only guy that actually has to be a
// singleton. The rest can all be split over multiple machines
// assuming we can proxy over the 'message' events.

Subscriber.prototype.start = function() {
  zephyr.openPort();

  return db.getAllPublicSubscriptions().then(function(subs) {
    console.log('Subscribing to %d triples', subs.length);
    return Q.nfcall(zephyr.subscribeToSansDefaults,
                    subs.map(subscriptionToZephyrTriple));
  }.bind(this));
};

Subscriber.prototype.addDefaultUserSubscriptions = function(user) {
  // Subscribe to personals.
  return db.addUserSubscription(
    user, 'message', null, user.principal
  ).then(function() {
    // Parse the principal.
    var principal = Principal.fromString(user.principal);
    // If a single-component principal on this realm, automatically
    // subscribe to their personal class.
    //
    // TODO(davidben): Cross-realm?? Does that even happen?
    if (principal.name.length == 1 && principal.realm == zephyr.getRealm()) {
      return db.addUserSubscription(user, principal.name[0], null, '');
    } else {
      return Q();
    }
  }).then(function() {
    // Throw away the return...
  });
};

Subscriber.prototype.addUserSubscription = function(user, sub, creds) {
  // ACLs.
  var personal = zuser.isPersonal(sub.recipient);
  if (personal) {
    if (sub.recipient !== user.principal)
      return Q.reject(new error.UserError(403, "Cannot subscribe to triple"));
    if (!creds) {
      return Q.reject(
        new error.UserError(400, "Credentials required for personals"));
    }
  }

  // Add to the database.
  return db.addUserSubscription(
    user, sub.class, sub.instance, sub.recipient
  ).then(function(withKeys) {
    // And subscribe to the triple.
    var subscribe;
    if (personal) {
      subscribe = this.refreshPrivateSubs(user, creds);
    } else {
      subscribe = Q.nfcall(zephyr.subscribeToSansDefaults,
                           [subscriptionToZephyrTriple(withKeys)]);
    }
    return subscribe.then(function() {
      return withKeys;
    });
  }.bind(this));
};

Subscriber.prototype.removeUserSubscription = function(user, sub, creds) {
  // Only remove from the database, not from the subscriber.
  // TODO(davidben): Garbage-collect the zephyr subs.
  // TODO(davidben): We can unsubscribe the inner demons just fine.
  return db.removeUserSubscription(user,
                                   sub.class, sub.instance, sub.recipient);
};

Subscriber.prototype.needsZephyrCreds = function(user) {
  var innerDemon = this.innerDemons_[user.principal];
  if (!innerDemon)
    return true;
  return innerDemon.needsCredentials();
};

Subscriber.prototype.shutdown = function() {
  return Q.all([
    Q.nfcall(zephyr.cancelSubscriptions),
    Q.all(Object.keys(this.innerDemons_).map(function(key) {
      return this.innerDemons_[key].expel();
    }.bind(this)))
  ]);
};

exports.Subscriber = Subscriber;

function InnerDemon(principal) {
  events.EventEmitter.call(this);

  this.pendingCommands_ = { };
  this.nextCommand_ = 1;
  this.exitted_ = Q.defer();
  this.process_ = childProcess.fork(
    path.join(__dirname, '../bin/inner-demon.js'), [principal]);
  // TODO(davidben): Ping the demons regularly to make sure they're
  // still working.
  this.needsCredentials_ = true;

  this.process_.on('message', this.onMessage_.bind(this));
  this.process_.on('exit', this.onExit_.bind(this));
};
util.inherits(InnerDemon, events.EventEmitter);

InnerDemon.prototype.needsCredentials = function() {
  return this.needsCredentials_;
};

InnerDemon.prototype.subscribeTo = function(subs, ticket) {
  return this.command_('subscribeTo', [subs, ticket]).then(function() {
    this.needsCredentials_ = false;
  }.bind(this), function(err) {
    this.needsCredentials_ = true;
    throw err;
  }.bind(this));
};

InnerDemon.prototype.expel = function() {
  return this.command_('expel', []).then(function() {
    return this.exitted_.promise;
  }.bind(this));
};

InnerDemon.prototype.command_ = function(cmd, args) {
  var msg = {
    id: this.nextCommand_++,
    cmd: cmd,
    args: args
  };
  this.process_.send(msg);
  this.pendingCommands_[msg.id] = Q.defer();
  return this.pendingCommands_[msg.id].promise;
};

InnerDemon.prototype.onMessage_ = function(msg) {
  console.dir(msg);
  if (msg.cmd == 'message') {
    this.emit('message', msg.message);
  } else if (msg.cmd == 'response') {
    if (msg.id in this.pendingCommands_) {
      this.pendingCommands_[msg.id].resolve(msg.value);
      delete this.pendingCommands_[msg.id];
    } else {
      console.error("Unknown command id", msg);
    }
  } else if (msg.cmd == 'error') {
    if (msg.id in this.pendingCommands_) {
      this.pendingCommands_[msg.id].reject(msg.error);
      delete this.pendingCommands_[msg.id];
    } else {
      console.error("Unknown command id", msg);
    }
  }
};

InnerDemon.prototype.onExit_ = function(code, signal) {
  // Cancel all pending commands.
  Object.keys(this.pendingCommands_).forEach(function(id) {
    this.pendingCommands_[id].reject("Inner demon exited");
    delete this.pendingCommands_[id];
  }.bind(this));

  this.exitted_.resolve(code);
  this.emit('exit', code, signal);
};
