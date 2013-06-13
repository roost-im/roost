"use strict";

// This parser is somewhat wonky, but this seems to be faster than the
// regex + substring version. I guess str.substring(...).search(regex)
// isn't consistently optimized to not make a copy? Yeah, I dunno.

function nextChar(str, startInd, stopChar) {
  // Give the type inferencer a bit of a boost.
  str = "" + str;
  var len = str.length;
  for (var i = startInd; i < len; i++) {
    if (str[i] === '@' || str[i] === stopChar)
      return i;
  }
  return -1;
}

var CHARCODE_a = 'a'.charCodeAt(0);
var CHARCODE_z = 'z'.charCodeAt(0);
var CHARCODE_A = 'A'.charCodeAt(0);
var CHARCODE_Z = 'Z'.charCodeAt(0);
var CHARCODE_0 = '0'.charCodeAt(0);
var CHARCODE_9 = '9'.charCodeAt(0);
var CHARCODE__ = '_'.charCodeAt(0);
function findTagName(str, startInd) {
  // Give the type inferencer a bit of a boost.
  str = "" + str;
  var len = str.length;
  for (var i = startInd; i < len; i++) {
    var code = str.charCodeAt(i);
    if (!((code >= CHARCODE_a && code <= CHARCODE_z) ||
          (code >= CHARCODE_A && code <= CHARCODE_Z) ||
          (code >= CHARCODE_0 && code <= CHARCODE_9) ||
          (code == CHARCODE__))) {
      break;
    }
  }
  return str.substring(startInd, i);
}

var OTHERSIDE = {
  "{": "}",
  "(": ")",
  "[": "]",
  "<": ">"
};

function ZtextNode(tag, open, close, children) {
  this.tag = tag;
  this.open = open;
  this.close = close;
  this.children = children;
}

var MAX_ZTEXT_DEPTH = 32;

function parseZtextHelper(str, startInd, stopChar, maxDepth) {
  var ret = [ ];
  function pushText(t) {
    if (ret.length && typeof ret[ret.length - 1] == "string") {
      ret[ret.length - 1] += t;
    } else {
      ret.push(t);
    }
  }
  while (startInd < str.length) {
    var index = nextChar(str, startInd, stopChar);
    if (index < 0) {
      pushText(str.substring(startInd));
      startInd = str.length;
      continue;
    }
    pushText(str.substring(startInd, index));
    if (str[index] == "@") {
      if (str[index + 1] == "@") {
        pushText("@");
        startInd = index + 2;
        continue;
      }
      // Don't recurse too deep.
      if (maxDepth <= 0) {
        pushText("@");
        startInd++;
      }
      var tagName = findTagName(str, index + 1);
      var open = str[index + 1 + tagName.length];
      var close = OTHERSIDE[open];
      if (!close) {
        pushText("@" + tagName);
        startInd = index + 1 + tagName.length;
        continue;
      }
      var r = parseZtextHelper(
        str,
        index + 1 + tagName.length + 1,
        close,
        maxDepth - 1);
      ret.push(new ZtextNode(tagName, open, close, r.parsed));
      startInd = r.startInd;
    } else {
      // str[index] == stopChar
      startInd = index + 1;
      break;
    }
  }
  return {
    parsed: ret,
    startInd: startInd
  };
}
function parseZtext(str) {
  return parseZtextHelper(str, 0, null, MAX_ZTEXT_DEPTH).parsed;
}

function ztextToDOM(ztext, parent) {
  if (parent == null)
    parent = document.createDocumentFragment();
  // Either the fragment or the currently active color <span>.
  var curParent = parent;
  for (var i = 0; i < ztext.length; i++) {
    var chunk = ztext[i];
    if (typeof chunk === "string") {
      // TODO(davidben): Parse out URLs. Newlines, etc. one we're no
      // longer in a <pre>. Or should I just keep it in a <pre>? I
      // guess the question is whether I want to maybe not display
      // things in a fixed-with font sometimes.
      curParent.appendChild(document.createTextNode(chunk));
    } else {
      // TODO(davidben): Implement zwgc's tags like @small, @medium,
      // @large, @left, @center, @right. Maybe even @font. Not @beep
      // though.
      if (chunk.tag == "") {
        curParent.appendChild(ztextToDOM(chunk.children));
      } else if (chunk.tag == "b" || chunk.tag == "bold") {
        var elem = document.createElement("b");
        ztextToDOM(chunk.children, elem);
        curParent.appendChild(elem);
      } else if (chunk.tag == "i" || chunk.tag == "italic") {
        var elem = document.createElement("i");
        ztextToDOM(chunk.children, elem);
        curParent.appendChild(elem);
      } else if (chunk.tag == "color" &&
                 chunk.children.length == 1 &&
                 typeof chunk.children[0] == "string") {
        var color = chunk.children[0];
        if (color in COLOR_MAP)
          color = COLOR_MAP[color];
        var elem = document.createElement("span");
        // TODO(davidben): Whitelist this thing more?
        elem.style.color = color;
        // This one is weird and affects the current color.
        parent.appendChild(elem);
        curParent = elem;
      } else {
        // BarnOwl doesn't parse unknown tags and zwgc throws them
        // away. People are probably more accustomed to the former.
        curParent.appendChild(document.createTextNode(
          "@" + chunk.tag + chunk.open));
        ztextToDOM(chunk.children, curParent);
        curParent.appendChild(document.createTextNode(chunk.close));
      }
    }
  }
  return parent;
}
