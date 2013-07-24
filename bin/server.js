#!/usr/bin/env node

var express = require('express');
var gss = require('gss');
var http = require('http');
var path = require('path');
var Q = require('q');
var util = require('util');

var auth = require('../lib/auth.js');
var conf = require('../lib/config.js');
var connections = require('../lib/connections.js');
var db = require('../lib/db.js');
var error = require('../lib/error.js');
var Filter = require('../lib/filter.js').Filter;
var msgid = require('../lib/msgid.js');
var Subscriber = require('../lib/subscriber.js').Subscriber;
var zutil = require('../lib/zutil.js');

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
  res.set('Vary', 'Authorization');
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

function jsonAPI(fn) {
  return function(req, res) {
    Q.fcall(fn, req).then(function(ret) {
      res.json(ret);
    }, function(err) {
      if (err instanceof error.UserError) {
        // Blegh.
        if (err.code == 401)
          res.set('WWW-Authenticate', 'Bearer');
        res.send(err.code, err.msg);
      } else {
        res.send(500);
        console.error(err);
      }
    }).done();
  };
}

app.post('/v1/auth', jsonAPI(function(req) {
  var principal, respTokenB64;
  if (realAuth) {
    if (typeof req.body.token !== 'string') {
      throw new error.UserError(400, 'Token expected');
    }

    var context = gss.createAcceptor(null);
    try {
      var respToken =
        context.acceptSecContext(new Buffer(req.body.token, 'base64'));
    } catch (e) {
      // TODO(davidben): Get the KRB_ERROR out and send it back or
      // something.
      console.error(e.toString(), e);
      throw new error.UserError(403, 'Bad token');
    }

    if (!context.isEstablished()) {
      // We don't support multi-legged auth. But this shouldn't
      // happen.
      throw 'ERROR: GSS context did not establish in iteration!';
    }

    principal = context.srcName().toString();
    if (respToken != null)
      respTokenB64 = respToken.toString('base64');
  } else {
    principal = req.body.principal;
    if (typeof principal !== "string") {
      throw new error.UserError(400, 'Principal expected');
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

  return userPromise.then(function(user) {
    if (user == null)
      throw new error.UserError(403, 'User does not exist');
    return user;
  }).then(function(user) {
    var ret = auth.makeAuthToken(user);
    return {
      gssToken: respTokenB64,
      authToken: ret.token,
      expires: ret.expires
    };
  });
}));

app.get('/v1/ping', requireUser, jsonAPI(function(req) {
  return { pong: 1 };
}));

app.get('/v1/info', requireUser, jsonAPI(function(req) {
  return db.getUserInfo(req.user);
}));

app.post('/v1/info', requireUser, jsonAPI(function(req) {
  if (typeof req.body.info != 'string' ||
      typeof req.body.expectedVersion != 'number') {
    throw new error.UserError(400, 'info and expectedVersion required');
  }
  return db.updateUserInfo(
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
  });
}));

app.get('/v1/subscriptions', requireUser, jsonAPI(function(req) {
  return db.getUserSubscriptions(req.user);
}));

function isValidSub(sub) {
  if (sub == null || typeof sub !== 'object')
    return false;
  return (zutil.isValidString(sub.class) &&
          zutil.isValidString(sub.instance) &&
          zutil.isValidString(sub.recipient));
}

app.post('/v1/subscribe', requireUser, jsonAPI(function(req) {
  if (!util.isArray(req.body.subscriptions) ||
      !req.body.subscriptions.every(isValidSub)) {
    // TODO(davidben): Nicer error message.
    throw new error.UserError(400, 'Subscription triples expected');
  }
  return subscriber.addUserSubscriptions(
    req.user, req.body.subscriptions, req.body.credentials);
}));

app.post('/v1/unsubscribe', requireUser, jsonAPI(function(req) {
  if (!isValidSub(req.body.subscription)) {
    // TODO(davidben): Nicer error message.
    throw new error.UserError(400, 'Subscription triple expected');
  }
  return subscriber.removeUserSubscription(
    req.user,
    req.body.subscription
  ).then(function() {
    return { unsubscribed: true };
  });
}));

app.get('/v1/messages', requireUser, jsonAPI(function(req) {
  var offset = req.query.offset;
  if (offset) {
    offset = msgid.unseal(offset);
  } else {
    // Punt the empty string too.
    offset = null;
  }
  var filter = new Filter(req.query);
  return db.getMessages(
    req.user, offset, filter, {
      inclusive: Boolean(req.query.inclusive|0),
      reverse: Boolean(req.query.reverse|0),
      limit: req.query.count|0
    }
  ).then(function(result) {
    result.messages.forEach(function(msg) {
      msg.id = msgid.seal(msg.id);
    });
    return result;
  })
}));

app.get('/v1/zephyrcreds', requireUser, jsonAPI(function(req) {
  return {
    needsRefresh: subscriber.needsZephyrCreds(req.user)
  };
}));

app.post('/v1/zephyrcreds', requireUser, jsonAPI(function(req) {
  if (!req.body.credentials) {
    throw new error.UserError(400, 'Missing credentials parameter');
  }
  return subscriber.refreshPrivateSubs(
    req.user, req.body.credentials
  ).then(function() {
    return { refreshed: true };
  });
}));

app.get('/v1/bytime', requireUser, jsonAPI(function(req) {
  var time = parseInt(req.query.t);
  if (isNaN(time)) {
    throw new error.UserError(400, 'Missing t parameter');
  }
  return db.findByTime(req.user, time).then(function(id) {
    return {
      id: (id == null) ? null : msgid.seal(id)
    };
  });
}));

function isValidZwrite(msg) {
  if (msg == null || typeof msg !== 'object')
    return false;
  return (zutil.isValidString(msg.class) &&
          zutil.isValidString(msg.instance) &&
          zutil.isValidString(msg.opcode) &&
          zutil.isValidString(msg.recipient) &&
          zutil.isValidString(msg.signature) &&
          zutil.isValidString(msg.message));
}

app.post('/v1/zwrite', requireUser, jsonAPI(function(req) {
  if (!req.body.credentials) {
    throw new error.UserError(400, 'Missing credentials parameter');
  }
  if (!isValidZwrite(req.body.message)) {
    throw new error.UserError(400, 'Bad zwrite');
  }
  return subscriber.zwrite(
    req.user, req.body.message, req.body.credentials
  ).then(function(ack) {
    return {
      ack: ack
    };
  });
}));

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
    console.log('running on http://' + addy.address + ':' + addy.port);
  });
}).done();

// Cancel subscriptions on exit.
['SIGINT', 'SIGQUIT', 'SIGTERM'].forEach(function(sig) {
  process.on(sig, function() {
    console.log('Shutting down...');
    subscriber.shutdown().then(function() {
      console.log('Bye');
      process.exit();
    }).done();
  });
});
