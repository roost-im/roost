"use strict";

function FIXMEmockMessageId(idx) {
  return btoa(String(idx));
}
function getMockMessage(ref, offset) {
  // Some bogus "hiding" of message ids. base64-encode their ascii
  // representation.
  ref = Number(atob(ref));
  ref += offset;
  var idx = ref % SAMPLE_MSGS.length;
  if (idx < 0)
    idx += SAMPLE_MSGS.length;

  var msg = { };
  for (var key in SAMPLE_MSGS[idx]) {
    msg[key] = SAMPLE_MSGS[idx][key];
  }
  msg.number = ref;
  msg.id = FIXMEmockMessageId(ref);
  return msg;
}

function MockMessageModel() {
}
// TODO(davidben): Just make the API take the options dict along with
// an initial count parameter?
MockMessageModel.prototype.newTailInclusive = function(start, cb) {
  return new MockMessageTail(start, cb, {
    inclusive: true
  });
};
MockMessageModel.prototype.newTail = function(start, cb) {
  return new MockMessageTail(start, cb, {});
};
MockMessageModel.prototype.newReverseTail = function(start, cb) {
  return new MockMessageTail(start, cb, {
    reverse: true
  });
};

function MockMessageTail(start, cb, opts) {
  this.start_ = start;
  this.reverse_ = opts.reverse;
  this.cb_ = cb;

  // Simulate doing only one XHR at a time.
  this.requestPending_ = false;
  this.lastRequested_ = opts.inclusive ? -1 : 0;
  this.count_ = 0;
  // We intentionally do not fire a request and assume the user will
  // immediately call expandTo.
  //
  // this.fireRequest_();
}
MockMessageTail.prototype.expandTo = function(count) {
  this.count_ = Math.max(this.count_, count);
  this.fireRequest_();
};
MockMessageTail.prototype.close = function() {
  this.cb_ = null;
};
MockMessageTail.prototype.fireRequest_ = function() {
  if (this.requestPending_)
    return;
  if (this.lastRequested_ >= this.count_)
    return;

  var requestStart = this.lastRequested_;
  var requestEnd = this.count_;

  this.lastRequested_ = this.count_;
  this.requestPending_ = true;

  window.setTimeout(function() {
    // Fake some messages.
    var msgs = [];
    if (this.reverse_) {
      for (var i = requestEnd; i > requestStart; i--) {
        msgs.push(getMockMessage(this.start_, -i));
      }
    } else {
      for (var i = requestStart + 1; i <= requestEnd; i++) {
        msgs.push(getMockMessage(this.start_, i));
      }
    }
    // For now, say we're never at the end...
    if (this.cb_)
      this.cb_(msgs, false);

    this.requestPending_ = false;
    this.fireRequest_();
  }.bind(this), 500);
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

  this.tailBelow_ = model.newTailInclusive(FIXMEmockMessageId(0),
                                           this.appendMessages_.bind(this));
  this.tailBelowOffset_ = 0;  // The global index of the tail reference.

  this.tailAbove_ = model.newReverseTail(FIXMEmockMessageId(0),
                                         this.prependMessages_.bind(this));
  this.tailAboveOffset_ = 0;  // The global index of the tail reference.

  this.listOffset_ = 0;  // The global index of the top of the list.
  this.messages_ = [];
  this.nodes_ = [];

  this.container_.addEventListener("scroll", this.checkBuffers_.bind(this));
  this.checkBuffers_();
}
MessageView.prototype.appendMessages_ = function(msgs, isDone) {
  for (var i = 0; i < msgs.length; i++) {
    var node = this.formatMessage_(msgs[i]);
    this.nodes_.push(node);
    this.messages_.push(msgs[i]);

    this.container_.appendChild(node);
  }
};
MessageView.prototype.prependMessages_ = function(msgs, isDone) {
  // TODO(davidben): This triggers layout a bunch. Optimize this if needbe.
  var nodes = [];
  var insertReference = this.container_.firstChild;
  var oldHeight = this.container_.scrollHeight;
  for (var i = 0; i < msgs.length; i++) {
    var node = this.formatMessage_(msgs[i]);
    nodes.push(node);

    this.container_.insertBefore(node, insertReference);
  }
  this.container_.scrollTop += (this.container_.scrollHeight - oldHeight);

  this.messages_.unshift.apply(this.messages_, msgs);
  this.nodes_.unshift.apply(this.nodes_, nodes);
  this.listOffset_ -= msgs.length;
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

  // TODO(davidben): Instead of only ever working 50 messages at a
  // time, it's possibly better to just pay a binary search and figure
  // out exactly how many we need to reach TARGET_BUFFER?
  //
  // TODO(davidben): Trigger removal by receiving messages?
  var below = this.checkBelow_(bounds);
  if (below > 0) {
    if (!this.tailBelow_) {
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
      this.container_.removeChild(this.nodes_[this.nodes_.length - i - 1]);
    }
    this.nodes_.splice(this.nodes_.length - num, num);
    this.messages_.splice(this.messages_.length - num, num);
  }

  var above = this.checkAbove_(bounds);
  if (above > 0) {
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
      this.container_.removeChild(this.nodes_[i]);
    }
    this.container_.scrollTop += (this.container_.scrollHeight - oldHeight);
    this.nodes_.splice(0, num);
    this.messages_.splice(0, num);
    this.listOffset_ += num;
  }
};

$(function() {
  new MessageView(new MockMessageModel(),
                  document.getElementById("messagelist"));
  document.getElementById("messagelist").focus();
});
