var Buffer = require('buffer').Buffer;
var mysql = require('mysql');
var Q = require('q');
var zephyr = require('zephyr');

var conf = require('./config.js');

var MAX_MESSAGES_RETURNED = 100;

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
/*
    // Randomly generated public id. This is so we don't leak how many
    // messages are not visible.
    'msgid VARBINARY(255) UNIQUE NOT NULL,' +
*/
    // Each message matches two subscriptions. The full one and the
    // wildcard one. We join against the subscriptions table to
    // query. I think the query itself wants to be a UNION. Seems
    // MySQL does a better job of using indexes in that case than with
    // an OR. In that case, the two queries should filter user_subs by
    // instance being and not being NULL. Hopefully MySQL can realize
    // that the non-wildcard half of the union is basically always
    // trivial.
    'wildcard_sub_id BIGINT NULL,' +
    'FOREIGN KEY wildcard_fkey (wildcard_sub_id) REFERENCES subs(id),' +
    'sub_id BIGINT NULL,' +
    'FOREIGN KEY sub_fkey (sub_id) REFERENCES subs(id),' +
    // Message fields. class and instance are not normalized them for
    // display purposes.
    'class VARBINARY(255) NOT NULL,' +
    'instance VARBINARY(255) NOT NULL,' +
    // Stores the number of milliseconds past the Unix epoch,
    // i.e. what Date.prototype.getTime spits out. Technically zephyr
    // gives you microsecond resolution, but I don't think V8 gives
    // you more than millisecond resolution anyway.
    'time BIGINT NOT NULL,' +
    'auth TINYINT NOT NULL,' +
    'sender VARBINARY(255) NOT NULL,' +
    'recipient VARBINARY(255) NOT NULL,' +
    // TODO(davidben): Don't really need to store this one...
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

function toBufferOrNull(arg) {
  if (arg === null)
    return null;
  return new Buffer(arg);
}

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

Connection.prototype._nextMessageId = function() {
  return this.query(
    'SELECT id FROM messages ORDER BY id DESC LIMIT 1'
  ).then(function(result) {
    return (result.length > 0) ? (result[0].id + 1) : 1;
  });
};

Connection.prototype._findSubscription = function(klass, inst, recip) {
  klass = zephyr.downcase(klass);
  if (inst !== null)
    inst = zephyr.downcase(inst);
  // Pretty sure this is unnecessary, but meh.
  recip = recip.replace('\0', '\ufffd');

  // Blegh. Equality and NULL. Obnoxious.
  return this.query(
    'SELECT id FROM subs WHERE ' +
      'class = ? AND instance <=> ? AND recipient = ?',
    [new Buffer(klass), toBufferOrNull(inst), new Buffer(recip)]
  ).then(function(rows) {
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
      class: new Buffer(klass),
      instance: toBufferOrNull(inst),
      recipient: new Buffer(recip)
    }]).then(function(result) {
      return result.insertId;
    });
  }.bind(this));
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
        return this._nextMessageId().then(function(start) {
          var userSub = {
            user_id: user,
            sub_id: subId,
            start: start,
            end: null,
            class: new Buffer(klass),
            instance: toBufferOrNull(inst),
            recipient: new Buffer(recip)
          };
          return this.query('INSERT INTO user_subs SET ?', userSub);
        }.bind(this));
      }.bind(this));
    }.bind(this));
  }.bind(this));
};

Connection.prototype.removeUserSubscription = function(user, klass, inst, recip) {
  // TODO(davidben): Prune user_subs entries that never matched anything.
  return this.withTransaction(function() {
    return this._findSubscription(
      klass, inst, recip
    ).then(function(subId) {
      if (subId == null)
        return;
      return this._nextMessageId().then(function(end) {
        return this.query(
          'UPDATE user_subs SET end = ? ' +
            'WHERE user_id = ? AND sub_id = ? AND end IS NULL',
          [end, user, subId]
        );
      }.bind(this));
    }.bind(this));
  }.bind(this));
};

Connection.prototype.getUserSubscriptions = function(user) {
  return this.query(
    'SELECT class, instance, recipient FROM user_subs ' +
      'WHERE user_id = ? AND end IS NULL',
    [user]
  ).then(function(rows) {
    return rows.map(function(row) {
      return [
        row.class.toString('utf8'),
        row.instance == null ? null : row.instance.toString('utf8'),
        row.recipient
      ];
    });
  });
};

