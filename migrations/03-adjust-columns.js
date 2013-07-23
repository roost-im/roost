#!/usr/bin/env node

var Buffer = require('buffer').Buffer;
var Q = require('q');

var db = require('../lib/db.js');

// Migration for database at the state of
// 3b164930ac151e9e15b5f79be166dc524c003cf1

function up() {
  var conn = db.createConnection();
  return conn.withTransaction(function() {
    return [
      'ALTER TABLE messages DROP COLUMN realm',

      'ALTER TABLE messages ADD COLUMN is_personal BOOLEAN NOT NULL ' +
        'AFTER conversation',
      'ALTER TABLE messages ADD COLUMN is_outgoing BOOLEAN NOT NULL ' +
        'AFTER is_personal',

      'UPDATE messages SET is_personal=1 WHERE recipient != \'\' ' +
        'AND LEFT(recipient, 1) != \'@\'',

      'ALTER TABLE messages ADD INDEX is_personal_idx (is_personal, id)',
    ].reduce(function(soFar, sql) {
      return soFar.then(conn.query.bind(conn, sql));
    }, Q());
  }).finally(function() {
    conn.end();
  });
}

up().done();