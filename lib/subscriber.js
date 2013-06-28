var crypto = require('crypto');
var childProcess = require('child_process');
var events = require('events');
var path = require('path');
var Q = require('q');
var util = require('util');
var zephyr = require('zephyr');

var conf = require('./config.js');
var db = require('./db.js');
var error = require('./error.js');
var message = require('./message.js');
var Principal = require('./principal.js').Principal;
var queue = require('./queue.js');
var renew = require('./renew.js');
var zuser = require('./zuser.js');

var ROOST_CTL_CLASS = '_roost_ctl';

var ROOST_CTL_INNER_DEMON = 'inner_demon';
var INNER_DEMON_PING = 'ping_demon';

var PING_TIMEOUT = 20;
var PING_FREQUENCY = 10 * 60;

function subscriptionToZephyrTriple(sub) {
  return [sub.classKey, sub.instanceKey, sub.recipient];
}

function Subscriber() {
  events.EventEmitter.call(this);

  this.onConnectionErrorCb_ = this.onConnectionError_.bind(this);
  this.onConnectionEndCb_ = this.onConnectionEnd_.bind(this);

  // Dedicated database connection, so queries don't starve us out.
  this.dbConnection_ = null;
  this.reconnect_();

  // A queue to ensure we process messages serially.
  this.queue_ = new queue.JobQueue(this.processMessage_.bind(this));
  // Active inner demons.
  this.innerDemons_ = { };
  // Ticket renewal timer
  this.renewTimer_ = null;

  // Listen for notices.
  zephyr.on('notice', this.onNotice_.bind(this));
}
util.inherits(Subscriber, events.EventEmitter);

Subscriber.prototype.reconnect_ = function() {
  if (this.dbConnection_) {
    this.dbConnection_.removeListener('error', this.onConnectionErrorCb_);
    this.dbConnection_.removeListener('end', this.onConnectionEndCb_);
  }
  this.dbConnection_ = db.createConnection();
  this.dbConnection_.on('error', this.onConnectionErrorCb_);
  this.dbConnection_.on('end', this.onConnectionEndCb_);
}

Subscriber.prototype.onConnectionError_ = function(err) {
  console.log('Connection error. Reconnecting', err);
  this.reconnect_();
};

