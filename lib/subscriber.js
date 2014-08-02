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
var store = require('./store.js');
var zutil = require('./zutil.js');

function subscriptionToZephyrTriple(sub) {
  return [sub.classKey, sub.instanceKey, sub.recipient];
}

function Subscriber() {
  events.EventEmitter.call(this);

  this.store_ = new store.MessageStore(db);

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

  // Forward message emits.
  this.store_.on('message', this.emit.bind(this, 'message'));
}
util.inherits(Subscriber, events.EventEmitter);

Subscriber.prototype.onNotice_ = function(notice) {
  var msg = message.noticeToMessage(notice);
  if (msg)
    this.store_.addMessage(msg);
  // TODO(davidben): Hold on to the current ExponentialBackoff
  // instance and force-retry it? Seems a decent enough place to do it
  // or something. Or maybe on SIGHUP or something, I dunno.
};

Subscriber.prototype.getMessages = function(user, msgId, filter, opts) {
  return this.store_.getMessages(user, msgId, filter, opts);  // Bah.
};

Subscriber.prototype.spawnInnerDemon_ = function(principal, sessionState) {
  if (this.innerDemons_[principal])
    return this.innerDemons_[principal];

  console.log('Spawning inner demon for %s', principal);
  this.innerDemons_[principal] =
    new innerdemon.InnerDemon(principal, sessionState);

  this.innerDemons_[principal].on('message', function(msg) {
    var recipient = msg.isOutgoing ? msg.sender : msg.recipient;
    // The zephyrds actually compare recipients case-insensitively,
    // but not when subscribing. Since cross-realm messages come from
    // other zephyrds which are sensible, I believe this is only
    // relevant for personals.
    //
    // zephyrd uses strcasecmp which is locale-specific and
    // toLowerCase is Unicode-aware, but UCS-2 only per ES5.1, but
    // whatever. This is all just a sanity check anyway.
    if (recipient.toLowerCase() != principal.toLowerCase()) {
      console.error('Got message with bad recipient!', principal, msg);
    }
    // This nonsense is really not worth having separate recepient and
    // receipientKey, so just normalize the darn thing.
    if (!msg.isOutgoing)
      msg.recipient = principal;
    this.store_.addMessage(msg);
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
  var deferred = Q.defer();
  console.log('Subscribing to %d subs', subs.length);
  var ev = zephyr.subscribeToSansDefaults(subs, deferred.makeNodeResolver());
  if (ev) {
    ev.on('servackprogress', function(count) {
      if (count % 50 == 0)
        console.log('Subscribe progress: %d/%d packets', count, ev.packets);
    });
  }
  return deferred.promise;
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

Subscriber.prototype.restoreQueueStateSync_ = function() {
  // Whatever, this really doesn't have to be async right
  // now.
  var queue;
  try {
    queue = JSON.parse(fs.readFileSync(conf.get('queueStateFile')));
  } catch (err) {
    if (err.code == 'ENOENT') {
      queue = [];
    } else {
      throw err;
    }
  }
  this.store_.restoreSaveQueue(queue);
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
    return this.store_.start();
  }.bind(this)).then(function() {
    // Restore the message queue BEFORE we can possibly get messages.
    this.restoreQueueStateSync_();

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

Subscriber.prototype.addDefaultUserSubscriptions = function(user, clientId) {
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
  return this.addUserSubscriptions(
    user, clientId, subs, null, true
  ).then(function() {
    // Throw away the return...
  });
};

Subscriber.prototype.addUserSubscriptions = function(user, clientId,
                                                     subs, creds,
                                                     allowNoCreds) {
  // ACL checks.
  for (var i = 0; i < subs.length; i++) {
    if (zutil.isPersonal(subs[i].recipient)) {
      if (subs[i].recipient !== user.principal)
        return Q.reject(new error.UserError(403, "Cannot subscribe to triple"));
      if (!creds && !allowNoCreds) {
        return Q.reject(
          new error.UserError(400, "Credentials required for personals"));
      }
    }
  }

  // Add to the database.
  return db.addUserSubscriptions(user, subs).then(function(withKeys) {
    this.emit('subscribe', user, clientId, subs);

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

Subscriber.prototype.removeUserSubscription = function(user, clientId,
                                                       sub, creds) {
  // Only remove from the database, not from the subscriber.
  // TODO(davidben): Garbage-collect the zephyr subs.
  // TODO(davidben): We can unsubscribe the inner demons just fine.
  return db.removeUserSubscription(
    user, sub.class, sub.instance, sub.recipient
  ).then(function(withKey) {
    this.emit('unsubscribe', user, clientId, withKey);
    return withKey;
  }.bind(this));
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

Subscriber.prototype.saveQueueStateSync_ = function() {
  // Not much point in doing this one periodically.
  fs.writeFileSync(conf.get('queueStateFile'),
                   JSON.stringify(this.store_.saveQueue()),
                   { mode: 0600 });
};

Subscriber.prototype.shutdown = function() {
  return (
    this.stateSaver_ ? this.stateSaver_.request({noThrottle: true}) : Q()
  ).then(function() {
    if (this.renewTimer_ != null)
      clearInterval(this.renewTimer_);
    if (this.stateTimer_ != null)
      clearInterval(this.stateTimer_);
    console.log('Saving message queue');
    this.saveQueueStateSync_();
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
