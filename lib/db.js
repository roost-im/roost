var Buffer = require('buffer').Buffer;
var mysql = require('mysql');
var Q = require('q');
var util = require('util');
var zephyr = require('zephyr');

var conf = require('./config.js');
var Filter = require('./filter.js').Filter;

// Per vasilvv, use VARBINARY everywhere instead of VARCHAR. MySQL
// collations are sad.

// TODO: We probably can get away with significantly less isolated
// transactions here if it becomes a problem.

var schemas = [
  'CREATE TABLE users (' +
    'id INT AUTO_INCREMENT PRIMARY KEY,' +
    'principal VARBINARY(255) UNIQUE NOT NULL,' +
    'info BLOB NOT NULL,' +
    'info_version BIGINT NOT NULL' +
    ') ENGINE=InnoDB;',

  'CREATE TABLE subs (' +
    'id INT AUTO_INCREMENT PRIMARY KEY,' +
    'user_id INT NOT NULL,' +
    'FOREIGN KEY user_fkey (user_id) REFERENCES users(id),' +
    // Preserve the original versions of the strings for display.
    'class VARBINARY(255) NOT NULL,' +
    'instance VARBINARY(255) NOT NULL,' +
    'recipient VARBINARY(255) NOT NULL,' +
    // Downcased versions for querying.
    'class_key VARBINARY(255) NOT NULL,' +
    'instance_key VARBINARY(255) NULL,' +
    'UNIQUE query_triple (user_id, recipient, class_key, instance_key)' +
    ') ENGINE=InnoDB;',

  'CREATE TABLE messages (' +
    'id INT AUTO_INCREMENT PRIMARY KEY,' +
    // Message fields. Store both downcased and display versions of
    // class and instance.
    'class VARBINARY(255) NOT NULL,' +
    'instance VARBINARY(255) NOT NULL,' +
    'class_key VARBINARY(255) NOT NULL,' +
    'instance_key VARBINARY(255) NOT NULL,' +
    'class_key_base VARBINARY(255) NOT NULL,' +
    'instance_key_base VARBINARY(255) NOT NULL,' +
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
    // Empty string for non-personals. For incoming messages, it's the
    // same as sender. Outgoing, it's the same as recipient. When we
    // support CC'd messages, it'll be something like NUL-separated
    // sorted list of CC'd folks.
    'conversation VARBINARY(255) NOT NULL,' +
    // This really /should/ be redundant with recipient, but it isn't
    // because of outgoing mesages.
    'is_personal BOOLEAN NOT NULL,' +
    'is_outgoing BOOLEAN NOT NULL,' +
    'uid VARBINARY(16) NOT NULL,' +
    'opcode VARBINARY(255) NOT NULL,' +
    'signature VARBINARY(255) NOT NULL,' +
    'message BLOB NOT NULL,' +
    // For optimizing findByTime.
    'INDEX receive_time_idx (receive_time),' +
    // For filters.
    //
    // TODO(davidben): Currently just do the naive thing and add one
    // index for every interesting column. Better would be to build
    // some multi-key indices too. For instance, no one ever queries
    // instance without class.
    'INDEX class_key_idx (class_key, id),' +
    'INDEX class_key_base_idx (class_key_base, id),' +
    'INDEX instance_key_idx (instance_key, id),' +
    'INDEX instance_key_base_idx (instance_key_base, id),' +
    'INDEX conversation_idx (conversation, id),' +
    'INDEX recipient_idx (recipient, id),' +
    'INDEX sender_idx (sender, id),' +
    'INDEX is_personal_idx (is_personal, id)' +
    ') ENGINE=InnoDB;',

  // Note: look in git history for other scheme where adding a new
  // message inserted O(1) rows. Unfortunately, MySQL doesn't seem to
  // perform that query efficiently. This schema, on the other hand,
  // is trivial to use indices with.
  'CREATE TABLE user_messages (' +
    'user_id INT NOT NULL, ' +
    'message_id INT NOT NULL, ' +
    'PRIMARY KEY(user_id, message_id), ' +
    'FOREIGN KEY user_fkey (user_id) REFERENCES users(id), ' +
    'FOREIGN KEY message_fkey (message_id) REFERENCES messages(id) ' +
    ') ENGINE=InnoDB;',
];

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

var nextConnId = 1;
function Connection(connection) {
  this.id = nextConnId++;
  if (conf.get('debugSql'))
    console.log(this.id + ':  <created>');
  this.connection = connection;
};

Connection.prototype.end = function() {
  if (conf.get('debugSql'))
    console.log(this.id + ':  <ending>');
  this.connection.end();
  this.connection = null;
};

Connection.prototype.release = function() {
  if (conf.get('debugSql'))
    console.log(this.id + ':  <releasing>');
  this.connection.release();
  this.connection = null;
};

