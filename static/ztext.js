"use strict";

function indexOfEither(str, a, b) {
  if (b == null)
    return str.indexOf(a);
  var aInd = str.indexOf(a);
  var bInd = str.indexOf(b);
  if (aInd < 0)
    return bInd;
  if (bInd < 0)
    return aInd;
  return Math.min(aInd, bInd);
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

function parseZtextHelper(str, stopChar, maxDepth) {
  var ret = [ ];
  function pushText(t) {
    if (ret.length && typeof ret[ret.length - 1] == "string") {
      ret[ret.length - 1] += t;
    } else {
      ret.push(t);
    }
  }
  while (str.length > 0) {
    var index = indexOfEither(str, "@", stopChar);
    if (index < 0) {
      pushText(str);
      str = "";
      continue;
    }
    pushText(str.substring(0, index));
    if (str[index] == "@" && maxDepth > 0) {
      if (str[index + 1] == "@") {
        pushText("@");
        str = str.substring(index + 2);
        continue;
      }
      var tagName = str.substring(index + 1).match(/^[a-zA-Z0-9_]*/)[0];
      var open = str[index + 1 + tagName.length];
      var close = OTHERSIDE[open];
      if (!close) {
        pushText("@");
        str = str.substring(index + 1);
        continue;
      }
      var r = parseZtextHelper(
        str.substring(index + 1 + tagName.length + 1),
        close,
        maxDepth - 1);
      ret.push(new ZtextNode(tagName, open, close, r.parsed));
      str = r.rest;
    } else {
      // str[index] == stopChar
      str = str.substring(index + 1);
      break;
    }
  }
  return {
    parsed: ret,
    rest: str
  };
}
function parseZtext(str) {
  return parseZtextHelper(str, null, MAX_ZTEXT_DEPTH).parsed;
}

function ztextToDOM(ztext) {
  var fragment = document.createDocumentFragment();
  // Either the fragment or the currently active color <span>.
  var curParent = fragment;
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
        elem.appendChild(ztextToDOM(chunk.children));
        curParent.appendChild(elem);
      } else if (chunk.tag == "i" || chunk.tag == "italic") {
        var elem = document.createElement("i");
        elem.appendChild(ztextToDOM(chunk.children));
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
        fragment.appendChild(elem);
        curParent = elem;
      } else {
        // BarnOwl doesn't parse unknown tags and zwgc throws them
        // away. People are probably more accustomed to the former.
        curParent.appendChild(document.createTextNode(
          "@" + chunk.tag + chunk.open));
        curParent.appendChild(ztextToDOM(chunk.children));
        curParent.appendChild(document.createTextNode(chunk.close));
      }
    }
  }
  return fragment;
}
