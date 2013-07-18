#!/usr/bin/env node

var Buffer = require('buffer').Buffer;
var Q = require('q');

var db = require('../lib/db.js');
var message = require('../lib/message.js');

// Migration for database at the state of
// 8ab14f19adbe41a1ecfc3df6bdfe458c99aced8e
//
// Fix broken values for class_key_base, etc.

function up() {
  var conn = db.createConnection();
  return conn.withTransaction(function() {
    // Fix the conversation column. That one's easy.
    return conn.query(
      'UPDATE messages SET conversation=sender WHERE recipient != \'\' ' +
        'AND LEFT(recipient, 1) != \'@\''
    ).then(function() {
      // And now class_key_base and instance_key_base...
      return conn.query(
        'SELECT id, class_key, instance_key, class_key_base, instance_key_base FROM messages'
      ).then(function(rows) {
        // Only redo the bad ones.
        rows = rows.filter(function(row) {
          return message.baseString(row.class_key.toString('utf8')) !=
            row.class_key_base.toString('utf8');
        });
        return rows.reduce(function(soFar, row) {
          return soFar.then(function() {
            return conn.query(
              'UPDATE messages SET class_key_base = ?, instance_key_base = ? ' +
                'WHERE id = ?',
              [new Buffer(message.baseString(row.class_key.toString('utf8'))),
               new Buffer(message.baseString(row.instance_key.toString('utf8'))),
               row.id]);
          });
        }, Q());
      });
    });
  }).finally(function() {
    conn.end();
  });
}

up().done();