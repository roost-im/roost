var express = require('express');
var http = require('http');
var path = require('path');
var util = require('util');

var auth = require('../lib/auth.js');
var conf = require('../lib/config.js');
var connections = require('../lib/connections.js');
var db = require('../lib/db.js');
var error = require('../lib/error.js');
var msgid = require('../lib/msgid.js');
var Subscriber = require('../lib/subscriber.js').Subscriber;

function sendError(res, err) {
  if (err instanceof error.UserError) {
    // Blegh.
    if (err.code == 401)
      res.set('WWW-Authenticate', 'Bearer');
    res.send(err.code, err.msg);
  } else {
    res.send(500);
  }
}

var subscriber = new Subscriber();

var app = express();

app.use(express.bodyParser());
// CORS ALL THE THINGS. We won't use cookies and this is different
// from Access-Control-Allow-Credentials. So we're fine.
app.use(function(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});

function requireUser(req, res, next) {
  // IE9 CORS (really XDomainRequest) doesn't allow custom headers.
  // And even with CORS, an Authorization header would require a
  // preflight. Allow passing the token in the query string. Google
  // does this for their APIs.
  //
  // TODO(davidben): Allow passing it into the Authorization header
  // anyway. Non-browser clients might appreciate a more HTTP-like
  // header. Google uses
  //
  //   Authorization: Bearer ${token}
  //
  // which seems sane enough. But to be Proper, I ought to look up
  // exactly how to parse those.
  //
  // See http://self-issued.info/docs/draft-ietf-oauth-v2-bearer.html
  var token = req.query.access_token;
  if (!token) {
    // Appease the HTTP gods who say you need a WWW-Authenticate
    // header when you send back 401. Hopefully this'll prevent a
    // browser prompt. They're bad about not prompting...
    res.set('WWW-Authenticate', 'Bearer');
    res.send(401, 'Auth token required');
    return;
  }
  auth.checkAuthToken(token).then(function(user) {
    req.user = user;
    next();
  }, function(err) {
    sendError(res, err);
    console.error(err);
  });
}

app.post('/api/v1/auth', function(req, res) {
  // TODO(davidben): Real authentication!
  var principal = req.body.principal;
  if (typeof principal !== "string") {
    res.send(400, 'Principal expected');
    return;
  }
  db.getUser(principal).then(function(user) {
    if (user == null)
      throw new error.UserError(403, 'User does not exist');
    return user;
  }).then(function(user) {
    var token = auth.makeAuthToken(user);
    res.set('Content-Type', 'text/plain');
    res.send(200, token);
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

app.get('/api/v1/ping', requireUser, function(req, res) {
  res.json(200, { pong: 1 });
});

app.get('/api/v1/subscriptions', requireUser, function(req, res) {
  db.getUserSubscriptions(req.user).then(function(subs) {
    res.json(200, subs);
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

function isValidSub(sub) {
  if (typeof sub !== "object")
    return false;
  if (typeof sub.class !== 'string')
    return false;
  if (sub.instance !== null && typeof sub.instance !== 'string')
    return false;
  if (typeof sub.recipient !== 'string')
    return false;
  return true;
}

app.post('/api/v1/subscribe', requireUser, function(req, res) {
  if (!isValidSub(req.body.subscription)) {
    // TODO(davidben): Nicer error message.
    res.send(400, 'Subscription triple expected');
    return;
  }
  subscriber.addUserSubscription(
    req.user, req.body.subscription, req.body.credentials
  ).then(function(sub) {
    res.json(200, sub);
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

app.post('/api/v1/unsubscribe', requireUser, function(req, res) {
  if (!isValidSub(req.body.subscription)) {
    // TODO(davidben): Nicer error message.
    res.send(400, 'Subscription triple expected');
    return;
  }
  subscriber.removeUserSubscription(
    req.user,
    req.body.subscription
  ).then(function() {
    res.json(200, { unsubscribed: true });
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

app.get('/api/v1/messages', requireUser, function(req, res) {
  var offset = req.query.offset;
  if (offset) {
    offset = msgid.unseal(offset);
  } else {
    // Punt the empty string too.
    offset = null;
  }
  db.getMessages(
    req.user, offset, {
      inclusive: Boolean(req.query.inclusive|0),
      reverse: Boolean(req.query.reverse|0),
      limit: req.query.count|0
    }
  ).then(function(result) {
    result.messages.forEach(function(msg) {
      msg.id = msgid.seal(msg.id);
    });
    res.json(200, result);
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

app.get('/api/v1/zephyrcreds', requireUser, function(req, res) {
  res.json(200, {
    needsRefresh: subscriber.needsZephyrCreds(req.user)
  });
});

app.post('/api/v1/zephyrcreds', requireUser, function(req, res) {
  if (!req.body.credentials) {
    res.send(400, "Missing credentials parameter");
  }
  subscriber.refreshPrivateSubs(
    req.user, req.body.credentials
  ).then(function() {
    res.json(200, { refreshed: true });
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

app.use(express.static(path.join(__dirname, '../static')));

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
