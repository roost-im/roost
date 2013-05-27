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
  }
  if (start < 0 || start >= this.count_)
    throw "Bad message id";
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
  }
  if (start < 0 || start >= this.count_)
    throw "Bad message id";
  return new MockMessageTail(this, start, cb, {
    inclusive: inclusive,
    reverse: true
  });
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

// If the number of messages outside the scroll goes outside
// [MIN_BUFFER, MAX_BUFFER], request/retire messages to reach
// TARGET_BUFFER. That there is a buffer between TARGET_BUFFER and our
// endpoints ensures that spurious scrolling will not repeatedly
// request and retire the same message. Also that we do our requests
// in large-ish batches.
var MIN_BUFFER = 50;
var TARGET_BUFFER = MIN_BUFFER * 2;
var MAX_BUFFER = MIN_BUFFER * 3;

function MessageView(model, container) {
  this.model_ = model;
  this.container_ = container;
  // Make this element focusable. This is needed so that you can
  // direct pageup/down and friends to it. Clicking in it mostly works
  // but we cannot control that programmatically. Moreover, it exposes
  // a quirk in WebKit and Blink; they track the most recently clicked
  // DOM node and use it to determine scroll when there is no focus
  // node. This breaks when we delete that node.
  this.container_.tabIndex = 0;

  this.loadingAbove_ = document.createElement("div");
  this.loadingAbove_.className = "msgview-loading";
  this.loadingAbove_.textContent = "Loading...";

  this.loadingBelow_ = document.createElement("div");
  this.loadingBelow_.className = "msgview-loading";
  this.loadingBelow_.textContent = "Loading...";

  this.bottomSpacer_ = document.createElement("div");
  this.bottomSpacer_.className = "msgview-bottom-spacer";

  this.messagesDiv_ = document.createElement("div");

  this.container_.appendChild(this.loadingAbove_);
  this.container_.appendChild(this.messagesDiv_);
  this.container_.appendChild(this.loadingBelow_);
  this.container_.appendChild(this.bottomSpacer_);

  this.tailBelow_ = null;
  this.tailBelowOffset_ = 0;  // The global index of the tail reference.

  this.tailAbove_ = null;
  this.tailAboveOffset_ = 0;  // The global index of the tail reference.

  this.reset_();

  this.container_.addEventListener("scroll", this.checkBuffers_.bind(this));
  this.container_.addEventListener("keydown", this.onKeydown_.bind(this));
}

MessageView.prototype.reset_ = function() {
  // It's not visible. Blow everything away and start from
  // there. (This is mildly annoying. Can we refactor some of this
  // code to not need this?)
  if (this.tailAbove_) {
    this.tailAbove_.close();
    this.tailAbove_ = null;
  }
  if (this.tailBelow_) {
    this.tailBelow_.close();
    this.tailBelow_ = null;
  }

  this.listOffset_ = 0;  // The global index to the top of the list.
  this.messages_ = [];
  this.nodes_ = [];

  this.messageToIndex_ = {};  // Map id to global index.

  this.messagesDiv_.textContent = "";

  // FIXME: This shows two loading bars. But we can't actually lie
  // about one side because atTop_ and atBottom_ are needed to
  // implement home/end behavior.
  this.setAtTop_(false);
  this.setAtBottom_(false);
};

MessageView.prototype.scrollToMessage = function(id) {
  if (id in this.messageToIndex_) {
    // Easy case: if the message is in our current view, we just jump
    // to it.
    this.nodes_[this.messageToIndex_[id] - this.listOffset_].scrollIntoView();
    return;
  }

  // Otherwise, we reset the universe and use |id| as our new point of
  // reference.
  this.reset_();

  this.tailBelow_ = this.model_.newTailInclusive(
    id, this.appendMessages_.bind(this));
  this.tailBelowOffset_ = 0;

  this.tailAbove_ = this.model_.newReverseTail(
    id, this.prependMessages_.bind(this));
  this.tailAboveOffset_ = 0;  // The global index of the tail reference.

  this.checkBuffers_();
};

MessageView.prototype.scrollToTop = function(id) {
  if (this.atTop_) {
    // Easy case: if the top is buffered, go there.
    this.container_.scrollTop = 0;
    return;
  }

  // Otherwise, we reset the universe and use |id| as our new point of
  // reference.
  this.reset_();
  // Blegh. Cut out the "Loading..." text now.
  this.setAtTop_(true);
  this.setAtBottom_(false);

  this.tailBelow_ = this.model_.newTail(null, this.appendMessages_.bind(this));
  this.tailBelowOffset_ = 0;

  this.checkBuffers_();
};

