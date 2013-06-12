"use strict";

function mockMessageId(idx) {
  return btoa(String(idx));
}
function resolveMockId(ref, offset) {
  return Number(atob(ref));
}

function MockMessageModel(count) {
  this.count_ = count;
  this.listeners_ = [];
  this.interval_ = window.setInterval(function() {
    this.count_ += 1;
    var listeners = this.listeners_;
    this.listeners_ = [];
    listeners.forEach(function(tail) {
      tail.wakeUp_();
    })
  }.bind(this), 1000);
}
MockMessageModel.prototype.getMessage_ = function(number) {
  if (number < 0 || number >= this.count_)
    throw "Bad message number";

  var idx = number % SAMPLE_MSGS.length;
  if (idx < 0)
    idx += SAMPLE_MSGS.length;

  var msg = { };
  for (var key in SAMPLE_MSGS[idx]) {
    msg[key] = SAMPLE_MSGS[idx][key];
  }
  msg.number = number;
  msg.id = mockMessageId(number);
  return msg;
};
// If start is null, we treat it as starting from the end. If in
// reverse, it means from the bottom. If forwards, from the
// top. FIXME: the semantics of this with inclusive are weeeird.
//
// TODO(davidben): Just make the API take the options dict along with
// an initial count parameter?
MockMessageModel.prototype.newTailInclusive = function(start, cb) {
  start = resolveMockId(start);
  if (start < 0 || start >= this.count_)
    throw "Bad message id";
  return new MockMessageTail(this, start, cb, {
    inclusive: true
  });
};
MockMessageModel.prototype.newTail = function(start, cb) {
  var inclusive = false;
  if (start == null) {
    start = 0;
    inclusive = true;
  } else {
    start = resolveMockId(start);
    if (start < 0 || start >= this.count_)
      throw "Bad message id";
  }
  return new MockMessageTail(this, start, cb, {
    inclusive: inclusive
  });
};
MockMessageModel.prototype.newReverseTail = function(start, cb) {
  var inclusive = false;
  if (start == null) {
    start = this.count_ - 1;
    inclusive = true;
  } else {
    start = resolveMockId(start);
    if (start < 0 || start >= this.count_)
      throw "Bad message id";
  }
  return new MockMessageTail(this, start, cb, {
    inclusive: inclusive,
    reverse: true
  });
};
MockMessageModel.prototype.compareMessages = function(a, b) {
  return a.number - b.number;
};

function MockMessageTail(model, start, cb, opts) {
  this.model_ = model;
  this.start_ = start;
  this.reverse_ = opts.reverse;
  this.cb_ = cb;

  // Simulate doing only one XHR at a time.
  this.requestPending_ = false;
  this.lastRequested_ = opts.inclusive ? -1 : 0;
  this.count_ = this.lastRequested_;
  this.atEnd_ = false;
}
MockMessageTail.prototype.expandTo = function(count) {
  this.count_ = Math.max(this.count_, count);
  this.fireRequest_();
};
MockMessageTail.prototype.close = function() {
  this.cb_ = null;
};
MockMessageTail.prototype.wakeUp_ = function() {
  this.atEnd_ = false;
  this.fireRequest_(true);
};
MockMessageTail.prototype.fireRequest_ = function(immediate) {
  if (this.requestPending_)
    return;
  if (this.lastRequested_ >= this.count_)
    return;
  if (this.atEnd_)
    return;

  this.requestPending_ = true;

  window.setTimeout(function() {
    var requestStart, requestEnd;
    if (this.reverse_) {
      requestStart = Math.max(0, this.start_ - this.count_);
      requestEnd = this.start_ - this.lastRequested_;
      this.lastRequested_ = this.start_ - requestStart;
    } else {
      requestStart = this.start_ + this.lastRequested_ + 1;
      requestEnd = Math.min(this.start_ + this.count_ + 1, this.model_.count_);
      this.lastRequested_ = requestEnd - this.start_ - 1;
    }

    // Fake some messages.
    var msgs = [];
    for (var i = requestStart; i < requestEnd; i++) {
      msgs.push(this.model_.getMessage_(i));
    }
    this.atEnd_ = this.reverse_ ?
      (requestStart == 0) :
      (requestEnd == this.model_.count_);
    if (this.cb_) {
      this.cb_(msgs, this.atEnd_);
      if (this.atEnd_ && !this.reverse_)
        this.model_.listeners_.push(this);
    }

    this.requestPending_ = false;
    this.fireRequest_();
  }.bind(this), immediate ? 0 : 500);
};

var api, model, messageView, selectionTracker;  // For debugging.
$(function() {
  api = new API(location.protocol + "//" + location.host);
  model = new MessageModel(api);
  messageView = new MessageView(model, document.getElementById("messagelist"));
  selectionTracker = new SelectionTracker(messageView);
  document.getElementById("messagelist").focus();

  if (/#msg-/.test(location.hash)) {
    var msgId = location.hash.substring(5);
    messageView.scrollToMessage(msgId);
    selectionTracker.selectMessage(msgId);
  } else {
    messageView.scrollToBottom();
  }

  window.addEventListener("hashchange", function(ev) {
    if (/#msg-/.test(location.hash)) {
      var msgId = location.hash.substring(5);
      messageView.scrollToMessage(msgId);
      selectionTracker.selectMessage(msgId);
    }
  });
});
