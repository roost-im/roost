"use strict";

function MessageModel(api) {
  this.api_ = api;
}
MessageModel.prototype.newTailInclusive = function(start, cb) {
  return new MessageTail(this, start, true, cb);
};
MessageModel.prototype.newTail = function(start, cb) {
  return new MessageTail(this, start, false, cb);
};
MessageModel.prototype.newReverseTail = function(start, cb) {
  return new MessageReverseTail(this, start, cb);
};
// This function is NOT meant to be that authoritative. It's just
// because some places in the message view would find it handle to be
// able to compare messages to each other and opaque message ids as a
// data model make this difficult.
MessageModel.prototype.compareMessages = function(a, b) {
  return a.receiveTime - b.receiveTime;
};

function MessageTail(model, start, inclusive, cb) {
  this.model_ = model;
  // The last thing we sent.
  this.lastSent_ = start;
  // Whether the request is inclusive.
  this.inclusive_ = inclusive;
  // The number of messages sent total.
  this.messagesSentTotal_ = 0;
  // The number of messages sent since the last new-tail.
  this.messagesSentRecent_ = 0;
  // The number of messages we want ahead of lastSent_.
  this.messagesWanted_ = 0;
  // Callback. null on close.
  this.cb_ = cb;
  // The ID of the tail.
  this.tailId_ = null;
  // The value of the most recent extend-tail message.
  this.lastExtend_ = -1;

  // Hold onto these so we can unregister them.
  this.connectedCb_ = this.onConnect_.bind(this);
  this.disconnectCb_ = this.onDisconnect_.bind(this);
  this.messagesCb_ = this.onMessages_.bind(this);
  this.model_.api_.on("connect", this.connectedCb_);

  this.onConnect_();
}
MessageTail.prototype.onConnect_ = function() {
  // Unregister our old handlers.
  this.onDisconnect_();
  this.socket_ = this.model_.api_.socket();
  if (this.socket_) {
    this.socket_.on("messages", this.messagesCb_);
    this.socket_.on("disconnect", this.disconnectCb_);
    // Reset everything.
    this.createTail_();
    this.expandTo(0);
  }
};
MessageTail.prototype.onDisconnect_ = function() {
  if (this.socket_) {
    this.socket_.removeListener("messages", this.messagesCb_);
    this.socket_.removeListener("disconnect", this.disconnectCb_);
    this.socket_ = null;
  }
};
MessageTail.prototype.expandTo = function(count) {
  this.messagesWanted_ = Math.max(this.messagesWanted_,
                                  count - this.messagesSentTotal_);
  var newExtend = this.messagesWanted_ + this.messagesSentRecent_;
  if (this.socket_ && this.lastExtend_ < newExtend) {
    this.socket_.emit("extend-tail", this.tailId_, newExtend);
    this.lastExtend_ = newExtend;
  }
};
MessageTail.prototype.close = function() {
  if (this.socket_)
    this.socket_.emit("close-tail", this.tailId_);
  this.onDisconnect_();
  this.model_.api_.removeListener("connect", this.connectedCb_);
  this.cb_ = null;
};
MessageTail.prototype.createTail_ = function() {
  if (this.socket_) {
    this.tailId_ = this.model_.api_.allocateTailId();
    this.messagesSentRecent_ = 0;  // New tail, so we reset offset.
    this.lastExtend_ = -1;  // Also reset what we've requested.
    this.socket_.emit("new-tail",
                      this.tailId_, this.lastSent_, this.inclusive_);
  }
};
MessageTail.prototype.onMessages_ = function(id, msgs, isDone) {
  if (id != this.tailId_)
    return;
  if (msgs.length) {
    this.lastSent_ = msgs[msgs.length - 1].id;
    this.inclusive_ = false;
    this.messagesSentTotal_ += msgs.length;
    this.messagesSentRecent_ += msgs.length;
    this.messagesWanted -= msgs.length;
  }
  if (this.cb_)
    this.cb_(msgs, isDone);
};

function MessageReverseTail(model, start, cb) {
  this.model_ = model;
  this.start_ = start;
  this.messagesSent_ = 0;
  this.messagesWanted_ = 0;
  this.cb_ = cb;
  this.pending_ = false;
  // Exponential back-off thing on error.
  this.throttleTimer_ = null;
  this.throttle_ = 500;

  this.reconnectCb_ = this.onReconnect_.bind(this);
  this.model_.api_.on("connect", this.reconnectCb_);
}
MessageReverseTail.prototype.expandTo = function(count) {
  this.messagesWanted_ = Math.max(this.messagesWanted_,
                                  count - this.messagesSent_);
  this.fireRequest_();
};
MessageReverseTail.prototype.close = function() {
  this.cb_ = null;
  this.model_.api_.removeListener("connect", this.reconnectCb_);
};
MessageReverseTail.prototype.fireRequest_ = function() {
  if (this.pending_ || this.throttleTimer_ ||
      !this.cb_ || this.messagesWanted_ == 0)
    return;
  var params = {
    reverse: "1",
    count: String(this.messagesWanted_)
  }
  if (this.start_ != null)
    params.offset = this.start_;
  // TODO(davidben): Report errors back up somewhere?
  this.pending_ = true;
  this.model_.api_.get("/api/v1/messages", params).then(function(resp) {
    // Bleh. The widget code wants the messages in reverse order.
    resp.messages.reverse();

    if (this.cb_)
      this.cb_(resp.messages, resp.isDone);

    // Update fields (specifically |pending_|) AFTER the callback to
    // ensure they don't fire a new request; we might know there's no
    // use in continuing.
    if (resp.messages.length)
      this.start_ = resp.messages[0].id;
    this.messagesSent_ += resp.messages.length;
    this.messagesWanted_ -= resp.messages.length;

    this.pending_ = false;
    this.throttle_ = 500;

    // We're done. Shut everything off.
    if (resp.isDone) {
      this.close();
    } else {
      // Keep going if needbe.
      this.fireRequest_();
    }
  }.bind(this), function(err) {
    this.pending_ = false;

    // If we get an error, do an exponential backoff.
    var timer = { disabled: false };
    window.setTimeout(function() {
      if (timer.disabled)
        return;
      this.throttleTimer_ = null;
      this.fireRequest_();
    }.bind(this), this.throttle_);
    this.throttleTimer_ = timer;
    this.throttle_ *= 2;

    // Don't lose the error.
    throw err;
  }.bind(this)).done();
};
MessageReverseTail.prototype.onReconnect_ = function() {
  // We don't use the socket, but if we get a reconnect, take that as
  // a sign that we've got connectivity again.
  if (this.throttleTimer_) {
    this.throttleTimer_.disabled = true;
    this.throttleTimer_ = null
  }
  this.throttle_ = 500;
  this.fireRequest_();
};