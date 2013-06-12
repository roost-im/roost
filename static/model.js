"use strict";

function MessageModel(apiRoot, socket) {
  this.socket_ = socket;
  this.apiRoot_ = apiRoot;
}
MessageModel.prototype.socket = function() {
  return this.socket_;
};
MessageModel.prototype.apiRequest = function(method, path, data) {
  var url = this.apiRoot_ + path;
  var xhr = new XMLHttpRequest();
  if ("withCredentials" in xhr) {
    // XHR for Chrome/Firefox/Opera/Safari.
    xhr.open(method, url, true);
  } else if (typeof XDomainRequest != "undefined") {
    // XDomainRequest for IE.
    xhr = new XDomainRequest();
    xhr.open(method, url);
  } else {
    return Q.reject("CORS not supported.");
  }

  var deferred = Q.defer();
  xhr.onload = function() {
    if (this.status == 200) {
      deferred.resolve(JSON.parse(xhr.responseText));
    } else {
      deferred.reject(this.statusText);
    }
  };
  xhr.onerror = function() {
    deferred.reject("Request failed");
  };

  if (data !== undefined) {
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(JSON.stringify(data));
  } else {
    xhr.send();
  }
  return deferred.promise;
};
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

// TODO(davidben): This really really should be state that's attached
// to the socket. Wrap io.socket's objects in some wrapper that
// maintains a |nextTailId_| property.
var nextTailId = 1;

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

  // Hold onto this so we can unregister it.
  this.messagesCb_ = this.onMessages_.bind(this);
  this.model_.socket().on("messages", this.messagesCb_);
  this.reconnectCb_ = this.onReconnect_.bind(this);
  this.model_.socket().on("reconnect", this.reconnectCb_);

  this.createTail_();
}
MessageTail.prototype.expandTo = function(count) {
  this.messagesWanted_ = Math.max(this.messagesWanted_,
                                  count - this.messagesSentTotal_);
  var newExtend = this.messagesWanted_ + this.messagesSentRecent_;
  if (this.lastExtend_ < newExtend) {
    this.model_.socket().emit("extend-tail", this.tailId_, newExtend);
    this.lastExtend_ = newExtend;
  }
};
MessageTail.prototype.close = function() {
  this.cb_ = null;
  this.model_.socket().removeListener("messages", this.messagesCb_);
  this.model_.socket().removeListener("reconnect", this.reconnectCb_);
  this.model_.socket().emit("close-tail", this.tailId_);
};
MessageTail.prototype.createTail_ = function() {
  this.tailId_ = nextTailId++;
  this.messagesSentRecent_ = 0;  // New tail, so we reset offset.
  this.lastExtend_ = -1;  // Also reset what we've requested.
  this.model_.socket().emit("new-tail",
                            this.tailId_, this.lastSent_, this.inclusive_);
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
MessageTail.prototype.onReconnect_ = function() {
  // Reset everything.
  this.createTail_();
  this.expandTo(0);
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
  this.model_.socket().on("reconnect", this.reconnectCb_);
}
MessageReverseTail.prototype.expandTo = function(count) {
  this.messagesWanted_ = Math.max(this.messagesWanted_,
                                  count - this.messagesSent_);
  this.fireRequest_();
};
MessageReverseTail.prototype.close = function() {
  this.cb_ = null;
  this.model_.socket().removeListener("reconnect", this.reconnectCb_);
};
MessageReverseTail.prototype.fireRequest_ = function() {
  if (this.pending_ || this.throttleTimer_ ||
      !this.cb_ || this.messagesWanted_ == 0)
    return;
  var path = "/messages?reverse=1";
  if (this.start_ != null)
    path += "&offset=" + encodeURIComponent(this.start_);
  path += "&count=" + String(this.messagesWanted_);
  
  // TODO(davidben): Report errors back up somewhere?
  this.pending_ = true;
  this.model_.apiRequest("GET", path).then(function(resp) {
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