Connection.prototype.query = function(query, values) {
  // Q.ninvoke would do this, but it's annoying. Returns an array
  // because the callback has two result arguments.
  var deferred = Q.defer();
  // If a query takes too long, make noise.
  var queryTimeout = setTimeout(function() {
    queryTimeout = null;
    console.log(this.id + ': SLOW QUERY', queryObj.sql);
  }.bind(this), 1000);
  var queryObj = this.connection.query(query, values, function(err, result) {
    if (err) {
      deferred.reject(err);
    } else {
      deferred.fulfill(result);
    }

    if (queryTimeout != null) {
      clearTimeout(queryTimeout);
    } else {
      console.log(this.id + ': SLOW QUERY FINISHED');
    }
  }.bind(this));
  if (conf.get('debugSql'))
    console.log(this.id + ":  " + query);
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
    // There's no ROLLBACK to emit. The connection died.
    //
    // TODO(davidben): Aargh I hate duck-typing. Assume no other
    // exceptions have a fatal attribute.
    if (err.fatal)
      throw err;
    // TODO(davidben): Certainly non-database exceptions need a
    // ROLLBACK. What about non-fatal MySQL errors.
    return this.query('ROLLBACK').then(function() {
      throw err;
    });
  }.bind(this));
};

Connection.prototype.getUser = function(principal) {
  return this.query(
    'SELECT id, principal FROM users WHERE principal = ? LIMIT 1',
    [new Buffer(principal)]
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
  return this.getUser(principal).then(function(user) {
    if (user)
      return user;
    user = {
      principal: new Buffer(principal),
      info: new Buffer('{}'),
      info_version: 1
    };
    return this.query(
      'INSERT IGNORE INTO users SET ?', [user]
    ).then(function(result) {
      if (result.insertId) {
        return {
          id: result.insertId,
          principal: principal,
          newUser: true
        };
      }
      // We lost the race. Just go look it up.
      return this.getUser(principal);
    }.bind(this));
  }.bind(this));
};

Connection.prototype.getUserInfo = function(user) {
  return this.query(
    'SELECT info_version, info FROM users WHERE id = ? LIMIT 1', [user.id]
  ).then(function(rows) {
    return {
      version: rows[0].info_version,
      info: rows[0].info.toString('utf8')
    };
  }.bind(this));
};

Connection.prototype.updateUserInfo = function(user, info, expectedVersion) {
  return this.withTransaction(function() {
    return this.query(
      'SELECT info_version FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
      [user.id]
    ).then(function(rows) {
      var version = rows[0].info_version;
      if (version !== expectedVersion)
        return false;
      return this.query(
        'UPDATE users SET info_version = ?, info = ? WHERE id = ? LIMIT 1',
        [version + 1, new Buffer(info), user.id]
      ).then(function() {
        return true;
      });
    }.bind(this));
  }.bind(this));
};

Connection.prototype.addUserSubscriptions = function(user, subs) {
  var withKeys = subs.map(function(sub) {
    return {
      class: sub.class,
      classKey: zephyr.downcase(sub.class),
      instance: sub.instance,
      instanceKey: zephyr.downcase(sub.instance),
      recipient: sub.recipient
    };
  });

  var query = 'REPLACE INTO subs ' +
    '(user_id, class, instance, recipient, class_key, instance_key) ' +
    'VALUES ?';
  var rows = withKeys.map(function(sub) {
    return [
      user.id,
      new Buffer(sub.class),
      new Buffer(sub.instance),
      new Buffer(sub.recipient),
      new Buffer(sub.classKey),
      new Buffer(sub.instanceKey)
    ];
  });

  return this.query(query, [rows]).then(function(result) {
    return withKeys;
  });
};

Connection.prototype.removeUserSubscription = function(user, klass, inst, recip) {
  var klassKey = zephyr.downcase(klass);
  var instKey = zephyr.downcase(inst);

  var query = 'DELETE FROM subs WHERE user_id = ? AND ' +
    'class_key = ? AND instance_key = ? AND recipient = ?';
  var values = [user.id,
                new Buffer(klassKey), new Buffer(instKey), new Buffer(recip)];
  return this.query(query, values).then(function() {
    return {
      class: klass,
      classKey: klassKey,
      instance: inst,
      instanceKey: instKey,
      recipient: recip
    }
  });
};

Connection.prototype.getUserSubscriptions = function(user) {
  return this.query(
    'SELECT * FROM subs WHERE user_id = ?', [user.id]
  ).then(function(rows) {
    return rows.map(function(row) {
      return {
        class: row.class.toString('utf8'),
        classKey: row.class_key.toString('utf8'),
        instance: row.instance.toString('utf8'),
        instanceKey: row.instance_key.toString('utf8'),
        recipient: row.recipient.toString('utf8')
      };
    });
  });
};

Connection.prototype.getUserPrivateSubscriptions = function(user) {
  return this.query(
    'SELECT * FROM subs WHERE user_id = ? AND recipient = ?',
    [user.id, new Buffer(user.principal)]
  ).then(function(rows) {
    return rows.map(function(row) {
      return {
        class: row.class.toString('utf8'),
        classKey: row.class_key.toString('utf8'),
        instance: row.instance.toString('utf8'),
        instanceKey: row.instance_key.toString('utf8'),
        recipient: row.recipient.toString('utf8')
      };
    });
  });
};

Connection.prototype.getAllPublicSubscriptions = function() {
  return this.query(
    'SELECT DISTINCT subs.class_key, subs.instance_key, subs.recipient ' +
      'FROM subs ' +
      'WHERE recipient = "" OR LEFT(recipient, 1) = "@"'
  ).then(function(result) {
    return result.map(function(row) {
      return {
        classKey: row.class_key.toString('utf8'),
        instanceKey: row.instance_key.toString('utf8'),
        recipient: row.recipient.toString('utf8')
      };
    });
  }.bind(this));
};

Connection.prototype.getUsersForMessage = function(msg) {
  // Get the users that see this message.
  return this.query(
    'SELECT DISTINCT user_id FROM subs WHERE class_key = ? '+
      'AND recipient = ? ' +
      'AND (instance_key = "*" OR instance_key = ?)',
    [new Buffer(msg.classKey),
     new Buffer(msg.isOutgoing ? msg.sender : msg.recipient),
     new Buffer(msg.instanceKey)]
  ).then(function(rows) {
    return rows.map(function(row) { return row.user_id; });
  });
};

Connection.prototype.saveMessage = function(msg, userIds) {
  return this.withTransaction(function() {
    // Insert the message into the database.
    return this.query(
      'INSERT INTO messages SET ?',
      {
        id: msg.id,
        class: new Buffer(msg.class),
        instance: new Buffer(msg.instance),
        class_key: new Buffer(msg.classKey),
        instance_key: new Buffer(msg.instanceKey),
        class_key_base: new Buffer(msg.classKeyBase),
        instance_key_base: new Buffer(msg.instanceKeyBase),
        time: msg.time,
        receive_time: msg.receiveTime,
        auth: msg.auth,
        sender: new Buffer(msg.sender),
        recipient: new Buffer(msg.recipient),
        conversation: new Buffer(msg.conversation),
        is_personal: msg.isPersonal ? 1 : 0,
        is_outgoing: msg.isOutgoing ? 1 : 0,
        uid: new Buffer(msg.uid),
        opcode: new Buffer(msg.opcode),
        signature: new Buffer(msg.signature),
        message: new Buffer(msg.message),
      }
    ).then(function(result) {
      return this.query(
        'INSERT INTO user_messages (user_id, message_id) VALUES ?',
        [ userIds.map(function(userId) { return [userId, msg.id]; }) ]);
    }.bind(this));
  }.bind(this));
};

// TODO: Might want to support other queries? Yeah, I dunno.
Connection.prototype.getMessages = function(user, msgId, filter, opts) {
  var limit = opts.limit;
  var compare = opts.reverse ? '<' : '>';
  var sortOrder = opts.reverse ? 'DESC' : 'ASC';

  var filterStrs = [];
  var filterValues = [];
  Filter.FIELDS.forEach(function(field) {
    if (filter[field] == null)
      return;
    filterStrs.push('messages.' + field + ' = ?');
    if (field == 'is_personal') {
      filterValues.push(filter[field] ? 1 : 0);
    } else {
      filterValues.push(new Buffer(filter[field]));
    }
  });

  // This and messages.id should be identical, but EXPLAIN says MySQL
  // thinks otherwise? I don't know, but if we're filtering anywhere,
  // messages.id makes MySQL treat the messages table more
  // sensible. If we're not filtering, we want to start with
  // user_messages.
  var msgIdColumn = filterStrs.length ? 'messages.id' : 'user_messages.message_id';

  // Build a query.
  var queryStr =
    'SELECT messages.* ' +
    'FROM user_messages JOIN messages ON ' +
      'user_messages.message_id = messages.id ' +
    'WHERE user_messages.user_id = ?';
  var values = [user.id];
  if (msgId != null) {
    queryStr +=
      ' AND '+msgIdColumn+' ' + compare + ' ?';
    values.push(msgId);
  }
  if (filterStrs.length > 0) {
    queryStr += ' AND ' + filterStrs.join(' AND ');
    values = values.concat(filterValues);
  }

  queryStr +=
    ' ORDER BY '+msgIdColumn+' ' + sortOrder + ' ' +
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
        classKeyBase: row.class_key_base.toString('utf8'),
        instance: row.instance.toString('utf8'),
        instanceKey: row.instance_key.toString('utf8'),
        instanceKeyBase: row.instance_key_base.toString('utf8'),
        sender: row.sender.toString('utf8'),
        recipient: row.recipient.toString('utf8'),
        conversation: row.conversation.toString('utf8'),
        isPersonal: row.is_personal != 0,
        isOutgoing: row.is_outgoing != 0,
        auth: row.auth,
        uid: row.uid.toString('utf8'),
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

Connection.prototype.findByTime = function(user, time) {
  // Return the message id of the first message visible to |user|
  // received after |time|. null if time is after the last message.
  return this.withTransaction(function() {
    // First find the first message id globally.
    return this.query(
      'SELECT id FROM messages WHERE receive_time >= ? ' +
        // ORDER BY id and ORDER BY receive_time are the same, but
        // MySQL doesn't know that. Use receive_time so that we use
        // the right index.
        'ORDER BY receive_time LIMIT 1',
      [time]
    ).then(function(rows) {
      if (rows.length == 0)
        return null;
      // Now zoom forward to one the user can see.
      return this.query(
        'SELECT message_id FROM user_messages ' +
          'WHERE user_id = ? AND message_id >= ? ' +
          'ORDER BY message_id LIMIT 1',
        [user.id, rows[0].id]
      ).then(function(rows) {
        return (rows.length > 0) ? rows[0].message_id : null;
      });
    }.bind(this));
  }.bind(this));
};

Connection.prototype.getNextMessageId = function() {
  return this.query(
    'SELECT id FROM messages ORDER BY id DESC LIMIT 1'
  ).then(function(rows) {
    return rows.length ? rows[0].id + 1 : 1;
  });
};

exports.createPool = function() {
  var pool = mysql.createPool(conf.get('db'));
  return {
    getConnection: function() {
      return Q.ninvoke(pool, 'getConnection').then(function(conn) {
        return new Connection(conn);
      });
    }
  };
};

var pool = exports.createPool();
var writePool = exports.createPool();

exports.createConnection = function() {
  return new Connection(mysql.createConnection(conf.get('db')));
};

exports.getUser = function(principal) {
  return pool.getConnection().then(function(conn) {
    return conn.getUser(principal).finally(conn.release.bind(conn));
  });
};

exports.getOrCreateUser = function(principal) {
  return writePool.getConnection().then(function(conn) {
    return conn.getOrCreateUser(principal).finally(conn.release.bind(conn));
  });
};

exports.getUserInfo = function(user) {
  return pool.getConnection().then(function(conn) {
    return conn.getUserInfo(user).finally(conn.release.bind(conn));
  });
};

exports.updateUserInfo = function(user, info, expectedVersion) {
  return writePool.getConnection().then(function(conn) {
    return conn.updateUserInfo(user, info, expectedVersion).finally(
      conn.release.bind(conn));
  });
};

exports.addUserSubscriptions = function(user, klass, inst, recip) {
  return writePool.getConnection().then(function(conn) {
    return conn.addUserSubscriptions(user, klass, inst, recip).finally(
      conn.release.bind(conn));
  });
};

exports.removeUserSubscription = function(user, klass, inst, recip) {
  return writePool.getConnection().then(function(conn) {
    return conn.removeUserSubscription(user, klass, inst, recip).finally(
      conn.release.bind(conn));
  });
};

exports.getUserSubscriptions = function(user) {
  return pool.getConnection().then(function(conn) {
    return conn.getUserSubscriptions(user).finally(conn.release.bind(conn));
  });
};

exports.getUserPrivateSubscriptions = function(user) {
  return pool.getConnection().then(function(conn) {
    return conn.getUserPrivateSubscriptions(user).finally(
      conn.release.bind(conn));
  });
};

exports.getAllPublicSubscriptions = function() {
  return pool.getConnection().then(function(conn) {
    return conn.getAllPublicSubscriptions().finally(conn.release.bind(conn));
  });
};

exports.getUsersForMessage = function(msg) {
  return pool.getConnection().then(function(conn) {
    return conn.getUsersForMessage(msg).finally(conn.release.bind(conn));
  });
};

exports.saveMessage = function(msg, userIds) {
  return writePool.getConnection().then(function(conn) {
    return conn.saveMessage(msg, userIds).finally(conn.release.bind(conn));
  });
};

exports.getMessages = function(user, msgId, filter, opts) {
  return pool.getConnection().then(function(conn) {
    return conn.getMessages(user, msgId, filter, opts).finally(
      conn.release.bind(conn));
  });
};

exports.findByTime = function(user, time) {
  return pool.getConnection().then(function(conn) {
    return conn.findByTime(user, time).finally(conn.release.bind(conn));
  });
};

exports.getNextMessageId = function() {
  return pool.getConnection().then(function(conn) {
    return conn.getNextMessageId().finally(conn.release.bind(conn));
  });
};