Subscriber.prototype.onConnectionEnd_ = function() {
  console.log('Connection ended. Reconnecting');
  this.reconnect_();
};

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
  }.bind(this), function(err) {
    // If we failed to save a message, scream loudly, but don't crash.
    console.error("Failed to save message!", err, msg);
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

Subscriber.prototype.refreshPublicSubs_ = function() {
  return db.getAllPublicSubscriptions().then(function(subs) {
    return Q.nfcall(zephyr.subscribeToSansDefaults,
                    subs.map(subscriptionToZephyrTriple));
  }.bind(this));
};

Subscriber.prototype.renewTickets_ = function() {
  renew.renewTickets().then(function() {
    // Also refresh subs. Not necessary, but good to have new keys.
    return this.refreshPublicSubs_();
  }.bind(this)).then(null, function(err) {
    console.error('Error refreshing tickets', err);
  }).done();
};

// Sort of odd to have this guy wrap all the zephyr functions, but oh
// well. The idea is that is the only guy that actually has to be a
// singleton. The rest can all be split over multiple machines
// assuming we can proxy over the 'message' events.

Subscriber.prototype.start = function() {
  var renewPromise;
  if (conf.get('daemonKeytab')) {
    renewPromise = renew.renewTickets();
  } else {
    renewPromise = Q();
    console.error('!!!!!!!!!!!!!!!!!!!!!');
    console.error('No daemon keytab configured. Using credential cache.');
    console.error('Configure a daemon principal in production.');
    console.error('!!!!!!!!!!!!!!!!!!!!!');
  }
  return renewPromise.then(function() {
    zephyr.initialize();
    zephyr.openPort();

    // Renew tickets regularly.
    if (conf.get('daemonKeytab')) {
      this.renewTimer_ = setInterval(this.renewTickets_.bind(this),
                                     conf.get('renewTimeout'));
    }
    return this.refreshPublicSubs_();
  }.bind(this));
};

Subscriber.prototype.addDefaultUserSubscriptions = function(user) {
  // Subscribe to personals.
  return db.addUserSubscription(
    user, 'message', '*', user.principal
  ).then(function() {
    // Parse the principal.
    var principal = Principal.fromString(user.principal);
    // If a single-component principal on this realm, automatically
    // subscribe to their personal class.
    //
    // TODO(davidben): Cross-realm?? Does that even happen?
    if (principal.name.length == 1 && principal.realm == zephyr.getRealm()) {
      return db.addUserSubscription(user, principal.name[0], '*', '');
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
  if (this.renewTimer_ != null)
    clearInterval(this.renewTimer_);
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

  this.principal_ = principal;
  this.pendingCommands_ = { };
  this.nextCommand_ = 1;
  this.exitted_ = Q.defer();
  this.process_ = childProcess.fork(
    path.join(__dirname, '../bin/inner-demon.js'), [principal]);
  // TODO(davidben): Ping the demons regularly to make sure they're
  // still working.
  this.needsCredentials_ = true;

  this.pendingPing_ = null;

  this.process_.on('message', this.onMessage_.bind(this));
  this.process_.on('exit', this.onExit_.bind(this));

  // Start pinging the inner demon.
  this.start().then(function() {
    this.schedulePing_();
  }.bind(this), function(err) {
    console.error('Failed to start demon', err);
    return this.expel();
  }).done();
};
util.inherits(InnerDemon, events.EventEmitter);

InnerDemon.prototype.schedulePing_ = function() {
  if (!Q.isPending(this.exitted_.promise))
    return;

  Q.nfcall(crypto.pseudoRandomBytes, 12).then(function(bytes) {
    if (!Q.isPending(this.exitted_.promise))
      return;

    this.pendingPing_ = bytes.toString('base64');
    var ping = {
      port: 1,
      class: ROOST_CTL_CLASS,
      instance: ROOST_CTL_INNER_DEMON,
      opcode: INNER_DEMON_PING,
      recipient: this.principal_,
      body: [ this.pendingPing_ ]
    };
    return Q.nfcall(zephyr.sendNotice, ping, zephyr.ZAUTH);
  }.bind(this)).then(function() {
    return Q.delay(PING_TIMEOUT * 1000).then(function() {
      if (!Q.isPending(this.exitted_.promise))
        return;

      // We missed the last ping.
      if (this.pendingPing_) {
        console.error('Failed to ping inner demon for', this.principal_);
        this.needsCredentials_ = true;
      }
    }.bind(this));
  }.bind(this), function(err) {
    console.error('Error pinging', this.principal_, err);
  }.bind(this)).then(function() {
    // Wait and then loop back again.
    return Q.delay(PING_FREQUENCY * 1000);
  }.bind(this)).then(function() {
    this.schedulePing_();
  }.bind(this)).done();
};

InnerDemon.prototype.pingTimeout_ = function() {
  if (!Q.isPending(this.exitted_.promise))
    return;

  // We missed the last ping.
  if (this.pendingPing_) {
    console.log('Failed to ping inner demon for', this.principal_);
    this.needsCredentials_ = true;
  }

  setTimeout(this.schedulePing_.bind(this), PING_FREQUENCY * 1000);
};

InnerDemon.prototype.handlePong_ = function(message) {
  if (this.pendingPing_ &&
      message.auth === 1 &&
      message.class === ROOST_CTL_CLASS &&
      message.instance === ROOST_CTL_INNER_DEMON &&
      message.opcode === INNER_DEMON_PING &&
      message.recipient === this.principal_ &&
      message.message === this.pendingPing_) {
    this.pendingPing_ = null;
    this.needsCredentials_ = false;
  }
};

InnerDemon.prototype.needsCredentials = function() {
  return this.needsCredentials_;
};

InnerDemon.prototype.start = function(sessionState) {
  return this.command_('start', [sessionState]);
};

InnerDemon.prototype.subscribeTo = function(subs, ticket) {
  // Inject subscriptions to ping messages for the inner demon.
  subs = subs.concat([
    [ROOST_CTL_CLASS, ROOST_CTL_INNER_DEMON, this.principal_]
  ]);
  return this.command_('subscribeTo', [subs, ticket]).then(function() {
    this.needsCredentials_ = false;
    // Clear the current pending ping.
    this.pendingPing_ = null;
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
  if (msg.cmd == 'message') {
    if (msg.message.classKey === ROOST_CTL_CLASS) {
      this.handlePong_(msg.message);
    } else {
      this.emit('message', msg.message);
    }
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
