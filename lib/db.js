var mysql = require('mysql');
var Q = require('q');
var zephyr = require('zephyr');

var conf = require('./config.js');

// Per vasilvv, use VARBINARY everywhere instead of VARCHAR. MySQL
// collations are sad.

// TODO: We probably can get away with significantly less isolated
// transactions here if it becomes a problem. Potentially worthwhile
// assumptions/benign races.
//
// - entries in subs table are never deleted.
// - subscription/message-insert races can resolve either way.

var schemas = [
  'CREATE TABLE users (' +
    'id BIGINT AUTO_INCREMENT PRIMARY KEY,' +
    'username VARBINARY(255) UNIQUE NOT NULL' +
    ') ENGINE=InnoDB;',

  'CREATE TABLE subs (' +
    'id BIGINT AUTO_INCREMENT PRIMARY KEY,' +
    // Class/inst are post NFKC and casefolding.
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
    // Message fields. class and instance are not normalized them for
    // display purposes.
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

  // HACK: Until we actually get users and stuff.
  'INSERT INTO users (username) VALUES ("davidben@ATHENA.MIT.EDU")',
];

var pool = mysql.createPool(conf.get('db'));

exports.initTables = function() {
  var connection = mysql.createConnection(conf.get('db'));
  return schemas.reduce(function(soFar, schema) {
    return soFar.then(function() {
      console.log(schema);
      return Q.ninvoke(connection, 'query', schema);
    });
  }, Q()).finally(function() {
    connection.end();
  });
};

function Connection(connection) {
  this.connection = connection;
};

Connection.prototype.end = function() {
  this.connection.end();
  this.connection = null;
};

Connection.prototype.query = function(query, values) {
  // Q.ninvoke would do this, but it's annoying. Returns an array
  // because the callback has two result arguments.
  var deferred = Q.defer();
  var queryObj = this.connection.query(query, values, function(err, result) {
    if (err) {
      deferred.reject(err);
    } else {
      deferred.fulfill(result);
    }
  });
  console.log(queryObj.sql);
  return deferred.promise;
};

Connection.prototype.withTransaction = function(operation) {
  return this.query('START TRANSACTION').then(function() {
    return operation();
  }).then(function(ret) {
    return this.query('COMMIT').then(function() {
      return ret;
    }.bind(this));
  }.bind(this), function(err) {
    return this.query('ROLLBACK').then(function() {
      throw err;
    });
  }.bind(this));
};

Connection.prototype._findSubscription = function(klass, inst, recip) {
  klass = zephyr.downcase(klass);
  if (inst !== null)
    inst = zephyr.downcase(inst);
  // Pretty sure this is unnecessary, but meh.
  recip = recip.replace('\0', '\ufffd');

  // Blegh. Equality and NULL. Obnoxious.
  return this.query('SELECT id FROM subs WHERE ' +
                   'class = ? AND instance <=> ? AND recipient = ?',
                   [klass, inst, recip]).then(function(rows) {
    if (rows.length === 0)
      return null;
    return rows[0].id;
  });
};

Connection.prototype._findOrInsertSubscription = function(klass, inst, recip) {
  klass = zephyr.downcase(klass);
  if (inst !== null)
    inst = zephyr.downcase(inst);
  // Pretty sure this is unnecessary, but meh.
  recip = recip.replace('\0', '\ufffd');

  return this._findSubscription(klass, inst, recip).then(function(id) {
    if (id != null)
      return id;
    // Insert it.
    return this.query('INSERT INTO subs SET ?', [{
      class: klass,
      instance: inst,
      recipient: recip
    }]).then(function(result) {
      return result.insertId;
    });
  }.bind(this));
};

Connection.prototype.saveMessage = function(msg) {
  throw "Not implemented";
};

Connection.prototype.addUserSubscription = function(user, klass, inst, recip) {
  return this.withTransaction(function() {
    return this._findOrInsertSubscription(
      klass, inst, recip
    ).then(function(subId) {
      // First, see if there is already an active subscription.
      return this.query(
        'SELECT COUNT(*) AS count FROM user_subs ' +
          'WHERE user_id = ? AND sub_id = ? AND end IS NULL',
        [user, subId]
      ).then(function(result) {
        // If we already have an active subscription, no need to do anything.
        if (result[0].count > 0)
          return;

        // Find out the id of the latest message.
        return this.query(
          'SELECT id FROM messages ORDER BY id DESC LIMIT 1'
        ).then(function(result) {
          var start = (result.length > 0) ? (result[0].id + 1) : 0;
          var userSub = {
            user_id: user,
            sub_id: subId,
            start: start,
            end: null,
            class: klass,
            instance: inst,
            recipient: recip
          };
          return this.query('INSERT INTO user_subs SET ?', userSub);
        }.bind(this));
      }.bind(this));
    }.bind(this));
  }.bind(this));
};

Connection.prototype.removeUserSubscription = function(user, klass, inst, recip) {
  throw "Not implemented";
};

exports.getConnection = function() {
  return Q.ninvoke(pool, 'getConnection').then(function(conn) {
    return new Connection(conn);
  });
};
