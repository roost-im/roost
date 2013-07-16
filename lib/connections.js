var events = require('events');
var Q = require('q');
var util = require('util');
var sockjs = require('sockjs');

var auth = require('./auth.js');
var conf = require('./config.js');
var db = require('./db.js');
var error = require('./error.js');
var keyedset = require('./keyedset.js');
var msgid = require('./msgid.js');

// Thin wrapper over a SockJS's connection to parse things out as JSON
// and abort on error.
function Connection(conn) {
  events.EventEmitter.call(this);

  this.conn_ = conn;
  this.conn_.on('close', function() {
    this.emit('close');
  }.bind(this));
  this.conn_.on('data', function(data) {
    try {
      var message = JSON.parse(data);
    } catch (err) {
      this.conn_.close(4000, 'Bad message format');
      return;
    }
    this.emit('message', message);
  }.bind(this));
};
util.inherits(Connection, events.EventEmitter);
Connection.prototype.sockjs = function() {
  // Bah. Too lazy to expose all the properties.
  return this.conn_;
};
Connection.prototype.close = function(code, reason) {
  this.conn_.close(code, reason);
};
Connection.prototype.send = function(message) {
  this.conn_.write(JSON.stringify(message));
};

// TODO(davidben): Version the socket API.

function ConnectionManager(server, subscriber) {
  this.sockServer_ = sockjs.createServer({
    sockjs_url: '/sockjs.min.js'
  });
  this.activeUsers_ = { };
  this.subscriber_ = subscriber;

  this.sockServer_.installHandlers(server, { prefix: '/v1/socket' });

  this.sockServer_.on('connection', this.onConnection_.bind(this));
  this.subscriber_.on('message', this.onMessage_.bind(this));
}

ConnectionManager.prototype.onConnection_ = function(conn) {
  conn = new Connection(conn);
  conn.once('message', function(msg) {
    if (msg.type !== 'auth') {
      conn.close(4001, 'Auth message expected');
      return;
    }
    var token = msg.token;
    if (typeof token !== 'string') {
      conn.close(4002, 'Bad auth token');
      return;
    }
    auth.checkAuthToken(token).then(function(user) {
      if (!this.activeUsers_[user.id])
        this.activeUsers_[user.id] = new ActiveUser(this, user);

      this.activeUsers_[user.id].addSocket(conn);
      conn.send({type: 'ready'});
    }.bind(this), function(err) {
      if (err instanceof error.UserError) {
        conn.close(4003, err.msg);
      } else {
        conn.close(4004, 'Internal error');
      }
    }.bind(this)).done();
  }.bind(this));
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

function ActiveUser(parent, user) {
  this.parent_ = parent;
  this.user_ = user;

  this.ref_ = 0;
  this.activeTails_ = new keyedset.KeyedSet();
}

ActiveUser.prototype.addSocket = function(socket) {
  this.ref_++;

  // This stuff should possibly be enclosed in YET ANOTHER class
  // rather than a closure...
  var tails = {};

  socket.on('close', function() {
    // Shut off all the tails, so we stop sending messages through
    // them.
    for (var key in tails) {
      tails[key].close();
      delete tails[key];
    }

    // Bah.
    if (--this.ref_ <= 0)
      delete this.parent_.activeUsers_[this.user_.id];
  }.bind(this));

  socket.on('message', function(msg) {
    if (msg.type === 'ping') {
      socket.send({type: 'pong'});
    } else if (msg.type === 'new-tail') {
      var id = msg.id, start = msg.start, inclusive = msg.inclusive;
      if (typeof id !== 'number' ||
          (start != null && typeof start !== 'string')) {
        socket.close(4005, 'Bad message');
        return;
      }

      if (start != null) {
        start = msgid.unseal(start);
        if (inclusive)
          start--;
      } else {
        start = 0;
      }

      if (tails[id]) {
        // Uh, you shouldn't reuse ids, but okay...
        tails[id].close();
      }
      tails[id] = new Tail(this, socket, id, start);
    } else if (msg.type === 'extend-tail') {
      var id = msg.id, count = msg.count;
      if (typeof id !== 'number' || typeof count !== 'number') {
        socket.close(4005, 'Bad message');
        return;
      }

      if (tails[id])
        tails[id].extend(count);
    } else if (msg.type === 'close-tail') {
      var id = msg.id;
      if (typeof id !== 'number') {
        socket.close(4005, 'Bad message');
        return;
      }

      if (tails[id]) {
        tails[id].close();
        delete tails[id];
      }
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
  this.deactivate_();
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
  db.getMessages(this.user_.user_, this.lastSent_, {
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
  this.socket_.send({
    type: 'messages',
    id: this.id_,
    messages: msgs,
    isDone: isDone
  });
  this.messagesSent_ += msgs.length;
  this.messagesWanted_ -= msgs.length;
};

exports.listen = function(server, messageQueue) {
  return new ConnectionManager(server, messageQueue);
};