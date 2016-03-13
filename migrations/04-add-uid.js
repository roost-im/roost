#!/usr/bin/env node

var Buffer = require('buffer').Buffer;
var Q = require('q');

var db = require('../lib/db.js');

// Migration for database at the state of
// e7666de542735d89cadda1f6c46d9f3fa3b0cbf6

function up() {
  var conn = db.createConnection();
  return conn.withTransaction(function() {
    return [
      'ALTER TABLE messages ADD COLUMN uid VARBINARY(16) NOT NULL ' +
        'DEFAULT \'AAAAAAAAAAAAAAAA\' AFTER is_outgoing',
    ].reduce(function(soFar, sql) {
      return soFar.then(conn.query.bind(conn, sql));
    }, Q());
  }).finally(function() {
    conn.end();
  });
}

up().done();