MessageView.prototype.scrollToBottom = function(id) {
  if (this.atBottom_) {
    // Easy case: if the bottom is buffered, go there.
    this.container_.scrollTop = this.container_.scrollHeight;
    return;
  }

  // Otherwise, we reset the universe and use |id| as our new point of
  // reference.
  this.reset_();
  // Blegh. Cut out the "Loading..." text now.
  this.setAtTop_(false);
  this.setAtBottom_(true);

  // We create one tail and lazily create the other one when we have a
  // reference point.
  //
  // FIXME! This... works. But it's sort of odd. Also, it breaks
  // horribly when you have zero messages. Also, note all the random
  // comments you had to add to support this.
  this.tailAbove_ = this.model_.newReverseTail(
    null, this.prependMessages_.bind(this));
  this.tailAboveOffset_ = 0;

  this.checkBuffers_();
};

MessageView.prototype.setAtTop_ = function(atTop) {
  this.atTop_ = atTop;
  this.loadingAbove_.style.display = atTop ? "none" : "block";
};

MessageView.prototype.setAtBottom_ = function(atBottom) {
  this.atBottom_ = atBottom;
  this.loadingBelow_.style.display = atBottom ? "none" : "block";
  this.bottomSpacer_.style.display = atBottom ? "block" : "none";
};

MessageView.prototype.appendMessages_ = function(msgs, isDone) {
  for (var i = 0; i < msgs.length; i++) {
    this.messageToIndex_[msgs[i].id] =
      this.messages_.length + this.listOffset_;

    var node = this.formatMessage_(msgs[i]);
    this.nodes_.push(node);
    this.messages_.push(msgs[i]);

    this.messagesDiv_.appendChild(node);
  }
  this.setAtBottom_(isDone);
  // XXX: If some assumptions change, trigger a checkBuffers_ call
  // here. When jumping to top/bottom, we delay creating one tail
  // until the other side has given us a reference for it. That should
  // mean that append/prepend messages should pump checkBuffers_. But
  // prependMessages already does this since it needs to
  // scroll. appendMessages should do this, but it only happens when
  // scrolling up and there aren't any messages before the first
  // one. This system doesn't actually know that, so the tail is
  // needed to kill the "Loading..." text. However, we kill those
  // ahead of them anyway since we know what the answers are.
};

MessageView.prototype.prependMessages_ = function(msgs, isDone) {
  // TODO(davidben): This triggers layout a bunch. Optimize this if needbe.
  var nodes = [];
  var insertReference = this.messagesDiv_.firstChild;
  var oldHeight = this.container_.scrollHeight;
  for (var i = 0; i < msgs.length; i++) {
    this.messageToIndex_[msgs[i].id] =
      this.listOffset_ - msgs.length + i;

    var node = this.formatMessage_(msgs[i]);
    nodes.push(node);

    this.messagesDiv_.insertBefore(node, insertReference);
  }
  this.container_.scrollTop += (this.container_.scrollHeight - oldHeight);

  this.messages_.unshift.apply(this.messages_, msgs);
  this.nodes_.unshift.apply(this.nodes_, nodes);
  this.listOffset_ -= msgs.length;

  this.setAtTop_(isDone);
};

var COLORS = ["black", "silver", "gray", "white", "maroon", "red",
              "purple", "fuchsia", "green", "lime"];
MessageView.prototype.formatMessage_ = function(msg) {
  var pre = document.createElement("pre");
  var indented = "   " +
    msg.message.replace(/\s+$/, '').split("\n").join("\n   ");
  pre.textContent =
    msg.number + ": " +
    msg.class + " / " + msg.instance + " / " + msg.sender + "  " +
      new Date(msg.time).toString() + "\n" +
    indented;
  pre.className = "message";
  pre.style.color = COLORS[((msg.number % COLORS.length) + COLORS.length) % COLORS.length];
  return pre;
};

// Return 1 if we need to expand below, -1 if we need to contract, and
// 0 if neither.
MessageView.prototype.checkBelow_ = function(bounds) {
  // Do we need to expand?
  if (this.nodes_.length < MIN_BUFFER)
    return 1;
  var b = this.nodes_[this.nodes_.length - MIN_BUFFER].getBoundingClientRect();
  if (bounds.bottom > b.top)
    return 1;

  // Do we need to contract?
  if (this.nodes_.length < MAX_BUFFER)
    return 0;
  b = this.nodes_[this.nodes_.length - MAX_BUFFER].getBoundingClientRect();
  if (bounds.bottom < b.top)
    return -1;
  
  return 0;
};

MessageView.prototype.checkAbove_ = function(bounds) {
  // Do we need to expand?
  if (this.nodes_.length < MIN_BUFFER)
    return 1;
  var b = this.nodes_[MIN_BUFFER - 1].getBoundingClientRect();
  if (bounds.top < b.bottom)
    return 1;

  // Do we need to contract?
  if (this.nodes_.length < MAX_BUFFER)
    return 0;
  b = this.nodes_[MAX_BUFFER - 1].getBoundingClientRect();
  if (bounds.top > b.bottom)
    return -1;
  
  return 0;
};

