#!/usr/bin/env node

// Program for importing zlogs. Just for testing purposes.

var fs = require('fs');
var path = require('path');
var PriorityQueue = require('priorityqueuejs');
var Q = require('q');
var zephyr = require('zephyr');

var db = require('../lib/db.js');

var args = process.argv.slice(2);
if (args.length != 1) {
  console.error('Usage: %s %s DIRECTORY', process.argv[0], process.argv[1]);
  process.exit();
}

function parseLogFile(file, klass) {
  var messages = [];
  var lines = fs.readFileSync(file, {encoding: 'utf-8'}).split('\n');

  var msg = null;
  var fromLine = null;
  var body = null;

  var completeMessage = function() {
    if (msg != null) {
      var m = /^From: ([^]*) <(.*)>$/.exec(fromLine);
      if (!m) {
        console.warn('Bad from line: %s', fromLine);
      } else {
        var sig = m[1];
        var sender = m[2];
        if (sender.indexOf('@') < 0)
          sender = sender + '@ATHENA.MIT.EDU';
        // Strip off one trailing newline.
        msg.message = body.substring(0, body.length - 1);
        msg.signature = sig;
        msg.sender = sender;

        messages.push(msg);
      }
    }
    // And reset.
    msg = { };
    fromLine = null;
    body = null;
  };

  for (var i = 0; i < lines.length; i++) {
    var m = /^Instance: (.*) Time: (.*) Host: (.*)$/.exec(lines[i]);
    if (m && (/^From: /).test(lines[i + 1])) {
      completeMessage();

      msg.class = klass;
      msg.instance = m[1];
      msg.time = new Date(m[2]);
      msg.recipient = '';
      msg.realm = 'ATHENA.MIT.EDU';
      msg.opcode = '';
      msg.auth = zephyr.ZAUTH_YES;

      fromLine = lines[i + 1]; i++;
    } else if (i == 0) {
      // The first line of the file looks off.
      if (lines[i] != '')
        console.warn('File %s has bad format', file);
    } else if (body == null) {
      // Still gathering the from line.
      if (lines[i] == '') {
        body = '';
      } else {
        fromLine += '\n' + lines[i];
      }
    } else {
      // Just append to the body.
      body += lines[i] + '\n';
    }
  }
  completeMessage();
  
  return messages;
}

console.log('Parsing log files');
var streams = [].concat.apply([], fs.readdirSync(args[0]).map(function(klass) {
  var classDir = path.join(args[0], klass);
  return fs.readdirSync(classDir).map(function(filename) {
    var logFile = path.join(classDir, filename);
    return parseLogFile(logFile, klass);
  });
}));
console.log('Parsed. Sorting...');

// Merge them.
var merged = [];
var queue = new PriorityQueue(function(a, b) {
  // Make it a min-heap.
  return b.time - a.time;
});
streams.forEach(function(stream, sIdx) {
  if (stream.length == 0)
    return;
  // Meh.
  stream[0].sIdx = sIdx;
  stream[0].idx = 0;
  queue.enq(stream[0]);
});
while (queue.size() > 0) {
  var msg = queue.deq();
  merged.push(msg);
  // Enqueue the next one in that list.
  if (msg.idx + 1 < streams[msg.sIdx].length) {
    // Meh.
    var newMsg = streams[msg.sIdx][msg.idx + 1];
    newMsg.sIdx = msg.sIdx;
    newMsg.idx = msg.idx + 1;
    queue.enq(newMsg);
  }
}

console.log('Sorted. Stuffing into db');
// And, finally, stuff into the database.
merged.reduce(function(soFar, msg) {
  return soFar.then(function() {
    return db.saveMessage(msg);
  });
}, Q()).done();
