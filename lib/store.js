var events = require('events');
var Q = require('q');
var util = require('util');

var sequtil = require('./sequtil.js');

function MessageStore(db) {
  events.EventEmitter.call(this);
  this.db_ = db;

  // Dedicated database pool for writes, so queries can't starve us
  // out.
  this.dbPool_ = this.db_.createPool();

  // The next message id.
  this.nextMessageId_ = null;

  // Queues to ensure we process messages serially.
  this.prepareQueue_ = new sequtil.JobQueue(this.prepareMessage_.bind(this));
  this.saveQueue_ = new sequtil.JobQueue(this.saveMessage_.bind(this));
};
util.inherits(MessageStore, events.EventEmitter);

MessageStore.prototype.start = function() {
  return this.db_.getNextMessageId().then(function(id) {
    this.nextMessageId_ = id;
  }.bind(this));
};

MessageStore.prototype.saveQueue = function() {
  return this.saveQueue_.jobs();
};

MessageStore.prototype.restoreSaveQueue = function(queue) {
  if (this.saveQueue_.jobs().length)
    throw "Save queue already started!";
  queue.forEach(function(job) {
    // Throw away any that managed to get serialized but still into
    // the database. (If it COMMITed, but we missed the response.)
    if (job.msg.id >= this.nextMessageId_) {
      this.saveQueue_.addJob(job);
      this.nextMessageId_ = job.msg.id + 1;
    }
  }.bind(this));
};

MessageStore.prototype.addMessage = function(msg) {
  // Assign an id and receiveTime.
  msg.id = this.nextMessageId_++;
  msg.receiveTime = new Date().getTime();
  var count = this.prepareQueue_.addJob(msg);
  if (count > 1)
    console.log('Prepare queue stalled; queue size is', count);
};

MessageStore.prototype.prepareMessage_ = function(msg) {
  return new sequtil.ExponentialBackoff(function() {
    return this.dbPool_.getConnection().then(function(conn) {
      return conn.getUsersForMessage(msg).finally(conn.release.bind(conn));
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

MessageStore.prototype.saveMessage_ = function(job) {
  // Save to the database.
  var userIds = Object.keys(job.userIds);
  return new sequtil.ExponentialBackoff(function() {
    return this.dbPool_.getConnection().then(function(conn) {
      return conn.saveMessage(job.msg, userIds).finally(conn.release.bind(conn));
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
MessageStore.prototype.getMessages = function(user, msgId, filter, opts) {
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
      return this.db_.getMessages(user, newMsgId, filter, {
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
      return this.db_.getMessages(user, msgId, filter, {
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

exports.MessageStore = MessageStore;
