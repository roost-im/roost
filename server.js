var express = require('express');
var http = require('http');

var conf = require('./lib/config.js');
var connections = require('./lib/connections.js');
var db = require('./lib/db.js');
var msgid = require('./lib/msgid.js');
var Subscriber = require('./lib/subscriber.js').Subscriber;

var subscriber = new Subscriber();

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
    res.json(200, subs);
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
  subscriber.subscribeTo(
    [klass, (instance === null ? '*' : instance), recipient]
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
  var offset = stringOrNull(req.query.offset);
  if (offset != null)
    offset = msgid.unseal(offset);
  db.getMessages(
    HACK_USER, stringOrNull(offset), {
      inclusive: Boolean(req.query.inclusive|0),
      reverse: Boolean(req.query.reverse|0),
      limit: req.query.count|0
    }
  ).then(function(result) {
    result.messages.forEach(function(msg) {
      msg.id = msgid.seal(msg.id);
    });
    // TODO(davidben): Forward the reachedEnd state?
    res.json(200, result.messages);
  }, function(err) {
    res.send(500);
    console.error(err);
  }).done();
});

app.use(express.static(__dirname + '/static'));

var server = http.createServer(app);
var connectionManager = connections.listen(server, subscriber);

// Load active subscriptions from the database.
console.log('Starting subscriber...');
subscriber.start().then(function() {
  // And now we're ready to start doing things.
  console.log('...started');
  server.listen(conf.get('port'), conf.get('ip'), function() {
    var addy = server.address();
    console.log('running on http://' + addy.address + ":" + addy.port);
  });
}).done();

// Cancel subscriptions on exit.
['SIGINT', 'SIGQUIT', 'SIGTERM'].forEach(function(sig) {
  process.on(sig, function() {
    console.log('Canceling subscriptions...');
    subscriber.shutdown().then(function() {
      console.log('Bye');
      process.exit();
    }).done();
  });
});
