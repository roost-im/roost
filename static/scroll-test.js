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

var MAX_ARROW_SCROLL = 50;
var GOAL_RATIO_UP = 0.25;
var GOAL_RATIO_DOWN = 0.60;

var MARGIN_TOP = 20;
var MARGIN_BELOW = 40;

function clamp(a, b, c) {
  return Math.max(a, Math.min(b, c));
}

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
  this.loadingAbove_.classList.add("msgview-loading-above");
  var seriously = document.createElement("div");
  seriously.classList.add("msgview-loading-above-text");
  seriously.textContent = "Loading...";
  this.loadingAbove_.appendChild(seriously);

  this.loadingBelow_ = document.createElement("div");
  this.loadingBelow_.classList.add("msgview-loading-below");
  seriously = document.createElement("div");
  seriously.classList.add("msgview-loading-below-text");
  seriously.textContent = "Loading...";
  this.loadingBelow_.appendChild(seriously);

  this.messagesDiv_ = document.createElement("div");

  this.topMarker_ = document.createElement("div");
  this.topMarker_.classList.add("msgview-top-marker");

  this.container_.appendChild(this.topMarker_);
  this.container_.appendChild(this.loadingAbove_);
  this.container_.appendChild(this.messagesDiv_);
  this.container_.appendChild(this.loadingBelow_);

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

  this.selected_ = null;  // The global index of the selected message.
  this.selectedMessage_ = null;  // null if we never saw the message.

  this.messageToIndex_ = {};  // Map id to global index.

  this.messagesDiv_.textContent = "";

  // FIXME: This shows two loading bars. But we can't actually lie
  // about one side because atTop_ and atBottom_ are needed to
  // implement home/end behavior.
  this.setAtTop_(false);
  this.setAtBottom_(false);
  this.loadingBelow_.scrollIntoView();
};

MessageView.prototype.scrollToMessage = function(id, bootstrap, alignWithTop) {
  if (id in this.messageToIndex_) {
    // Easy case: if the message is in our current view, we just jump
    // to it.
    this.nodes_[this.messageToIndex_[id] - this.listOffset_].scrollIntoView();
    return;
  }

  // Otherwise, we reset the universe and use |id| as our new point of
  // reference.
  this.reset_();
  this.selectMessage_(0);

  if (bootstrap) {
    this.tailBelow_ = this.model_.newTail(id, this.appendMessages_.bind(this));
    this.tailBelowOffset_ = 0;
    this.tailBelow_.expandTo(TARGET_BUFFER);
    this.appendMessages_([bootstrap], false);
    this.nodes_[0].scrollIntoView(alignWithTop);
  } else {
    this.tailBelow_ = this.model_.newTailInclusive(
      id, this.appendMessages_.bind(this));
    this.tailBelowOffset_ = 0;
    this.tailBelow_.expandTo(TARGET_BUFFER);
  }

  this.tailAbove_ = this.model_.newReverseTail(
    id, this.prependMessages_.bind(this));
  this.tailAboveOffset_ = 0;  // The global index of the tail reference.
  this.tailAbove_.expandTo(TARGET_BUFFER);
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
  this.selectMessage_(0);
  // Blegh. Cut out the "Loading..." text now.
  this.setAtTop_(true);
  this.setAtBottom_(false);
  this.container_.scrollTop = 0;

  // TODO(davidben): Optimization: we know that tailAbove_ is bogus
  // here and don't need to wait for a tailBelow_ reference point to
  // find out. (In fact, our empty list behavior only works because we
  // know only one side can grow.) But the system doesn't know that
  // and will create a tailAbove_ once it gets a reference point. Put
  // in a stub tailAbove_ of some sort to deal with this. Or maybe use
  // atTop_.

  this.tailBelow_ = this.model_.newTail(null, this.appendMessages_.bind(this));
  this.tailBelow_.expandTo(TARGET_BUFFER);
  this.tailBelowOffset_ = 0;
};

MessageView.prototype.scrollToBottom = function(id) {
  if (this.atBottom_) {
    // Easy case: if the bottom is buffered, go there.
    this.container_.scrollTop = this.container_.scrollHeight;
    this.selectMessage_(this.listOffset_ + this.messages_.length - 1);
    return;
  }

  // Otherwise, we reset the universe and use |id| as our new point of
  // reference.
  this.reset_();
  // Blegh. Cut out the "Loading..." text now.
  this.setAtTop_(false);
  this.setAtBottom_(true);
  this.selectMessage_(-1);

  // We create one tail and lazily create the other one when we have a
  // reference point.
  //
  // FIXME! This... works. But it's sort of odd. Also, it breaks
  // horribly when you have zero messages. Also, note all the random
  // comments you had to add to support this.
  this.tailAbove_ = this.model_.newReverseTail(
    null, this.prependMessages_.bind(this));
  this.tailAboveOffset_ = 0;
  this.tailAbove_.expandTo(TARGET_BUFFER);
};

