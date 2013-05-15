var express = require('express');
var http = require('http');
var Q = require('q');
var socketIo = require('socket.io');
var zephyr = require('zephyr');

var conf = require('./lib/config.js');
var db = require('./lib/db.js');
var zuser = require('./lib/zuser.js');

zephyr.openPort();

var app = express();

app.use(express.bodyParser());

function stringOrNull(arg) {
  if (arg == null)
    return null;
  return String(arg);
}
var HACK_USER = 1;

app.get('/api/subscriptions', function(req, res) {
  db.getUserSubscriptions(HACK_USER).then(function(subs) {
    res.set('Content-Type', 'application/json');
    res.send(200, JSON.stringify(subs));
  }, function(err) {
    res.send(500);
    console.error(err);
  }).done();
});

app.post('/api/subscribe', function(req, res) {
  if (!req.body.class) {
    res.send(400, 'class parameter required');
    return;
  }
  // Subscribe and save in the database.
  var klass = String(req.body.class);
  var instance = stringOrNull(req.body.instance);
  // TODO(davidben): Permissions checking.
  var recipient = String(req.body.recipient);
  Q.nfcall(
    zephyr.subscribeTo, [
      [klass, (instance === null ? '*' : instance), recipient]
    ]
  ).then(function() {
    // Save the subscription in the database.
    return db.addUserSubscription(HACK_USER, klass, instance, '');
  }).then(function() {
    res.send(200);
  }, function(err) {
    res.send(500);
    console.error(err);
  }).done();
});

app.post('/api/unsubscribe', function(req, res) {
  if (!req.body.class) {
    res.send(400, 'class parameter required');
    return;
  }
  // Only remove from the database, not from the subscriber.
  // TODO(davidben): Garbage-collect the zephyr subs.
  var klass = String(req.body.class);
  var instance = stringOrNull(req.body.instance);
  var recipient = String(req.body.recipient);
  db.removeUserSubscription(
    HACK_USER, klass, instance, recipient
  ).then(function() {
    res.send(200);
  }, function(err) {
    res.send(500);
    console.error(err);
  }).done();
});

app.get('/api/messages', function(req, res) {
  db.getMessages(
    HACK_USER, req.query.offset|0, {
      reverse: Boolean(req.query.reverse|0),
      limit: req.query.count|0
    }
  ).then(function(messages) {
    res.set('Content-Type', 'application/json');
    res.send(200, JSON.stringify(messages));
  }, function(err) {
    res.send(500);
    console.error(err);
  }).done();
});

app.use(express.static(__dirname + '/static'));

var server = http.createServer(app);
var io = socketIo.listen(server);

var connections = { };
zephyr.on('notice', function(notice) {
  // Skip the random ACKs.
  if (notice.kind == zephyr.HMACK ||
      notice.kind == zephyr.SERVACK ||
      notice.kind == zephyr.SERVNAK) {
    return;
  }

  console.log("%s / %s / %s %s [%s] (%s)\n%s",
              notice.class, notice.instance, notice.sender,
              (notice.checkedAuth == zephyr.ZAUTH_YES) ?
              "AUTHENTIC" : "UNAUTHENTIC",
              notice.opcode, notice.body[0], notice.body[1]);

  var msg = {
    time: notice.time.getTime(),
    class: notice.class,
    instance: notice.instance,
    sender: notice.sender,
    recipient: notice.recipient,
    realm: zuser.realm(notice.recipient),
    auth: notice.auth,
    opcode: notice.opcode
  };
  // TODO(davidben): Pull in the full logic from BarnOwl's
  // owl_zephyr_get_message? It checks on default formats and the
  // like.
  //
  // How much of this processing should be server-side and how much
  // client-side? If we want to be able to search on the body, that
  // suggests it should be in the server.
  if (notice.body.length > 1) {
    msg.signature = notice.body[0];
    msg.message = notice.body[1];
  } else {
    msg.signature = '';
    msg.message = notice.body[0] || '';
  }

  // Save to the database.
  db.saveMessage(msg).done();

  // Forward to clients.
  for (var id in connections) {
    connections[id].emit('message', msg);
  }
});

io.sockets.on('connection', function(socket) {
  connections[socket.id] = socket;
  socket.on('end', function() {
    delete connections[socket.id];
  });
});

// Load active subscriptions from the database.
console.log('Loading active subscriptions');
db.loadActiveSubs().then(function(subs) {
  subs = subs.map(function(sub) {
    if (sub[1] === null)
      return [sub[0], '*', sub[2]];
    return sub;
  });
  console.log('Subscribing to %d triples', subs.length);
  return Q.nfcall(zephyr.subscribeTo, subs);
}).then(function() {
  // And now we're ready to start doing things.
  console.log('Subscribed');
  server.listen(conf.get('port'), conf.get('ip'), function() {
    var addy = server.address();
    console.log('running on http://' + addy.address + ":" + addy.port);
  });
}).done();

// Cancel subscriptions on exit.
['SIGINT', 'SIGQUIT', 'SIGTERM'].forEach(function(sig) {
  process.on(sig, function() {
    console.log('Canceling subscriptions...');
    zephyr.cancelSubscriptions(function(err) {
      if (err)
        console.log(err.code, err.message);
      console.log('Bye');
      process.exit();
    });
  });
});
