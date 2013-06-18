var Buffer = require('buffer').Buffer;
var mysql = require('mysql');
var Q = require('q');
var zephyr = require('zephyr');

var conf = require('./config.js');

var MAX_MESSAGES_RETURNED = 100;

// Per vasilvv, use VARBINARY everywhere instead of VARCHAR. MySQL
// collations are sad.

// TODO: We probably can get away with significantly less isolated
// transactions here if it becomes a problem.

var schemas = [
  'CREATE TABLE users (' +
    'id BIGINT AUTO_INCREMENT PRIMARY KEY,' +
    'principal VARBINARY(255) UNIQUE NOT NULL' +
    ') ENGINE=InnoDB;',

  'CREATE TABLE subs (' +
    'id BIGINT AUTO_INCREMENT PRIMARY KEY,' +
    'user_id BIGINT NOT NULL,' +
    'FOREIGN KEY user_fkey (user_id) REFERENCES users(id),' +
    // Preserve the original versions of the strings for display.
    'class VARBINARY(255) NOT NULL,' +
    'instance VARBINARY(255) NULL,' +
    'recipient VARBINARY(255) NULL,' +
    // Downcased versions for querying.
    'class_key VARBINARY(255) NOT NULL,' +
    'instance_key VARBINARY(255) NULL,' +
    'UNIQUE query_triple (user_id, recipient, class_key, instance_key)' +
    ') ENGINE=InnoDB;',

  'CREATE TABLE messages (' +
    'id BIGINT AUTO_INCREMENT PRIMARY KEY,' +
    // Message fields. Store both downcased and display versions of
    // class and instance.
    'class VARBINARY(255) NOT NULL,' +
    'instance VARBINARY(255) NOT NULL,' +
    'class_key VARBINARY(255) NOT NULL,' +
    'instance_key VARBINARY(255) NOT NULL,' +
    // Stores the number of milliseconds past the Unix epoch,
    // i.e. what Date.prototype.getTime spits out. Technically zephyr
    // gives you microsecond resolution, but I don't think V8 gives
    // you more than millisecond resolution anyway.
    'time BIGINT NOT NULL,' +
    // Distinguish time in the message from the time we received it;
    // if the time is bogus, we can display in the UI. Also we should
    // use our time when jumping the cursor to a date. At least it can
    // be sorted and stuff.
    'receive_time BIGINT NOT NULL,' +
    'auth TINYINT NOT NULL,' +
    'sender VARBINARY(255) NOT NULL,' +
    'recipient VARBINARY(255) NOT NULL,' +
    // TODO(davidben): Don't really need to store this one...
    'realm VARBINARY(255) NOT NULL,' +
    'opcode VARBINARY(255) NOT NULL,' +
    'signature VARBINARY(255) NOT NULL,' +
    'message BLOB NOT NULL' +
    ') ENGINE=InnoDB;',

  // Note: look in git history for other scheme where adding a new
  // message inserted O(1) rows. Unfortunately, MySQL doesn't seem to
  // perform that query efficiently. This schema, on the other hand,
  // is trivial to use indices with.
  'CREATE TABLE user_messages (' +
    'user_id BIGINT NOT NULL REFERENCES users, ' +
    'message_id BIGINT NOT NULL REFERENCES messages, ' +
    'PRIMARY KEY(user_id, message_id) ' +
    ') ENGINE=InnoDB;',

  // HACK: Until we actually get users and stuff.
  'INSERT INTO users (principal) VALUES ("davidben@ATHENA.MIT.EDU")',
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

Connection.prototype.getUser = function(principal) {
  return this.query(
    'SELECT id, principal FROM users WHERE principal = ?', [principal]
  ).then(function(rows) {
    if (!rows.length)
      return null;
    return {
      id: rows[0].id,
      principal: rows[0].principal.toString('utf8')
    };
  });
};

Connection.prototype.getOrCreateUser = function(principal) {
  return this.withTransaction(function() {
    return this.query(
      'SELECT id, principal FROM users WHERE principal = ?', [principal]
    ).then(function(rows) {
      if (rows.length) {
        return {
          id: rows[0].id,
          principal: rows[0].principal.toString('utf8')
        };
      }
      var user = { principal: principal };
      return this.query(
        'INSERT INTO users SET ?', [user]
      ).then(function(result) {
        return {
          id: result.insertId,
          principal: principal,
          newUser: true
        };
      }.bind(this));
    }.bind(this));
  }.bind(this));
};

Connection.prototype.addUserSubscription = function(user, klass, inst, recip) {
  var klassKey = zephyr.downcase(klass);
  var instKey = (inst === null) ? null : zephyr.downcase(inst);

  // Would be nice to use ON DUPLICATE KEY, but MySQL's UNIQUE
  // constraints and NULL values are dumb.
  return this.withTransaction(function() {
    var query = 'SELECT COUNT(*) AS count FROM subs WHERE user_id = ? AND ' +
      'class_key = ? AND recipient = ?';
    var values = [user.id, new Buffer(klassKey), new Buffer(recip)];
    if (instKey === null) {
      query += ' AND instance_key IS NULL';
    } else {
      query += ' AND instance_key = ?';
      values.push(new Buffer(instKey));
    }
    return this.query(query, values).then(function(result) {
      // Already subscribed.
      if (result[0].count > 0)
        return false;

      var sub = {
        user_id: user.id,
        class: new Buffer(klass),
        instance: toBufferOrNull(inst),
        recipient: new Buffer(recip),
        class_key: new Buffer(klassKey),
        instance_key: toBufferOrNull(instKey)
      };
      return this.query('INSERT INTO subs SET ?', [sub]).then(function() {
        return true;
      });
    }.bind(this)).then(function(newSubscription) {
      return {
        class: klass,
        instance: inst,
        recipient: recip,
        classKey: klassKey,
        instanceKey: instKey,
        newSubscription: newSubscription
      };
    });
  }.bind(this));
};

Connection.prototype.removeUserSubscription = function(user, klass, inst, recip) {
  var klassKey = zephyr.downcase(klass);
  var instKey = (inst === null) ? null : zephyr.downcase(inst);

  var query = 'DELETE FROM subs WHERE user_id = ? AND ' +
    'class_key = ? AND recipient = ?';
  var values = [user.id, new Buffer(klassKey), new Buffer(recip)];
  if (instKey === null) {
    query += ' AND instance_key IS NULL';
  } else {
    query += ' AND instance_key = ?';
    values.push(new Buffer(instKey));
  }
  return this.query(query, values);
};

Connection.prototype.getUserSubscriptions = function(user) {
  return this.query(
    'SELECT * FROM subs WHERE user_id = ?', [user.id]
  ).then(function(rows) {
    return rows.map(function(row) {
      return {
        class: row.class.toString('utf8'),
        classKey: row.class_key.toString('utf8'),
        instance: row.instance == null ? null : row.instance.toString('utf8'),
        instanceKey: (row.instance_key == null ?
                      null :
                      row.instance_key.toString('utf8')),
        recipient: row.recipient.toString('utf8')
      };
    });
  });
};

Connection.prototype.getUserPrivateSubscriptions = function(user) {
  return this.query(
    'SELECT * FROM subs WHERE user_id = ? AND recipient = ?',
    [user.id, user.principal]
  ).then(function(rows) {
    return rows.map(function(row) {
      return {
        class: row.class.toString('utf8'),
        classKey: row.class_key.toString('utf8'),
        instance: row.instance == null ? null : row.instance.toString('utf8'),
        instanceKey: (row.instance_key == null ?
                      null :
                      row.instance_key.toString('utf8')),
        recipient: row.recipient.toString('utf8')
      };
    });
  });
};

Connection.prototype.getAllPublicSubscriptions = function() {
  return this.query(
    'SELECT DISTINCT subs.class_key, subs.instance_key, subs.recipient ' +
      'FROM subs WHERE instance_key IS NOT NULL AND ' +
      '(recipient = "" OR LEFT(recipient, 1) = "@")'
  ).then(function(result) {
    // Query wildcard subscriptions separately; otherwise SQL doesn't
    // SELECT DISTINCT the NULLs right.
    return this.query(
      'SELECT DISTINCT subs.class_key, subs.recipient ' +
        'FROM subs WHERE instance_key IS NULL AND ' +
        '(recipient = "" OR LEFT(recipient, 1) = "@")'
    ).then(function(wildcardResult) {
      return wildcardResult.concat(result).map(function(row) {
        return {
          classKey: row.class_key.toString('utf8'),
          instanceKey: row.instance_key ? row.instance_key.toString('utf8') : null,
          recipient: row.recipient.toString('utf8')
        };
      });
    });
  }.bind(this));
};

Connection.prototype.saveMessage = function(msg) {
  // TODO(davidben): Ideally this would be done with an
  // INSERT..SELECT, but I want to return the user ids that see it, so
  // we resolve races between sub/unsub and receiving messages
  // consistently.
  return this.withTransaction(function() {
    // Get the users that see this message.
    return this.query(
      'SELECT DISTINCT user_id FROM subs WHERE class_key = ? '+
        'AND recipient = ? ' +
        'AND (instance_key IS NULL OR instance_key = ?)',
      [new Buffer(msg.classKey),
       new Buffer(msg.recipient),
       new Buffer(msg.instanceKey)]
    ).then(function(rows) {
      var userIds = rows.map(function(row) { return row.user_id; });
      // We didn't save the message.
      if (userIds.length == 0)
        return null;

      // Insert the message into the database.
      return this.query(
        'INSERT INTO messages SET ?',
        {
          class: new Buffer(msg.class),
          instance: new Buffer(msg.instance),
          class_key: new Buffer(msg.classKey),
          instance_key: new Buffer(msg.instanceKey),
          time: msg.time,
          receive_time: msg.receiveTime,
          auth: msg.auth,
          sender: new Buffer(msg.sender),
          recipient: new Buffer(msg.recipient),
          realm: new Buffer(msg.realm),
          opcode: new Buffer(msg.opcode),
          signature: new Buffer(msg.signature),
          message: new Buffer(msg.message),
        }
      ).then(function(result) {
        var id = result.insertId;
        var query = 'INSERT INTO user_messages (user_id, message_id) VALUES';
        var values = [];
        // Bleegh.
        for (var i = 0; i < userIds.length; i++) {
          if (i > 0)
            query += ',';
          query += ' (?, ?)';
          values.push(userIds[i], result.insertId);
        }
        return this.query(query, values).then(function() {
          return {
            id: id,
            userIds: userIds,
          };
        });
      }.bind(this));
    }.bind(this));
  }.bind(this));
};

// TODO: Might want to support other queries? Yeah, I dunno.
Connection.prototype.getMessages = function(user, msgId, opts) {
  // For sanity, pick a random limit.
  var limit = Math.min(opts.limit|0, MAX_MESSAGES_RETURNED);
  var compare = (opts.reverse ? '<' : '>') +
    (opts.inclusive ? '=' : '');
  var sortOrder = opts.reverse ? 'DESC' : 'ASC';

  // Build a query.
  var queryStr =
    'SELECT messages.* ' +
    'FROM user_messages JOIN messages ON ' +
      'user_messages.message_id = messages.id ' +
    'WHERE user_messages.user_id = ? ';
  var values = [user.id];
  if (msgId != null) {
    queryStr +=
      'AND user_messages.message_id ' + compare + ' ? ';
    values.push(msgId);
  }
  queryStr +=
    'ORDER BY user_messages.message_id ' + sortOrder + ' ' +
    'LIMIT ?';
  values.push(limit);

  return this.query(queryStr, values).then(function(rows) {
    var messages = rows.map(function(row) {
      return {
        id: row.id,
        time: row.time,
        receiveTime: row.receive_time,
        class: row.class.toString('utf8'),
        classKey: row.class_key.toString('utf8'),
        instance: row.instance.toString('utf8'),
        instanceKey: row.instance_key.toString('utf8'),
        sender: row.sender.toString('utf8'),
        recipient: row.recipient.toString('utf8'),
        realm: row.realm.toString('utf8'),
        auth: row.auth,
        opcode: row.opcode.toString('utf8'),
        signature: row.signature.toString('utf8'),
        message: row.message.toString('utf8')
      };
    });
    return {
      messages: messages,
      isDone: messages.length < limit
    };
  });
};

var getPoolConnection = function() {
  return Q.ninvoke(pool, 'getConnection').then(function(conn) {
    return new Connection(conn);
  });
};

exports.createConnection = function() {
  return new Connection(mysql.createConnection(conf.get('db')));
};

exports.getUser = function(principal) {
  return getPoolConnection().then(function(conn) {
    return conn.getUser(principal).finally(conn.end.bind(conn));
  });
};

exports.getOrCreateUser = function(principal) {
  return getPoolConnection().then(function(conn) {
    return conn.getOrCreateUser(principal).finally(conn.end.bind(conn));
  });
};

exports.addUserSubscription = function(user, klass, inst, recip) {
  return getPoolConnection().then(function(conn) {
    return conn.addUserSubscription(user, klass, inst, recip).finally(
      conn.end.bind(conn));
  });
};

exports.removeUserSubscription = function(user, klass, inst, recip) {
  return getPoolConnection().then(function(conn) {
    return conn.removeUserSubscription(user, klass, inst, recip).finally(
      conn.end.bind(conn));
  });
};

exports.getUserSubscriptions = function(user) {
  return getPoolConnection().then(function(conn) {
    return conn.getUserSubscriptions(user).finally(conn.end.bind(conn));
  });
};

exports.getUserPrivateSubscriptions = function(user) {
  return getPoolConnection().then(function(conn) {
    return conn.getUserPrivateSubscriptions(user).finally(conn.end.bind(conn));
  });
};

exports.getAllPublicSubscriptions = function() {
  return getPoolConnection().then(function(conn) {
    return conn.getAllPublicSubscriptions().finally(conn.end.bind(conn));
  });
};

exports.saveMessage = function(msg) {
  return getPoolConnection().then(function(conn) {
    return conn.saveMessage(msg).finally(conn.end.bind(conn));
  });
};

exports.getMessages = function(user, msgId, opts) {
  return getPoolConnection().then(function(conn) {
    return conn.getMessages(user, msgId, opts).finally(conn.end.bind(conn));
  });
};