MessageView.prototype.ensureSelectionVisible_ = function() {
  var bounds = this.container_.getBoundingClientRect();

  if (this.selectedMessage_ == null) {
    // If we never saw the selection, warp it somewhere else. We don't
    // even know the message id.
    this.selectMessage_(this.findTopMessage_(bounds));
  }

  var node = this.selectedNode_();
  if (node == null) {
    // We scrolled the selection off-screen. But we have seen it, so
    // |selectedMessage_| can't be null.
    this.scrollToMessage(this.selectedMessage_.id,
                         this.selectedMessage_,
                         this.selected_ <= this.listOffset_);
    return true;
  }
  var b = node.getBoundingClientRect();

  // Scroll the message into view if not there.
  if (b.bottom < bounds.top + MARGIN_TOP) {
    node.scrollIntoView(true);
    return true;
  }
  if (b.top > bounds.bottom - MARGIN_BELOW) {
    node.scrollIntoView(false);
    b = node.getBoundingClientRect();
    // Always anchor the top if the message is too big to fit on
    // screen.
    if (b.top < bounds.top)
      node.scrollIntoView(true);
    return true;
  }
};

MessageView.prototype.selectMessage_ = function(selected) {
  if (this.selected_ != null) {
    var node = this.selectedNode_();
    if (node)
      node.classList.remove("message-selected");
  }
  if (this.selected_ !== selected)
    this.selectedMessage_ = null;
  this.selected_ = selected;
  if (this.selected_ != null) {
    var idx = this.selected_ - this.listOffset_;
    if (0 <= idx && idx < this.nodes_.length) {
      this.selectedMessage_ = this.messages_[idx];
      var node = this.nodes_[idx];
      node.classList.add("message-selected");
    }
  }
};

MessageView.prototype.selectedNode_ = function() {
  if (this.selected_ == null)
    return null;
  var idx = this.selected_ - this.listOffset_;
  if (idx < 0 || idx >= this.nodes_.length)
    return null;
  return this.nodes_[idx];
}

MessageView.prototype.setAtTop_ = function(atTop) {
  if (this.atTop_ == atTop) return;
  this.atTop_ = atTop;
  if (this.atTop_)
    this.loadingAbove_.classList.add("msgview-loading-above-at-end");
  else
    this.loadingAbove_.classList.remove("msgview-loading-above-at-end");
};

