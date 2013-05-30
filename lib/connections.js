var socketIo = require('socket.io');

var db = require('./db.js');
var keyedset = require('./keyedset.js');
var msgid = require('./msgid.js');

var HACK_USER = 1;

// TODO(davidben): Version the socket API.

function ConnectionManager(server, subscriber) {
  this.io_ = socketIo.listen(server);
  this.activeUsers_ = { };
  this.subscriber_ = subscriber;

  this.io_.sockets.on('connection', this.onSocket_.bind(this));
  this.subscriber_.on('message', this.onMessage_.bind(this));
}

ConnectionManager.prototype.onSocket_ = function(socket) {
  // FIXME: authentication!
  var user = HACK_USER;
  if (!this.activeUsers_[user])
    this.activeUsers_[user] = new ActiveUser(this, user);

  this.activeUsers_[user].addSocket(socket);
};

ConnectionManager.prototype.onMessage_ = function(msg, userIds) {
  // Only compute the sealed id once.
  var sealedId = msgid.seal(msg.id);
  // Deliver the message to anyone who might care.
  userIds.forEach(function(userId) {
    if (!this.activeUsers_[userId])
      return;
    this.activeUsers_[userId].onMessage(msg, sealedId);
  }.bind(this));
};

function ActiveUser(parent, userId) {
  this.parent_ = parent;
  this.userId_ = userId;

  this.ref_ = 0;
  this.sockets_ = { };
  this.activeTails_ = new keyedset.KeyedSet();
}

ActiveUser.prototype.addSocket = function(socket) {
  this.sockets_[socket.id] = socket;
  this.ref_++;

  // This stuff should possibly be enclosed in YET ANOTHER class
  // rather than a closure...
  var tails = {};

  socket.on('end', function() {
    // Shut off all the tails, so we stop sending messages through
    // them.
    for (var key in tails) {
      tails[key].close();
      delete tails[key];
    }

    delete this.sockets_[socket.id];
    // Bah.
    if (--this.ref_ <= 0)
      delete this.parent_.activeUsers_[this.userId_];
  }.bind(this));

  socket.on('new-tail', function(id, start, inclusive) {
    if (start != null) {
      start = msgid.unseal(String(start));
      if (inclusive)
        start--;
    } else {
      start = 0;
    }
    id = Number(id);

    if (tails[id]) {
      // Uh, you shouldn't reuse ids, but okay...
      tails[id].close();
    }
    tails[id] = new Tail(this, socket, id, start);
  }.bind(this));
  socket.on('extend-tail', function(id, count) {
    if (tails[id])
      tails[id].extend(count);
  }.bind(this));
  socket.on('close-tail', function(id) {
    if (tails[id]) {
      tails[id].close();
      delete tails[id];
    }
  }.bind(this));
};

ActiveUser.prototype.onMessage = function(msg, sealedId) {
  // Forward to each tail that is listening.
  this.activeTails_.forEach(function(tail) {
    tail.onMessage(msg, sealedId);
  });
};

function Tail(user, socket, id, lastSent) {
  // Possible states:
  //
  // - FULL-TAIL : |messagesWanted_| = 0, so there's no need to
  //   request new messages. |active_| and |messageBuffer_| should
  //   both be null. When |messagesWanted_| becomes non-zero, we fire
  //   a DB query and go into DB-WAIT.
  //
  // - DB-WAIT : |active_| is not null and |messageBuffer_| is not
  //   null. Whenever we are doing a DB query, we are also listening
  //   for live messages to do the handoff properly. They end up in
  //   |messageBuffer_|. When the DB query returns, we either go to
  //   FULL-TAIL, another instance of DB-WAIT (because the user raced
  //   with us in calling extend or we hit |db.getMessage|'s result
  //   size limit), or LIVE-STREAM
  //
  // - LIVE-STREAM : |active_| is not null and |messageBuffer_| is
  //   null. This means that our most recent DB query was done but
  //   there was still room in |messagesWanted_|. In that case, we
  //   switch to just forwarding messages straight from the
  //   subscriber. We stay in this state until |messagesWanted_| is 0
  //   and go into FULL-TAIL.

  this.user_ = user;
  this.socket_ = socket;
  this.id_ = id;

  this.active_ = null;
  this.messageBuffer_ = null;

  this.lastSent_ = lastSent;
  this.messagesSent_ = 0;
  this.messagesWanted_ = 0;
}

