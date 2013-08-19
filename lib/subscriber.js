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

var MAX_SUBSCRIBE_CHUNK = 200;

function subscriptionToZephyrTriple(sub) {
  return [sub.classKey, sub.instanceKey, sub.recipient];
}

function Subscriber() {
  events.EventEmitter.call(this);

  // Dedicated database pool, so queries don't starve us out.
  this.dbPool_ = db.createPool();

  // The next message id.
  this.nextMessageId_ = null;

  // Queues to ensure we process messages serially.
  this.prepareQueue_ = new sequtil.JobQueue(this.prepareMessage_.bind(this));
  this.saveQueue_ = new sequtil.JobQueue(this.saveMessage_.bind(this));

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

Subscriber.prototype.addJob_ = function(msg) {
  msg.id = this.nextMessageId_++;
  var count = this.prepareQueue_.addJob(msg);
  if (count > 1)
    console.log('Prepare queue stalled; queue size is', count);
}

Subscriber.prototype.onNotice_ = function(notice) {
  var msg = message.noticeToMessage(notice);
  if (msg)
    this.addJob_(msg);
  // TODO(davidben): Hold on to the current ExponentialBackoff
  // instance and force-retry it? Seems a decent enough place to do it
  // or something. Or maybe on SIGHUP or something, I dunno.
};

Subscriber.prototype.prepareMessage_ = function(msg) {
  return new sequtil.ExponentialBackoff(function() {
    return this.dbPool_.getConnection().then(function(conn) {
      return conn.getUsersForMessage(msg).finally(conn.end.bind(conn));
    });
  }.bind(this), { description: 'routing' }).promise().then(function(userIds) {
    // No one received the message. Skip it.
    if (!userIds.length)
      return;

    // Put it in the save pipeline.
    var userIdsDict = {};
    for (var i = 0; i < userIds.length; i++) {
      userIdsDict[userIds[i]] = true;
    };
    var count = this.saveQueue_.addJob({msg: msg, userIds: userIdsDict});
    if (count > 1)
      console.log('Save queue stalled; queue size is', count);

    // Now that we've queued it, tell everyone. The invariant is
    // that this appears /after/ it appears in a getMessage
    // call. We know how to query the queue, so this is safe.
    this.emit('message', msg, userIds);
  }.bind(this), function(err) {
    // Scream loudly on db failure, but don't crash.
    console.error("Skipping prepare!", err, msg);
  });
};

Subscriber.prototype.saveMessage_ = function(job) {
  // Save to the database.
  var userIds = Object.keys(job.userIds);
  return new sequtil.ExponentialBackoff(function() {
    return this.dbPool_.getConnection().then(function(conn) {
      return conn.saveMessage(job.msg, userIds).finally(conn.end.bind(conn));
    }.bind(this));
  }.bind(this), { description: 'save message'}).promise().then(null, function(err) {
    // Scream loudly on db failure, but don't crash.
    console.error("Skipping save!", err, job.msg, job.userIds);
  }.bind(this));
};

function copy(msg) {
  var newMsg = {};
  Object.keys(msg).forEach(function(key) {
    newMsg[key] = msg[key];
  });
  return newMsg;
}

var MAX_MESSAGES_RETURNED = 100;
Subscriber.prototype.getMessages = function(user, msgId, filter, opts) {
  // For sanity, pick a random limit.
  var reverse = opts.reverse;
  var limit = Math.min(opts.limit|0, MAX_MESSAGES_RETURNED);
  limit = Math.max(limit, 1);  // Avoid nonsense...

  // As a buffer against database stalls, we make messages available
  // as soon as they hit the save queue. Note: if this is ever
  // reverted, it the call to emit('message', ...) MUST be moved from
  // after enqueuing in the save to to after conn.saveMessage()
  // returns.

  return Q.fcall(function() {
    var jobs = this.saveQueue_.jobs();
    if (reverse) {
      var ret = [];
      // First, look through the queue.
      for (var i = jobs.length - 1; i >= 0; i--) {
        // Is the message too early?
        if (msgId != null && jobs[i].msg.id >= msgId)
          continue;
        // Can the user even see the message?
        if (!(user.id in jobs[i].userIds))
          continue;
        // Does it match the filter?
        if (!filter.matchesMessage(jobs[i].msg))
          continue;
        // Cool, include it. Make a copy because callers are currently
        // lame and seal ids destructively. Ugh.
        ret.push(copy(jobs[i].msg));
        // Are we done?
        if (ret.length >= limit)
          break;
      }

      // Avoid calling the database with limit 0. Messes up isDone
      // calculation.
      if (ret.length >= limit)
        return {messages: ret, isDone: false};

      // Now combine with database.
      var newMsgId = ret.length ? ret[ret.length - 1].id : msgId;
      return db.getMessages(user, newMsgId, filter, {
        limit: limit - ret.length,
        reverse: true
      }).then(function(result) {
        return {
          messages: ret.concat(result.messages),
          isDone: result.isDone
        };
      });
    } else {
      // Important: Clone the message list /first/. The queue may
      // change by the time the database query returns and we'll drop
      // some messages.
      jobs = jobs.slice(0);
      // This time, start with the database. We could optimize the
      // case where msgId appears in the buffer, but it's not really
      // worth it. This is a write buffer, not a cache.
      return db.getMessages(user, msgId, filter, {
        limit: limit,
        reverse: false
      }).then(function(result) {
        // Stop here.
        if (result.messages.length >= limit)
          return result;

        // Combine with the buffer:
        var newMsgId = (result.messages.length ?
                        result.messages[result.messages.length - 1].id :
                        msgId);
        for (var i = 0; i < jobs.length; i++) {
          // Is the message too early?
          if (newMsgId != null && jobs[i].msg.id <= newMsgId)
            continue;
          // Can the user even see the message?
          if (!(user.id in jobs[i].userIds))
            continue;
          // Does it match the filter?
          if (!filter.matchesMessage(jobs[i].msg))
            continue;
          // Cool, include it. Make a copy because callers are currently
          // lame and seal ids destructively. Ugh.
          result.messages.push(copy(jobs[i].msg));
          // Are we done?
          if (result.messages.length >= limit)
            break;
        }
        result.isDone = result.messages.length < limit;

        return result;
      });
    }
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
      if (i - (i%100) <
          (i + MAX_SUBSCRIBE_CHUNK) - ((i + MAX_SUBSCRIBE_CHUNK) % 100)) {
        console.log('Subscribed to %d of %d', i, subs.length);
      }
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
  queue.forEach(function(job) {
    // Throw away any that managed to get serialized but still into
    // the database. (If it COMMITed, but we missed the response.)
    if (job.msg.id >= this.nextMessageId_) {
      this.saveQueue_.addJob(job);
      this.nextMessageId_ = job.msg.id + 1;
    }
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
    return db.getNextMessageId();
  }.bind(this)).then(function(id) {
    this.nextMessageId_ = id;

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
                   JSON.stringify(this.saveQueue_.jobs()),
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
