#!/usr/bin/env node

var Buffer = require('buffer').Buffer;
var Q = require('q');

var db = require('../lib/db.js');

// Migration for database at the state of
// 2f7f09c89fd12df38dd3e0463a8a0f1028b8cbbf
//
// Fix the indexes. Sigh.

function up() {
  var conn = db.createConnection();
  return conn.withTransaction(function() {
    return [
      'ALTER TABLE messages DROP INDEX class_key_idx',
      'ALTER TABLE messages DROP INDEX class_key_base_idx',
      'ALTER TABLE messages DROP INDEX instance_key_idx',
      'ALTER TABLE messages DROP INDEX instance_key_base_idx',
      'ALTER TABLE messages DROP INDEX conversation_idx',
      'ALTER TABLE messages DROP INDEX recipient_idx',
      'ALTER TABLE messages DROP INDEX sender_idx',

      'ALTER TABLE messages ADD INDEX class_key_idx (class_key, id)',
      'ALTER TABLE messages ADD INDEX class_key_base_idx (class_key_base, id)',
      'ALTER TABLE messages ADD INDEX instance_key_idx (instance_key, id)',
      'ALTER TABLE messages ADD INDEX instance_key_base_idx (instance_key_base, id)',
      'ALTER TABLE messages ADD INDEX conversation_idx (conversation, id)',
      'ALTER TABLE messages ADD INDEX recipient_idx (recipient, id)',
      'ALTER TABLE messages ADD INDEX sender_idx (sender, id)'
    ].reduce(function(soFar, sql) {
      return soFar.then(conn.query.bind(conn, sql));
    }, Q());
  }).finally(function() {
    conn.end();
  });
}

up().done();