Connection.prototype.loadActiveSubs = function() {
  return this.query(
    'SELECT DISTINCT subs.class, subs.instance, subs.recipient ' +
      'FROM subs INNER JOIN user_subs ON subs.id = user_subs.sub_id ' +
      'WHERE user_subs.end IS NULL'
  ).then(function(result) {
    return result.map(function(row) {
      return [row.class.toString('utf8'),
              row.instance ? row.instance.toString('utf8') : null,
              row.recipient.toString('utf8')];
    });
  });
};

Connection.prototype.saveMessage = function(msg) {
  return this.withTransaction(function() {
    // First, get the subscription IDs.
    return this._findSubscription(
      msg.class, msg.instance, msg.recipient
    ).then(function(subId) {
      return this._findSubscription(
        msg.class, null, msg.recipient
      ).then(function(wildcardId) {
        return [subId, wildcardId];
      });
    }.bind(this)).then(function(subs) {
      // If this message matches nothing, just throw it away.
      var subId = subs[0], wildcardId = subs[1];
      if (subId == null && wildcardId == null)
        return;
      return this.query('INSERT INTO messages SET ?',
                        {
                          // msgid: FIXME,
                          wildcard_sub_id: wildcardId,
                          sub_id: subId,
                          class: new Buffer(msg.class),
                          instance: new Buffer(msg.instance),
                          time: msg.time,
                          auth: msg.auth,
                          sender: new Buffer(msg.sender),
                          recipient: new Buffer(msg.recipient),
                          realm: new Buffer(msg.realm),
                          opcode: new Buffer(msg.opcode),
                          signature: new Buffer(msg.signature),
                          message: new Buffer(msg.message),
                        });
    }.bind(this));
  }.bind(this));
};

// TODO: Might want to support other queries? Yeah, I dunno.
Connection.prototype.getMessagesAfter = function(user, msgId, limit) {
  // For sanity, pick a random limit.
  limit = Math.min(limit, MAX_MESSAGES_RETURNED);

  return this.query(
    '(SELECT messages.* ' +
     'FROM user_subs JOIN messages ON ' +
       'user_subs.sub_id = messages.sub_id ' +
     'WHERE user_subs.user_id = ? AND ' +
       'messages.id >= ? AND ' +
       'messages.id >= user_subs.start AND ' +
       '(user_subs.end IS NULL OR messages.id < user_subs.end) ' +
     'ORDER BY id ASC LIMIT ?) ' +
    'UNION ' +
    '(SELECT messages.* ' +
     'FROM user_subs JOIN messages ON ' +
       'user_subs.sub_id = messages.wildcard_sub_id ' +
     'WHERE user_subs.user_id = ? AND ' +
       'messages.id >= ? AND ' +
       'messages.id >= user_subs.start AND ' +
       '(user_subs.end IS NULL OR messages.id < user_subs.end) ' +
     'ORDER BY id ASC LIMIT ?) ' +
    'ORDER BY id ASC ' +
    'LIMIT ?',
    [user, msgId, limit, user, msgId, limit, limit]
  ).then(function(rows) {
    return rows.map(function(row) {
      return {
        id: row.id, // FIXME: opaque ids.
        time: row.time,
        class: row.class.toString('utf8'),
        instance: row.instance.toString('utf8'),
        sender: row.sender.toString('utf8'),
        recipient: row.recipient.toString('utf8'),
        realm: row.realm.toString('utf8'),
        auth: row.auth,
        opcode: row.opcode.toString('utf8'),
        signature: row.signature.toString('utf8'),
        message: row.message.toString('utf8')
      };
    });
  });
};

var getConnection = function() {
  return Q.ninvoke(pool, 'getConnection').then(function(conn) {
    return new Connection(conn);
  });
};

exports.addUserSubscription = function(user, klass, inst, recip) {
  return getConnection().then(function(conn) {
    return conn.addUserSubscription(user, klass, inst, recip).finally(
      conn.end.bind(conn));
  });
};

exports.removeUserSubscription = function(user, klass, inst, recip) {
  return getConnection().then(function(conn) {
    return conn.removeUserSubscription(user, klass, inst, recip).finally(
      conn.end.bind(conn));
  });
};

exports.getUserSubscriptions = function(user) {
  return getConnection().then(function(conn) {
    return conn.getUserSubscriptions(user).finally(conn.end.bind(conn));
  });
};

exports.loadActiveSubs = function() {
  return getConnection().then(function(conn) {
    return conn.loadActiveSubs().finally(conn.end.bind(conn));
  });
};

exports.saveMessage = function(msg) {
  return getConnection().then(function(conn) {
    return conn.saveMessage(msg).finally(conn.end.bind(conn));
  });
};

exports.getMessagesAfter = function(user, msgId, limit) {
  return getConnection().then(function(conn) {
    return conn.getMessagesAfter(user, msgId, limit).finally(conn.end.bind(conn));
  });
};
