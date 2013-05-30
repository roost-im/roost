var socketIo = require('socket.io');

var HACK_USER = 1;

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
  if (!this.activeUsers_[user]) {
    this.activeUsers_[user] = {
      ref: 0,
      sockets: { }
    };
  }
  this.activeUsers_[user].sockets[socket.id] = socket;
  this.activeUsers_[user].ref++;
  socket.on('end', function() {
      delete this.activeUsers_[user].sockets[socket.id];
    if (--this.activeUsers_[user].ref <= 0)
      delete this.activeUsers_[user];
  }.bind(this));
};

ConnectionManager.prototype.onMessage_ = function(msg, userIds) {
  // Deliver the message to anyone who might care.
  userIds.forEach(function(userId) {
    if (!this.activeUsers_[userId])
      return;
    var sockets = this.activeUsers_[userId].sockets;
    for (var key in this.activeUsers_[userId].sockets) {
      sockets[key].emit('message', msg);
    }
  }.bind(this));
};

exports.listen = function(server, messageQueue) {
  return new ConnectionManager(server, messageQueue);
};