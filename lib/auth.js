var clientSessions = require('client-sessions');
var Q = require('q');

var db = require('./db.js');
var conf = require('./config.js');
var error = require('./error.js');

var opts = {
  cookieName: 'roostAuth',
  secret: conf.get('sessionSecret')
};

exports.makeAuthToken = function(user) {
  return clientSessions.util.encode(
    opts, { principal: user.principal }, conf.get('sessionLifetime'));
};

exports.checkAuthToken = function(token) {
  var decoded = clientSessions.util.decode(opts, token);
  if (!decoded)
    return Q.reject(new error.UserError(401, 'Bad token'));

  // Expiry.
  if ((decoded.createdAt + decoded.duration) < new Date().getTime())
    return Q.reject(new error.UserError(401, 'Expired token'));

  // Shouldn't happen; we passed the HMAC.
  if (typeof decoded.content !== "object")
    return Q.reject(new error.UserError(401, 'Bad token'));

  // Look up the user.
  return db.getUser(decoded.content.principal).then(function(user) {
    // Shouldn't happen; we passed the HMAC.
    if (!user)
      throw new error.UserError(401, 'Bad token');
    return user;
  });
};