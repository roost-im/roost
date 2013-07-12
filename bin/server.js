#!/usr/bin/env node

var express = require('express');
var gss = require('gss');
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

// Set the keytab.
var realAuth = false;
if (conf.get('serverKeytab')) {
  process.env['KRB5_KTNAME'] = conf.get('serverKeytab');
  realAuth = true;
} else {
  console.error('!!!!!!!!!!!!!!!!!!!!!');
  console.error('No keytab set. Using fake authentication');
  console.error('Do NOT run this in production!');
  console.error('!!!!!!!!!!!!!!!!!!!!!');
  if (conf.get('production'))
    process.exit(1);
}

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

app.use(function(req, res, next) {
  // Pretend a text/plain Content-Type is actually
  // application/json. This is a silly hack to avoid a CORS preflight
  // request. Apart from three whitelisted Content-Type values, other
  // settings require a CORS preflight to avoid introducing CSRF
  // vulnerabilities in existing AJAX applications. We don't assume a
  // JSON content-type is same-origin, so it's fine for us.
  //
  // In addition, this hack is required for IE9 because XDomainRequest
  // predates CORS and can only send text/plain anyway.
  if (/^text\/plain($|;)/.test(req.headers['content-type']))
    req.headers['content-type'] = 'application/json;charset=utf-8';
  next();
});
app.use(express.bodyParser());

// Don't cache anything. This is an API.
app.use(function(req, res, next) {
  // TODO(davidben): This doesn't get at the socket.io entry points,
  // which still contains an access_token query parameter.
  res.set('Cache-Control', 'no-cache,no-store,private');
  next();
});

// CORS ALL THE THINGS. We won't use cookies and this is different
// from Access-Control-Allow-Credentials. So we're fine.
app.use(function(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  // TODO(davidben): Unfortunately, using JSON as the Content-Type
  // doesn't save us from preflights.
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});
// Just accept the preflight everywhere. Whatever.
app.options('*', function(req, res) {
  // Pick up the headers from earlier.
  res.send(200);
});

function extractBearerToken(req) {
  // IE9 CORS (really XDomainRequest) doesn't allow custom headers.
  // And even with CORS, an Authorization header would require a
  // preflight. Allow passing the token in the query string. Google
  // does this for their APIs.
  //
  // See http://self-issued.info/docs/draft-ietf-oauth-v2-bearer.html

  // Authorization Request Header Field
  var authorization = req.get('Authorization');
  if (authorization) {
    var m = /^Bearer +(.*)$/.exec(authorization);
    if (m)
      return m[1];
  }

  // TODO(davidben): Implement the "Form-Encoded Body Parameter" while
  // we're at it? Doesn't seem much point, since we don't use
  // application/x-www-form-urlencoded. Doing the equivalent for JSON
  // is not insane though.

  // URI Query Parameter
  if (req.query.access_token)
    return req.query.access_token;

  return null;
}

function requireUser(req, res, next) {
  var token = extractBearerToken(req);
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

app.post('/v1/auth', function(req, res) {
  var principal, respTokenB64;
  if (realAuth) {
    if (typeof req.body.token !== 'string') {
      res.send(400, 'Token expected');
      return;
    }

    var context = gss.createAcceptor(null);
    try {
      var respToken =
        context.acceptSecContext(new Buffer(req.body.token, 'base64'));
    } catch (e) {
      // TODO(davidben): Get the KRB_ERROR out and send it back or
      // something.
      res.send(403, 'Bad token');
      console.error(e.toString(), e);
      return;
    }

    if (!context.isEstablished()) {
      // We don't support multi-legged auth. But this shouldn't
      // happen.
      res.send(500, 'Internal error');
      console.error('ERROR: GSS context did not establish in iteration!');
      return;
    }

    principal = context.srcName().toString();
    if (respToken != null)
      respTokenB64 = respToken.toString('base64');
  } else {
    principal = req.body.principal;
    if (typeof principal !== "string") {
      res.send(400, 'Principal expected');
      return;
    }
  }

  var userPromise;
  if (req.body.createUser) {
    // Create user and make default subs.
    userPromise = db.getOrCreateUser(principal).then(function(user) {
      if (!user.newUser)
        return user;
      return subscriber.addDefaultUserSubscriptions(user).then(function() {
        return user;
      });
    });
  } else {
    userPromise = db.getUser(principal);
  }

  userPromise.then(function(user) {
    if (user == null)
      throw new error.UserError(403, 'User does not exist');
    return user;
  }).then(function(user) {
    var ret = auth.makeAuthToken(user);
    res.json(200, {
      gssToken: respTokenB64,
      authToken: ret.token,
      expires: ret.expires
    });
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

app.get('/v1/ping', requireUser, function(req, res) {
  res.json(200, { pong: 1 });
});

app.get('/v1/info', requireUser, function(req, res) {
  db.getUserInfo(req.user).then(function(ret) {
    res.json(200, ret);
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

app.post('/v1/info', requireUser, function(req, res) {
  if (typeof req.body.info != 'string' ||
      typeof req.body.expectedVersion != 'number') {
    res.send(400, 'info and expectedVersion required');
    return;
  }
  db.updateUserInfo(
    req.user, req.body.info, req.body.expectedVersion
  ).then(function(updated) {
    if (updated)
      return { updated: true };
    return db.getUserInfo(req.user).then(function(ret) {
      return {
        updated: false,
        version: ret.version,
        info: ret.info
      };
    });
  }).then(function(ret) {
    res.json(200, ret);
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

app.get('/v1/subscriptions', requireUser, function(req, res) {
  db.getUserSubscriptions(req.user).then(function(subs) {
    res.json(200, subs);
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

function isValidSub(sub) {
  if (typeof sub !== 'object')
    return false;
  if (typeof sub.class !== 'string')
    return false;
  if (typeof sub.instance !== 'string')
    return false;
  if (typeof sub.recipient !== 'string')
    return false;
  return true;
}

app.post('/v1/subscribe', requireUser, function(req, res) {
  if (!util.isArray(req.body.subscriptions) ||
      !req.body.subscriptions.every(isValidSub)) {
    // TODO(davidben): Nicer error message.
    res.send(400, 'Subscription triples expected');
    return;
  }
  subscriber.addUserSubscriptions(
    req.user, req.body.subscriptions, req.body.credentials
  ).then(function(sub) {
    res.json(200, sub);
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

app.post('/v1/unsubscribe', requireUser, function(req, res) {
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

app.get('/v1/messages', requireUser, function(req, res) {
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

app.get('/v1/zephyrcreds', requireUser, function(req, res) {
  res.json(200, {
    needsRefresh: subscriber.needsZephyrCreds(req.user)
  });
});

app.post('/v1/zephyrcreds', requireUser, function(req, res) {
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

// Serve random static files (just the sockjs client right now, needed
// for the iframe-based transports).
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
