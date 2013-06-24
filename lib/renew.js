var childProcess = require('child_process');
var Q = require('q');

var conf = require('./config.js');

exports.renewTickets = function() {
  if (!conf.get('daemonKeytab') || !conf.get('daemonPrincipal'))
    return Q.reject('No daemon principal configured');

  var deferred = Q.defer();
  var kinit = childProcess.spawn(
    conf.get('kinitPath'),
    [conf.get('daemonPrincipal'), '-k', '-t', conf.get('daemonKeytab')], {
      stdio: ['ignore', process.stdout, process.stderr]
    });
  kinit.on('close', function(code) {
    if (code !== 0) {
      deferred.reject('kinit process exited with code ' + code);
    } else {
      deferred.resolve();
    }
  });
  return deferred.promise;
};
