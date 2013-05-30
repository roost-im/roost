var events = require('events');
var Q = require('q');
var util = require('util');
var zephyr = require('zephyr');

var db = require('./db.js');
var queue = require('./queue.js');
var zuser = require('./zuser.js');

function Subscriber() {
  events.EventEmitter.call(this);

  // Dedicated database connection, so queries don't starve us out.
  this.dbConnection_ = db.createConnection();
  // A queue to ensure we process messages serially.
  this.queue_ = new queue.JobQueue(this.processMessage_.bind(this));

  // Listen for notices.
  zephyr.on('notice', this.onNotice_.bind(this));
}
util.inherits(Subscriber, events.EventEmitter);

Subscriber.prototype.onNotice_ = function(notice) {
  // Skip the random ACKs.
  if (notice.kind == zephyr.HMACK ||
      notice.kind == zephyr.SERVACK ||
      notice.kind == zephyr.SERVNAK) {
    return;
  }

  var msg = {
    time: notice.time.getTime(),
    receiveTime: (new Date()).getTime(),
    class: notice.class,
    instance: notice.instance,
    sender: notice.sender,
    recipient: notice.recipient,
    realm: zuser.realm(notice.recipient),
    auth: notice.checkedAuth,
    opcode: notice.opcode
  };
  // TODO(davidben): Pull in the full logic from BarnOwl's
  // owl_zephyr_get_message? It checks on default formats and the
  // like.
  //
  // How much of this processing should be server-side and how much
  // client-side? If we want to be able to search on the body, that
  // suggests it should be in the server.
  if (notice.body.length > 1) {
    msg.signature = notice.body[0];
    msg.message = notice.body[1];
  } else {
    msg.signature = '';
    msg.message = notice.body[0] || '';
  }

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

// Sort of odd to have this guy wrap all the zephyr functions, but oh
// well. The idea is that is the only guy that actually has to be a
// singleton. The rest can all be split over multiple machines
// assuming we can proxy over the 'message' events.

Subscriber.prototype.start = function() {
  zephyr.openPort();

  return db.loadActiveSubs().then(function(subs) {
    subs = subs.map(function(sub) {
      if (sub[1] === null)
        return [sub[0], '*', sub[2]];
      return sub;
    });
    console.log('Subscribing to %d triples', subs.length);
    return this.subscribeTo(subs);
  }.bind(this));
};

Subscriber.prototype.subscribeTo = function(subs) {
  return Q.nfcall(zephyr.subscribeTo, subs);
};

Subscriber.prototype.shutdown = function() {
  return Q.nfcall(zephyr.cancelSubscriptions);
};

exports.Subscriber = Subscriber;