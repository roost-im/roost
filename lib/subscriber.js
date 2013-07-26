var events = require('events');
var fs = require('fs');
var Q = require('q');
var util = require('util');
var zephyr = require('zephyr');

var conf = require('./config.js');
var db = require('./db.js');
var error = require('./error.js');
var innerdemon = require('./innerdemon.js');
var message = require('./message.js');
var Principal = require('./principal.js').Principal;
var renew = require('./renew.js');
var sequtil = require('./sequtil.js');
var zutil = require('./zutil.js');

var MAX_SUBSCRIBE_CHUNK = 100;

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
  this.queue_ = new sequtil.JobQueue(this.processMessage_.bind(this));
  // Active inner demons.
  this.innerDemons_ = { };
  // Ticket renewal timer
  this.renewTimer_ = null;
  // State saving timer.
  this.stateTimer_ = null;
  // Throttler and serializer for state saving.
  this.stateSaver_ = null;

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

Subscriber.prototype.addJob_ = function(msg) {
  var count = this.queue_.addJob(msg);
  if (count > 1)
    console.log('Messages stalled; queue size is', count);
}

Subscriber.prototype.onNotice_ = function(notice) {
  var msg = message.noticeToMessage(notice);
  if (msg)
    this.addJob_(msg);
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
    //
    // TODO(davidben): Keep the message in the queue! Do an
    // exponential backoff sort of thing.
    console.error("Failed to save message!", err, msg);
  }.bind(this));
};

Subscriber.prototype.spawnInnerDemon_ = function(principal, sessionState) {
  if (this.innerDemons_[principal])
    return this.innerDemons_[principal];

  console.log('Spawning inner demon for %s', principal);
  this.innerDemons_[principal] =
    new innerdemon.InnerDemon(principal, sessionState);

  this.innerDemons_[principal].on('message', function(msg) {
    var recipient = msg.isOutgoing ? msg.sender : msg.recipient;
    if (recipient != principal) {
      console.error('Got message with bad recipient!', principal, msg);
    }
    this.addJob_(msg);
  }.bind(this));

  this.innerDemons_[principal].on('exit', function(code) {
    console.log('Demon for %s exited with code %d', principal, code);
    delete this.innerDemons_[principal];
  }.bind(this));

  return this.innerDemons_[principal];
};

Subscriber.prototype.refreshPrivateSubs = function(user,
                                                   creds,
                                                   knownGoodCreds) {
  var innerDemon = this.spawnInnerDemon_(user.principal);
  return db.getUserPrivateSubscriptions(user).then(function(subs) {
    return innerDemon.subscribeTo(subs.map(subscriptionToZephyrTriple),
                                  creds, knownGoodCreds);
  }).then(function() {
    // Inner demon state changed. Subject to our throttling, save
    // state.
    if (this.stateSaver_)
      this.stateSaver_.request();
  }.bind(this));
};

Subscriber.prototype.subscribeTo_ = function(subs) {
  // Identical to zephyr.subscribeToSansDefaults, but chunking by 500
  // to avoid zhm bugs.
  console.log('Subscribing to %d subs', subs.length);
  var promise = Q();
  for (var i = 0; i < subs.length; i += MAX_SUBSCRIBE_CHUNK) {
    promise = promise.then(function(i) {
      console.log('Subscribed to %d of %d', i, subs.length);
      return Q.nfcall(zephyr.subscribeToSansDefaults,
                      subs.slice(i, i + MAX_SUBSCRIBE_CHUNK));
    }.bind(null, i));
  }
  return promise;
};

Subscriber.prototype.refreshPublicSubs_ = function() {
  return db.getAllPublicSubscriptions().then(function(subs) {
    return this.subscribeTo_(subs.map(subscriptionToZephyrTriple));
  }.bind(this));
};

Subscriber.prototype.renewTickets_ = function() {
  console.log('Renewing tickets...');
  renew.renewTickets().then(function() {
    console.log('Renewed. Refreshing public subs...');
    // Also refresh subs. Not necessary, but good to have new keys.
    return this.refreshPublicSubs_();
  }.bind(this)).then(function() {
    console.log('Refreshed.');
  }, function(err) {
    console.error('Error refreshing tickets', err);
  }).done();
};

Subscriber.prototype.restoreInnerDemonState_ = function() {
  return Q.nfcall(
    fs.readFile, conf.get('demonStateFile')
  ).then(function(data) {
    return JSON.parse(data);
  }, function(err) {
    if (err.code == 'ENOENT')
      return { };
    throw err;
  }).then(function(state) {
    return Q.all(Object.keys(state).map(function(principal) {
      if (typeof state[principal] === 'string') {
        state[principal] = {
          sessionState: state[principal],
          lastGoodTicket: null
        };
      }
      // Restore inner demon with saved zephyr state.
      var innerDemon =
        this.spawnInnerDemon_(principal, state[principal].sessionState);
      // If we have a valid ticket on file, also try to refresh subs
      // from that.
      if (state[principal].lastGoodTicket &&
          state[principal].lastGoodTicket.endtime > (new Date()).getTime()) {
        return db.getUser(principal).then(function(user) {
          return this.refreshPrivateSubs(user,
                                         state[principal].lastGoodTicket, true);
        }.bind(this)).then(null, function(err) {
          console.log('Failed to use (possible expired) saved creds for',
                      principal, err);
        });
      } else {
        return Q();
      }
    }.bind(this)));
  }.bind(this));
};