MessageView.prototype.checkBuffers_ = function() {
  var bounds = this.container_.getBoundingClientRect();

  // Check if we need to expand/contract above or below. If a tail
  // doesn't exist in the direction we need, create it. EXCEPTION: if
  // we need a tail and there are no messages, we don't have a
  // reference to create the tail from. Delay creating the tail; we'll
  // get our reference on append/prepend from the other side. (This
  // happens if we jump to the top or bottom.)
  //
  // TODO(davidben): Instead of only ever working 50 messages at a
  // time, it's possibly better to just pay a binary search and figure
  // out exactly how many we need to reach TARGET_BUFFER?
  //
  // TODO(davidben): Trigger removal by receiving messages?
  var below = this.checkBelow_(bounds);
  if (below > 0 && (this.tailBelow_ || this.messages_.length)) {
    if (!this.tailBelow_ && this.messages_.length) {
      this.tailBelow_ = this.model_.newTail(
        this.messages_[this.messages_.length - 1].id,
        this.appendMessages_.bind(this));
      this.tailBelowOffset_ = this.listOffset_ + this.messages_.length - 1;
    }
    this.tailBelow_.expandTo(
      this.listOffset_ + this.nodes_.length - 1 + (TARGET_BUFFER - MIN_BUFFER)
        - this.tailBelowOffset_);
  } else if (below < 0) {
    // Close the current tail.
    if (this.tailBelow_) {
      this.tailBelow_.close();
      this.tailBelow_ = null;
    }

    var num = MAX_BUFFER - TARGET_BUFFER;
    for (var i = 0; i < num; i++) {
      var idx = this.nodes_.length - i - 1;
      this.messagesDiv_.removeChild(this.nodes_[idx]);
      delete this.messageToIndex_[this.messages_[idx].id];
    }
    this.nodes_.splice(this.nodes_.length - num, num);
    this.messages_.splice(this.messages_.length - num, num);

    this.setAtBottom_(false);
  }

  var above = this.checkAbove_(bounds);
  if (above > 0 && (this.tailAbove_ || this.messages_.length)) {
    if (!this.tailAbove_) {
      this.tailAbove_ = this.model_.newReverseTail(
        this.messages_[0].id,
        this.prependMessages_.bind(this));
      this.tailAboveOffset_ = this.listOffset_;
    }
    this.tailAbove_.expandTo(
      this.tailAboveOffset_ -
        (this.listOffset_ - (TARGET_BUFFER - MIN_BUFFER)));
  } else if (above < 0) {
    // Close the current tail.
    if (this.tailAbove_) {
      this.tailAbove_.close();
      this.tailAbove_ = null;
    }

    var maxRemoved = MAX_BUFFER - TARGET_BUFFER;
    var oldHeight = this.container_.scrollHeight;

    // Limit the nodes removed; if we remove enough that scrollTop has
    // to change, the scroll gets off. Do this in two passes so as not
    // to keep re-triggering layout with
    // getBoundingClientRect. Unfortunately, this isn't the cause of
    // us getting stuck.
    var heightLost = 0;
    var maxHeight = oldHeight - this.container_.scrollTop - bounds.height;
    for (var num = 0; num < maxRemoved; num++) {
      // FIXME: What if there are margins?
      var b = this.nodes_[num].getBoundingClientRect();
      if (heightLost + b.height >= maxHeight)
        break;
      heightLost += b.height;
    }

    for (var i = 0; i < num; i++) {
      this.messagesDiv_.removeChild(this.nodes_[i]);
      delete this.messageToIndex_[this.messages_[i].id];
    }
    this.container_.scrollTop += (this.container_.scrollHeight - oldHeight);
    this.nodes_.splice(0, num);
    this.messages_.splice(0, num);
    this.listOffset_ += num;

    this.setAtTop_(false);
  }
};

MessageView.prototype.onKeydown_ = function(ev) {
  // Handle home/end keys ourselves. Instead of going to the bounds of
  // the currently buffered view (totally meaningless), they go to the
  // top/bottom of the full message list.
  if (ev.keyCode == 36 /* HOME */) {
    ev.preventDefault();
    messageView.scrollToTop();
  } else if (ev.keyCode == 35 /* END */) {
    ev.preventDefault();
    messageView.scrollToBottom();
  }
};

var messageView;  // For debugging.
$(function() {
  messageView = new MessageView(new MockMessageModel(1000),
                                document.getElementById("messagelist"));
  document.getElementById("messagelist").focus();

  messageView.scrollToMessage(mockMessageId(500));
//  messageView.scrollToBottom();
});
