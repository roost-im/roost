"use strict";

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

var SCROLL_PAGE_MARGIN = 40;

function clamp(a, b, c) {
  return Math.max(a, Math.min(b, c));
}

function matchKey(ev, keyCode, mods) {
  if (ev.keyCode != keyCode)
    return false;
  mods = mods || { };
  var modifiers = ["altKey", "altGraphKey", "ctrlKey", "metaKey", "shiftKey"];
  for (var i = 0; i < modifiers.length; i++) {
    if (Boolean(ev[modifiers[i]]) != Boolean(mods[modifiers[i]]))
      return false;
  }
  return true;
}

function MessageView(model, container) {
  io.EventEmitter.call(this);

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
MessageView.prototype = Object.create(io.EventEmitter.prototype);

MessageView.prototype.container = function() {
  return this.container_;
};

MessageView.prototype.cachedMessages = function() {
  return this.messages_;
};

MessageView.prototype.cachedNodes = function() {
  return this.nodes_;
};

MessageView.prototype.getCacheIndex = function(id) {
  if (id in this.messageToIndex_) {
    return this.messageToIndex_[id] - this.listOffset_;
  }
  return null;
};

MessageView.prototype.getNode = function(id) {
  var idx = this.getCacheIndex(id);
  if (idx == null)
    return null;
  return this.nodes_[idx];
};

MessageView.prototype.getMessage = function(id) {
  var idx = this.getCacheIndex(id);
  if (idx == null)
    return null;
  return this.messages_[idx];
};

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

  if (bootstrap) {
    this.tailBelow_ = this.model_.newTail(id, this.appendMessages_.bind(this));
    this.tailBelowOffset_ = 0;
    this.tailBelow_.expandTo(TARGET_BUFFER);
    this.appendMessages_([bootstrap], false);
    this.nodes_[0].scrollIntoView(alignWithTop);
    // Always anchor the top if the message is too big to fit on
    // screen.
    //
    // TODO(davidben): Share code with the similar bit in
    // ensureSelectionVisible_?
    if (this.nodes_[0].getBoundingClientRect().top <
        this.container_.getBoundingClientRect().top) {
      this.nodes_[0].scrollIntoView(true);
    }
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
  this.tailAbove_.expandTo(TARGET_BUFFER);
};

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
    var idx = this.messages_.length + this.listOffset_;
    this.messageToIndex_[msgs[i].id] = idx;

    var node = this.formatMessage_(idx, msgs[i]);
    this.nodes_.push(node);
    this.messages_.push(msgs[i]);

    this.messagesDiv_.appendChild(node);
  }
  this.setAtBottom_(isDone);
  // If we were waiting to select a message that hadn't arrived yet,
  // refresh that.
  this.emit("cachechanged");
  this.checkBuffers_();
};