// Sort of odd to have this guy wrap all the zephyr functions, but oh
// well. The idea is that is the only guy that actually has to be a
// singleton. The rest can all be split over multiple machines
// assuming we can proxy over the 'message' events.

Subscriber.prototype.start = function() {
  // TODO(davidben): Starting inner demons and the like assume zephyr
  // is up. But it would probably be nice to do this afterwards just
  // to decrease the likelihood that we get one of the inner demons'
  // ports? Dunno if that's a problem, realistically. The code
  // previously tried to do that, but it was racy.

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
                                     conf.get('renewTimer'));
    }
    this.restoreInnerDemonState_().then(function() {
      console.log("Restored all inner demon state");

      this.stateSaver_ = new sequtil.Throttler(
        this.saveInnerDemonState_.bind(this),
        conf.get('demonStateThrottle'));

      this.stateTimer_ = setInterval(
        this.stateSaver_.request.bind(this.stateSaver_),
        conf.get('demonStateTimer'));
    }.bind(this), function(err) {
      console.error("Error restoring inner demon state:", err);
    }).done();
    return this.refreshPublicSubs_();
  }.bind(this));
};

Subscriber.prototype.addDefaultUserSubscriptions = function(user) {
  var subs = [{
    class: 'message',
    instance: '*',
    recipient: user.principal
  }];
  // Parse the principal.
  var principal = Principal.fromString(user.principal);
  // If a single-component principal on this realm, automatically
  // subscribe to their personal class.
  //
  // TODO(davidben): Cross-realm?? Does that even happen?
  // TODO(davidben): Instead of this silly thing, use principal.toStringShort()?
  if (principal.name.length == 1 && principal.realm == zephyr.getRealm()) {
    subs.push({
      class: principal.name[0],
      instance: '*',
      recipient: ''
    });
  }

  // Subscribe to personals.
  return db.addUserSubscriptions(user, subs).then(function() {
    // Throw away the return...
  });
};

Subscriber.prototype.addUserSubscriptions = function(user, subs, creds) {
  // ACL checks.
  for (var i = 0; i < subs.length; i++) {
    if (zutil.isPersonal(subs[i].recipient)) {
      if (subs[i].recipient !== user.principal)
        return Q.reject(new error.UserError(403, "Cannot subscribe to triple"));
      if (!creds) {
        return Q.reject(
          new error.UserError(400, "Credentials required for personals"));
      }
    }
  }

  // Add to the database.
  return db.addUserSubscriptions(user, subs).then(function(withKeys) {
    // Bleh. Looping twice is kinda awkward, but this avoids calling
    // downcase everywhere.
    var publicSubs = [];
    for (var i = 0; i < withKeys.length; i++) {
      if (!zutil.isPersonal(withKeys[i].recipient)) {
        publicSubs.push(withKeys[i]);
      }
    }

    // And subscribe to the triples.
    return Q.all([
      // Personals, if any. (Or if we just got creds stapled.)
      creds ? this.refreshPrivateSubs(user, creds) : Q(),
      // Public notices, if any.
      publicSubs.length ?
        this.subscribeTo_(publicSubs.map(subscriptionToZephyrTriple)) : Q()
    ]).then(function() {
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

Subscriber.prototype.zwrite = function(user, msg, creds) {
  // We just saw creds. Ought to refresh with them.
  this.refreshPrivateSubs(user, creds, false).then(null, function(err) {
    console.log('Failed to refresh subs for', user.principal, err);
  }).done();
  // Oh, and do what the user actually wanted.
  var innerDemon = this.spawnInnerDemon_(user.principal);
  return innerDemon.zwrite(msg, creds);
};

Subscriber.prototype.needsZephyrCreds = function(user) {
  var innerDemon = this.innerDemons_[user.principal];
  if (!innerDemon)
    return true;
  return innerDemon.needsCredentials();
};

Subscriber.prototype.getInnerDemonState = function() {
  return Q.all(Object.keys(this.innerDemons_).map(function(key) {
    return this.innerDemons_[key].dumpSession().then(function(sessionState) {
      return [key, sessionState];
    }.bind(this));
  }.bind(this))).then(function(tuples) {
    var state = { };
    for (var i = 0; i < tuples.length; i++) {
      state[tuples[i][0]] = tuples[i][1];
    }
    return state;
  });
};

Subscriber.prototype.saveInnerDemonState_ = function() {
  console.log('Querying inner demons for session state');
  return this.getInnerDemonState().then(function(state) {
    console.log('Saving session state');
    return Q.nfcall(fs.writeFile,
                    conf.get('demonStateFile'),
                    JSON.stringify(state),
                    { mode: 0600 });
  }).then(null, function(err) {
    console.error('Error saving inner demon state', err);
  });
};

Subscriber.prototype.shutdown = function() {
  return (
    this.stateSaver_ ? this.stateSaver_.request({noThrottle: true}) : Q()
  ).then(function() {
    if (this.renewTimer_ != null)
      clearInterval(this.renewTimer_);
    if (this.stateTimer__ != null)
      clearInterval(this.stateTimer_);
    console.log('Canceling subscriptions and shutting down inner demons...');
    return Q.all([
      Q.nfcall(zephyr.cancelSubscriptions),
      Q.all(Object.keys(this.innerDemons_).map(function(key) {
        return this.innerDemons_[key].expel();
      }.bind(this)))
    ]);
  }.bind(this));
};

exports.Subscriber = Subscriber;