MessageView.prototype.setAtBottom_ = function(atBottom) {
  this.atBottom_ = atBottom;
  if (this.atBottom_)
    this.loadingBelow_.classList.add("msgview-loading-below-at-end");
  else
    this.loadingBelow_.classList.remove("msgview-loading-below-at-end");
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
  // If we were waiting to select a message that hadn't arrived yet,
  // refresh that.
  this.selectMessage_(this.selected_);
  this.checkBuffers_();
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
  this.setAtTop_(isDone);
  this.container_.scrollTop += (this.container_.scrollHeight - oldHeight);

  this.messages_.unshift.apply(this.messages_, msgs);
  this.nodes_.unshift.apply(this.nodes_, nodes);
  this.listOffset_ -= msgs.length;

  // Awkward special-case: if we...
  //
  // 1. Reach the end of the tail above.
  // 2. Have no messages.
  // 3. Have no downward tail.
  //
  // ...then we must have scrolled to the bottom on an empty message
  // list. But that doesn't mean we shouldn't have a bottom tail. We
  // may later receive messages and have no way to bootstrap
  // everything. In that case, pretend we scrolled to the top.
  if (isDone &&
      this.messages_.length == 0 &&
      this.tailBelow_ == null) {
    this.tailBelow_ =
      this.model_.newTail(null, this.appendMessages_.bind(this));
    this.tailBelow_.expandTo(TARGET_BUFFER);
    this.tailBelowOffset_ = 0;
  }

  // If we were waiting to select a message that hadn't arrived yet,
  // refresh that.
  this.selectMessage_(this.selected_);
  this.checkBuffers_();
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

MessageView.prototype.findTopMessage_ = function(bounds) {
  if (this.nodes_.length == 0)
    return null;
  var lo = 0;
  var hi = this.nodes_.length - 1;
  while (lo < hi) {
    var mid = ((lo + hi) / 2) | 0;
    var b = this.nodes_[mid].getBoundingClientRect();
    // Require at least N pixels visible.
    if (b.bottom <= bounds.top + MARGIN_TOP) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return this.listOffset_ + lo;
};

MessageView.prototype.findBottomMessage_ = function(bounds) {
  if (this.nodes_.length == 0)
    return null;
  var lo = 0;
  var hi = this.nodes_.length - 1;
  while (lo < hi) {
    var mid = ((lo + hi + 1) / 2) | 0;
    var b = this.nodes_[mid].getBoundingClientRect();
    // Require at least N pixels visible.
    // TODO(davidben): This magic number is dumb.
    if (b.top < bounds.bottom - 20) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return this.listOffset_ + lo;
};

MessageView.prototype.checkSelected_ = function() {
  var bounds = this.container_.getBoundingClientRect();
  // There's nothing to do.
  if (this.messages_.length == 0)
    return false;

  // There's no selection. Start from the top message and we'll go
  // from there.
  var selected = this.selected_;
  if (selected == null) {
    selected = this.listOffset_;
  }

  // Clamp the selection to the list.
  selected = Math.min(this.listOffset_ + this.messages_.length - 1,
                      selected);
  selected = Math.max(this.listOffset_, selected);

  // Move on-screen if off-screen
  var b = this.nodes_[selected - this.listOffset_].getBoundingClientRect();
  if (b.bottom <= bounds.top) {
    selected = this.findTopMessage_(bounds);
  } else if (b.top >= bounds.bottom) {
    selected = this.findBottomMessage_(bounds);
  }

  if (this.selected_ !== selected) {
    this.selectMessage_(selected);
    return true;
  }
  return false;
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
    this.setAtTop_(false);
    this.container_.scrollTop += (this.container_.scrollHeight - oldHeight);
    this.nodes_.splice(0, num);
    this.messages_.splice(0, num);
    this.listOffset_ += num;
  }
};

MessageView.prototype.adjustSelection_ = function(direction) {
  if (this.ensureSelectionVisible_())
    return true;

  var node = this.selectedNode_();
  if (node == null)
    return false;
  var bounds = this.container_.getBoundingClientRect();
  var b = node.getBoundingClientRect();
  // Scroll to show the corresponding edge of the message first.
  if (direction > 0 && b.bottom >= bounds.bottom - MARGIN_BELOW)
    return false;
  if (direction < 0 && b.top <= bounds.top)
    return false;

  var newSelected = this.selected_ + direction;
  if (newSelected - this.listOffset_ >= this.nodes_.length ||
      newSelected - this.listOffset_ < 0)
    return false;  // There isn't a message to select.

  this.selectMessage_(newSelected);
  var newNode = this.selectedNode_();
  if (newNode) {
    // What it would take to get the top of the new message at the top
    // of the screen.
    var topScroll =
      newNode.getBoundingClientRect().top -
      this.topMarker_.getBoundingClientRect().top;
    // What it would take to get to the goal ratio.
    var centerScroll = topScroll -
      (bounds.height * ((direction < 0) ? GOAL_RATIO_UP : GOAL_RATIO_DOWN));
    // What it would take to keep the top of the selected message fixed.
    var fixedScroll = this.container_.scrollTop +
      direction * node.getBoundingClientRect().height;

    // Pick the first, but don't move the top of the selected message
    // much. However, make sure the top is visible.
    var newScroll = Math.min(
      clamp(fixedScroll - MAX_ARROW_SCROLL,
            centerScroll,
            fixedScroll + MAX_ARROW_SCROLL),
      topScroll);
    this.container_.scrollTop = newScroll;
  } else {
    // This shouldn't happen...
  }
  return true;
};

MessageView.prototype.onKeydown_ = function(ev) {
  // Handle home/end keys ourselves. Instead of going to the bounds of
  // the currently buffered view (totally meaningless), they go to the
  // top/bottom of the full message list.
  if (ev.keyCode == 36 /* HOME */) {
    ev.preventDefault();
    this.scrollToTop();
  } else if (ev.keyCode == 35 /* END */) {
    ev.preventDefault();
    this.scrollToBottom();
  } else if (ev.keyCode == 40 /* DOWN */) {
    if (this.adjustSelection_(1))
      ev.preventDefault();
  } else if (ev.keyCode == 38 /* UP */) {
    if (this.adjustSelection_(-1))
      ev.preventDefault();
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