MessageView.prototype.prependMessages_ = function(msgs, isDone) {
  // TODO(davidben): This triggers layout a bunch. Optimize this if needbe.
  var nodes = [];
  var insertReference = this.messagesDiv_.firstChild;
  var oldHeight = this.container_.scrollHeight;
  for (var i = 0; i < msgs.length; i++) {
    var idx = this.listOffset_ - msgs.length + i;
    this.messageToIndex_[msgs[i].id] = idx;

    var node = this.formatMessage_(idx, msgs[i]);
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
  this.emit("cachechanged");
  this.checkBuffers_();
};

var COLORS = ["black", "silver", "gray", "white", "maroon", "red",
              "purple", "fuchsia", "green", "lime"];
MessageView.prototype.formatMessage_ = function(idx, msg) {
  var pre = document.createElement("pre");
  var indented = "   " +
    msg.message.replace(/\s+$/, '').split("\n").join("\n   ");

  var a = document.createElement("a");
  a.href = "#msg-" + msg.id;
  a.textContent = "[LINK]";

  var number = msg.number;
  if (number == undefined) {
    // Hash the class + instance, I guess...
    number = 0;
    var s = msg.class + "|" + msg.instance;
    for (var i = 0; i < s.length; i++) {
      // Dunno, borrowed from some random thing on the Internet that
      // claims to be Java's.
      number = ((number << 5) - number + s.charCodeAt(i)) | 0;
    }
  }

  pre.appendChild(a);
  pre.appendChild(document.createTextNode(
    " " +
      msg.class + " / " + msg.instance + " / " + msg.sender + "  " +
      new Date(msg.time).toString() + "\n" +
      indented));
  pre.className = "message";
  pre.style.color = COLORS[((number % COLORS.length) + COLORS.length) % COLORS.length];

  pre.addEventListener("click",
                       this.onClickMessage_.bind(this, idx));
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
    var maxHeight = oldHeight - this.container_.scrollTop - bounds.height;
    var top = this.nodes_[0].getBoundingClientRect().top;
    for (var num = 0; num < maxRemoved; num++) {
      var b = this.nodes_[num + 1].getBoundingClientRect();
      if (b.top - top >= maxHeight)
        break;
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

MessageView.prototype.onKeydown_ = function(ev) {
  // Handle home/end keys ourselves. Instead of going to the bounds of
  // the currently buffered view (totally meaningless), they go to the
  // top/bottom of the full message list.
  if (matchKey(ev, 36 /* HOME */) ||
      matchKey(ev, 32 /* UP */, {metaKey:1})) {
    ev.preventDefault();
    this.scrollToTop();
  } else if (matchKey(ev, 35 /* END */) ||
             matchKey(ev, 40 /* DOWN */, {metaKey:1})) {
    ev.preventDefault();
    this.scrollToBottom();
  }
};

MessageView.prototype.onClickMessage_ = function(idx, ev) {
  this.emit("messageclick", idx - this.listOffset_);
};

// Split the selection logic out for sanity.
function SelectionTracker(messageView) {
  this.messageView_ = messageView;

  this.selected_ = null;  // The id of the selected message.
  this.selectedMessage_ = null;  // null if we never saw the message.

  this.messageView_.on("cachechanged", this.onCacheChanged_.bind(this));
  this.messageView_.container().addEventListener("keydown",
                                                 this.onKeydown_.bind(this));
};

SelectionTracker.prototype.getSelectedNode_ = function() {
  if (this.selected_ == null)
    return null;
  return this.messageView_.getNode(this.selected_);
};

SelectionTracker.prototype.selectMessage = function(id) {
  if (this.selected_ != null) {
    var oldNode = this.getSelectedNode_();
    if (oldNode)
      oldNode.classList.remove("message-selected");
  }
  this.selected_ = id;
  // Update the display and everything else.
  this.onCacheChanged_();
};

SelectionTracker.prototype.findTopMessage_ = function() {
  var bounds = this.messageView_.container().getBoundingClientRect();
  var nodes = this.messageView_.cachedNodes();
  if (nodes.length == 0)
    return null;
  var lo = 0;
  var hi = nodes.length - 1;
  while (lo < hi) {
    var mid = ((lo + hi) / 2) | 0;
    var b = nodes[mid].getBoundingClientRect();
    // Find the first message which starts at or after the bounds.
    if (b.top < bounds.top) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  // It's possible the message we found starts very late, if the
  // previous is long. In that case, prefer the previous one.
  if (lo > 0 &&
      nodes[lo].getBoundingClientRect().top >=
      (bounds.top + bounds.height/2)) {
    lo--;
  }
  return lo;
};

SelectionTracker.prototype.findBottomMessage_ = function() {
  var bounds = this.messageView_.container().getBoundingClientRect();
  var nodes = this.messageView_.cachedNodes();
  if (nodes.length == 0)
    return null;
  var lo = 0;
  var hi = nodes.length - 1;
  while (lo < hi) {
    var mid = ((lo + hi + 1) / 2) | 0;
    var b = nodes[mid].getBoundingClientRect();
    // Find the first message which ends at or before the bounds.
    if (b.bottom < bounds.bottom) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  // It's possible the message we found ends very early, if the
  // next is long. In that case, prefer the next one.
  if (lo < nodes.length - 2 &&
      nodes[lo].getBoundingClientRect().bottom <=
      (bounds.top + bounds.height/2)) {
    lo++;
  }
  return lo;
};

SelectionTracker.prototype.clampSelection_ = function(top) {
  // If there is an on-screen selection, don't do anything.
  if (this.selected_ != null) {
    var node = this.getSelectedNode_();
    if (node) {
      var bounds = this.messageView_.container().getBoundingClientRect();
      var b = node.getBoundingClientRect();
      if (b.bottom > bounds.top && b.top < bounds.bottom)
        return false;
    }
  }

  // Otherwise, clamp to top or bottom.
  var newIdx = top ? this.findTopMessage_() : this.findBottomMessage_();
  if (newIdx == null)
    return false;
  this.selectMessage(this.messageView_.cachedMessages()[newIdx].id);
  return true;
};

SelectionTracker.prototype.adjustSelection_ = function(direction,
                                                       scrollLongMessages) {
  // Clamp the selection.
  if (this.clampSelection_(direction > 0))
    return true;

  // Get the currently selected node. Pretty sure this can only be
  // null now with an empty messagelist, but let's be thorough.
  if (this.selected_ == null)
    return false;
  var node = this.getSelectedNode_();
  if (node == null)
    return false;

  var bounds = this.messageView_.container().getBoundingClientRect();
  var b = node.getBoundingClientRect();
  // Scroll to show the corresponding edge of the message first.
  if (scrollLongMessages) {
    if (direction > 0 && b.bottom > bounds.bottom - MARGIN_BELOW)
      return false;
    if (direction < 0 && b.top < bounds.top)
      return false;
  }

  var idx = this.messageView_.getCacheIndex(this.selected_);
  if (idx == null) return false;  // Again, should not happen.
  var newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= this.messageView_.cachedNodes().length)
    return false;  // There isn't a message to select.

  // TODO(davidben): This grew organically out of a handful of
  // experiments before settling on something similar to what BarnOwl
  // does anyway. It can probably be simplified.
  this.selectMessage(this.messageView_.cachedMessages()[newIdx].id);
  var newNode = this.messageView_.cachedNodes()[newIdx];

  // What it would take to get the top of the new message at the top
  // of the screen.
  var topScroll =
    newNode.getBoundingClientRect().top -
    this.messageView_.topMarker_.getBoundingClientRect().top;
  // What it would take to get to the goal ratio.
  var goalScroll = topScroll - ((direction < 0) ?
                                (bounds.height * GOAL_RATIO_UP) :
                                (bounds.height * GOAL_RATIO_DOWN));
  if ((direction < 0 && this.messageView_.container().scrollTop > goalScroll) ||
      (direction > 0 && this.messageView_.container().scrollTop < goalScroll)) {
    // What it would take to keep the top of the selected message fixed.
    var fixedScroll = this.messageView_.container().scrollTop +
      direction * node.getBoundingClientRect().height;

    // Pick the first, but don't move the top of the selected message
    // much. However, make sure the top is visible.
    var newScroll = Math.min(
      clamp(fixedScroll - MAX_ARROW_SCROLL,
            goalScroll,
            fixedScroll + MAX_ARROW_SCROLL),
      topScroll);
    this.messageView_.container().scrollTop = newScroll;
  }
  return true;
};

SelectionTracker.prototype.ensureSelectionVisible_ = function() {
  var bounds = this.messageView_.container().getBoundingClientRect();

  // We never saw the selection. Don't do anything.
  if (this.selectedMessage_ == null)
    return;

  var node = this.getSelectedNode_();
  if (node == null) {
    // We scrolled the selection off-screen. But we have seen it, so
    // scroll there.
    //
    // TODO(davidben): This is a pretty poor approximation of the
    // alignWithTop behavior, since we don't know how to compare
    // messages.
    var alignWithTop = true;
    var firstMessage = this.messageView_.cachedMessages()[0];
    if (firstMessage !== undefined) {
      alignWithTop = this.selectedMessage_.receiveTime < firstMessage.receiveTime;
    }
    this.messageView_.scrollToMessage(
      this.selectedMessage_.id, this.selectedMessage_, alignWithTop);
    return;
  }
  // Scroll the message into view if not there.
  var b = node.getBoundingClientRect();
  if (b.bottom > bounds.bottom) {
    node.scrollIntoView(false);
    b = node.getBoundingClientRect();
  }
  if (b.top < bounds.top) {
    node.scrollIntoView(true);
  }
};

SelectionTracker.prototype.onKeydown_ = function(ev) {
  if (matchKey(ev, 40 /* DOWN */) || matchKey(ev, 74 /* j */)) {
    if (this.adjustSelection_(1, ev.keyCode == 40))
      ev.preventDefault();
  } else if (matchKey(ev, 38 /* UP */) || matchKey(ev, 75 /* k */)) {
    if (this.adjustSelection_(-1, ev.keyCode == 38))
      ev.preventDefault();
  } else if (matchKey(ev, 82 /* r */)) {
    ev.preventDefault();
    this.ensureSelectionVisible_();
  }
};

SelectionTracker.prototype.onCacheChanged_ = function() {
  if (this.selected_ != null) {
    // Updated the cached selected message if needbe.
    if (this.selectedMessage_ == null)
      this.selectedMessage_ = this.messageView_.getMessage(this.selected_);
    // Update the display. Node may have been destroyed or recreated.
    var node = this.getSelectedNode_();
    if (node)
      node.classList.add("message-selected");
  }
};
