#!/usr/bin/env node

var Buffer = require('buffer').Buffer;
var Q = require('q');

var db = require('../lib/db.js');
var message = require('../lib/message.js');

// Migration for database at the state of
// d86fc4057e4d31dc5beb0eaaf4d1664b22119d59.
//
// Add and populate values for class_key_base, instance_key_base, and
// conversation. This assumes we do not yet have support for CC'd
// messages or outgoing messages.
//
// Also add some foreign keys and indices.
//
// TODO(davidben): Use a real migration framework? I guess this scheme
// lets me do things like dump the data, migrate manually, and restore
// on sql.mit.edu, if I want to. Not clear that's better.

function up() {
  var conn = db.createConnection();
  return conn.withTransaction(function() {
    // Add the columns.
    return [
      'ALTER TABLE messages ADD COLUMN class_key_base VARBINARY(255) NOT NULL ' +
        'AFTER instance_key',
      'ALTER TABLE messages ADD COLUMN instance_key_base VARBINARY(255) NOT NULL ' +
        'AFTER class_key_base',
      'ALTER TABLE messages ADD COLUMN conversation VARBINARY(255) NOT NULL ' +
        'AFTER recipient'
    ].reduce(function(soFar, sql) {
      return soFar.then(conn.query.bind(conn, sql));
    }, Q()).then(function() {
      // Populate the conversation column. That one's easy.
      return conn.query(
        'UPDATE messages SET conversation=sender WHERE recipient != \'\' ' +
          'AND LEFT(recipient, 1) != \'@\'');
    }).then(function() {
      // And now class_key_base and instance_key_base...
      return conn.query(
        'SELECT id, class_key, instance_key FROM messages'
      ).then(function(rows) {
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
    }).then(function() {
      return [
        // Foreign keys from 3fc8ac08f24d696669bd1fdd3c6eaa504ab9f842.
        'ALTER TABLE user_messages ADD FOREIGN KEY ' +
          'user_fkey (user_id) REFERENCES users(id)',
        'ALTER TABLE user_messages ADD FOREIGN KEY ' +
          'message_fkey (message_id) REFERENCES messages(id)',
        // ALL THE INDEXES.
        'ALTER TABLE messages ADD INDEX class_key_idx (class_key)',
        'ALTER TABLE messages ADD INDEX class_key_base_idx (class_key_base)',
        'ALTER TABLE messages ADD INDEX instance_key_idx (instance_key)',
        'ALTER TABLE messages ADD INDEX instance_key_base_idx (instance_key_base)',
        'ALTER TABLE messages ADD INDEX conversation_idx (conversation)',
        'ALTER TABLE messages ADD INDEX recipient_idx (recipient)',
        'ALTER TABLE messages ADD INDEX sender_idx (sender)'
      ].reduce(function(soFar, sql) {
        return soFar.then(conn.query.bind(conn, sql));
      }, Q());
    });
  }).finally(function() {
    conn.end();
  });
}

up().done();