Tail.prototype.close = function() {
  this.socket_ = null;
};

Tail.prototype.extend = function(count) {
  this.messagesWanted_ = Math.max(count - this.messagesSent_,
                                  this.messagesWanted_);
  this.fireQuery_();
};

Tail.prototype.activate_ = function() {
  if (this.active_ == null) {
    this.active_ = this.user_.activeTails_.add(this);
  }
};

Tail.prototype.deactivate_ = function() {
  if (this.active_) {
    this.user_.activeTails_.removeKey(this.active_);
    this.active_ = null;
  }
};

Tail.prototype.fireQuery_ = function() {
  if (this.socket_ == null)
    return;

  // We're either in LIVE-STREAM or already in DB-WAIT. Do nothing.
  if (this.active_ != null)
    return;

  // We're in FULL-TAIL and should stay that way.
  if (this.messagesWanted_ == 0)
    return;

  // Activate live stream in buffer-messages mode.
  this.activate_();
  this.messageBuffer_ = [];
  // Make the DB query.
  db.getMessages(this.user_.userId_, this.lastSent_, {
    limit: this.messagesWanted_,
    reverse: false,
    inclusive: false
  }).then(function(result) {
    if (this.socket_ == null)
      return;

    // First, send the result along.
    if (result.messages.length) {
      var lastId = result.messages[result.messages.length - 1].id;
      result.messages.forEach(function(msg) {
        msg.id = msgid.seal(msg.id);
      });
      this.emitMessages_(result.messages, result.isDone);
      this.lastSent_ = lastId;
    } else {
      this.emitMessages_([], result.isDone);
    }

    // This was (at query time) the end of the database. Now we
    // transition to LIVE-STREAM mode.
    if (result.isDone && this.messagesWanted_) {
      var messageBuffer = this.messageBuffer_;
      this.messageBuffer_ = null;

      // But first, to make the hand-off atomic, we send what messages
      // in the buffer weren't seen yet.
      var start;
      for (start = 0; start < messageBuffer.length; start++) {
        if (messageBuffer[start][0].id > this.lastSent_)
          break;
      }
      messageBuffer = messageBuffer.slice(start);
      if (messageBuffer.length > 0) {
        var sealedMsgs = messageBuffer.map(function(entry) {
          var msg = entry[0], sealedId = entry[1];
          var sealedMsg = { };
          for (var key in msg) {
            sealedMsg[key] = msg[key];
          }
          sealedMsg.id = sealedId;
          return sealedMsg;
        });
        this.emitMessages_(sealedMsgs, true);
        this.lastSent_ = messageBuffer[messageBuffer.length - 1][0].id;
      }
    } else {
      // Otherwise... we deactivate everything and check if we need to
      // fire a query again.
      this.messageBuffer_ = null;
      this.deactivate_();
      this.fireQuery_();
    }
  }.bind(this)).done();
  // TODO(davidben): Error handling!
};

Tail.prototype.onMessage = function(msg, sealedId) {
  if (!this.socket_)
    return;

  if (this.messageBuffer_) {
    this.messageBuffer_.push([msg, sealedId]);
    return;
  }
  // We're active and not in message buffering mode. Forward them
  // through the socket. isDone is true since the tail is caught up.
  var sealedMsg = { };
  for (var key in msg) {
    sealedMsg[key] = msg[key];
  }
  sealedMsg.id = sealedId;

  this.emitMessages_([sealedMsg], true);
  this.lastSent_ = msg.id;
  // Transition out of LIVE-STREAM mode if needbe.
  if (this.messagesWanted_ <= 0) {
    this.deactivate_();
  }
};

Tail.prototype.emitMessages_ = function(msgs, isDone) {
  this.socket_.emit('messages', this.id_, msgs, isDone);
  this.messagesSent_ += msgs.length;
  this.messagesWanted_ -= msgs.length;
};

exports.listen = function(server, messageQueue) {
  return new ConnectionManager(server, messageQueue);
};