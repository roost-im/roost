var mysql = require('mysql');
var Q = require('q');

var conf = require('./config.js');

// Per vasilvv, use VARBINARY everywhere instead of VARCHAR. MySQL
// collations are sad.

var schemas = [
  'CREATE TABLE users (' +
    'id BIGINT AUTO_INCREMENT PRIMARY KEY,' +
    'username VARBINARY(255) UNIQUE NOT NULL' +
    ') ENGINE=InnoDB;',

  'CREATE TABLE subs (' +
    'id BIGINT AUTO_INCREMENT PRIMARY KEY,' +
    // These are post NFKC and (for class/inst) downcasing
    'class VARBINARY(255) NOT NULL,' +
    'instance VARBINARY(255) NULL,' +
    'recipient VARBINARY(255) NOT NULL,' +
    'UNIQUE target_idx (class, instance, recipient)' +
    ') ENGINE=InnoDB;',

  'CREATE TABLE user_subs (' +
    'id BIGINT AUTO_INCREMENT PRIMARY KEY,' +
    'user_id BIGINT NOT NULL,' +
    'FOREIGN KEY user_fkey (user_id) REFERENCES users(id),' +
    'sub_id BIGINT NOT NULL,' +
    'FOREIGN KEY sub_fkey (sub_id) REFERENCES subs(id),' +
    // Ranges of valid indices into the messages table.
    'start BIGINT NOT NULL,' +
    'end BIGINT NULL,' +
    // Preserve the original versions of the strings for display.
    'class VARBINARY(255) NOT NULL,' +
    'instance VARBINARY(255) NULL,' +
    'recipient VARBINARY(255) NULL' +
    ') ENGINE=InnoDB;',

  'CREATE TABLE messages (' +
    'id BIGINT AUTO_INCREMENT PRIMARY KEY,' +
    // Randomly generated public id. This is so we don't leak how many
    // messages are not visible.
    'msgid VARBINARY(255) UNIQUE NOT NULL,' +
    // Each message matches two subscriptions. The full one and the
    // wildcard one. We join against the subscriptions table to
    // query. I think the query itself wants to be a UNION. Seems
    // MySQL does a better job of using indexes in that case than with
    // an OR. In that case, the two queries should filter user_subs by
    // instance being and not being NULL. Hopefully MySQL can realize
    // that the non-wildcard half of the union is basically always
    // trivial.
    'wildcard_sub_id BIGINT NOT NULL,' +
    'FOREIGN KEY wildcard_fkey (wildcard_sub_id) REFERENCES subs(id),' +
    'sub_id BIGINT NOT NULL,' +
    'FOREIGN KEY sub_fkey (sub_id) REFERENCES subs(id),' +
    // Message fields. class, instance, etc. do NOT have NFKC applied
    // to them for display purpose.
    'class VARBINARY(255) NOT NULL,' +
    'instance VARBINARY(255) NOT NULL,' +
    'time DATETIME NOT NULL,' +
    'auth TINYINT NOT NULL,' +
    'sender VARBINARY(255) NOT NULL,' +
    'recipient VARBINARY(255) NOT NULL,' +
    'realm VARBINARY(255) NOT NULL,' +
    'opcode VARBINARY(255) NOT NULL,' +
    'signature VARBINARY(255) NOT NULL,' +
    'message BLOB NOT NULL' +
    ') ENGINE=InnoDB;',
];

exports.initTables = function() {
  var connection = mysql.createConnection(conf.get('db'));
  return schemas.reduce(function(soFar, schema) {
    return soFar.then(function() {
      console.log(schema);
      return Q.nfcall(connection.query.bind(connection), schema);
    });
  }, Q()).finally(function() {
    connection.end();
  });
};