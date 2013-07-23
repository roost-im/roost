var Buffer = require('buffer').Buffer;
var events = require('events');
var mysql = require('mysql');
var Q = require('q');
var util = require('util');
var zephyr = require('zephyr');

var conf = require('./config.js');
var Filter = require('./filter.js').Filter;

var MAX_MESSAGES_RETURNED = 100;

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

var nextConnId = 1;
function Connection(connection) {
  events.EventEmitter.call(this)
  this.id = nextConnId++;
  console.log(this.id + ':  <created>');
  this.connection = connection;
  this.onErrorCb_ = function(err) {
    this.emit('error', err);
  }.bind(this);
  this.onEndCb_ = function() {
    this.emit('end');
  }.bind(this);

  this.connection.on('error', this.onErrorCb_);
  this.connection.on('end', this.onEndCb_);
};
util.inherits(Connection, events.EventEmitter);

Connection.prototype.end = function() {
  console.log(this.id + ':  <ending>');
  this.connection.removeListener('error', this.onErrorCb_);
  this.connection.removeListener('end', this.onEndCb_);
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
  console.log(this.id + ":  " + queryObj.sql);
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
    [user.id, user.principal]
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
        'AND (instance_key = "*" OR instance_key = ?)',
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
          opcode: new Buffer(msg.opcode),
          signature: new Buffer(msg.signature),
          message: new Buffer(msg.message),
        }
      ).then(function(result) {
        var id = result.insertId;
        var query = 'INSERT INTO user_messages (user_id, message_id) VALUES ?';
        var rows = userIds.map(function(userId) {
          return [userId, result.insertId];
        });
        return this.query(query, [rows]).then(function() {
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
Connection.prototype.getMessages = function(user, msgId, filter, opts) {
  // For sanity, pick a random limit.
  var limit = Math.min(opts.limit|0, MAX_MESSAGES_RETURNED);
  var compare = (opts.reverse ? '<' : '>') + (opts.inclusive ? '=' : '');
  var sortOrder = opts.reverse ? 'DESC' : 'ASC';

  var filterStrs = [];
  var filterValues = [];
  Filter.FIELDS.forEach(function(field) {
    if (filter[field] == null)
      return;
    filterStrs.push('messages.' + field + ' = ?');
    filterValues.push(new Buffer(filter[field]));
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

exports.getUserInfo = function(user) {
  return getPoolConnection().then(function(conn) {
    return conn.getUserInfo(user).finally(conn.end.bind(conn));
  });
};

exports.updateUserInfo = function(user, info, expectedVersion) {
  return getPoolConnection().then(function(conn) {
    return conn.updateUserInfo(user, info, expectedVersion).finally(
      conn.end.bind(conn));
  });
};

exports.addUserSubscriptions = function(user, klass, inst, recip) {
  return getPoolConnection().then(function(conn) {
    return conn.addUserSubscriptions(user, klass, inst, recip).finally(
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

exports.getMessages = function(user, msgId, filter, opts) {
  return getPoolConnection().then(function(conn) {
    return conn.getMessages(user, msgId, filter, opts).finally(
      conn.end.bind(conn));
  });
};

exports.findByTime = function(user, time) {
  return getPoolConnection().then(function(conn) {
    return conn.findByTime(user, time).finally(conn.end.bind(conn));
  });
};
