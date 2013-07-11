var crypto = require('crypto');
var childProcess = require('child_process');
var events = require('events');
var path = require('path');
var Q = require('q');
var util = require('util');
var zephyr = require('zephyr');

var conf = require('./config.js');

var ROOST_CTL_CLASS = '_roost_ctl';

var ROOST_CTL_INNER_DEMON = 'inner_demon';
var INNER_DEMON_PING = 'ping_demon';

function InnerDemon(principal, sessionState) {
  events.EventEmitter.call(this);

  this.principal_ = principal;
  this.pendingCommands_ = { };
  this.nextCommand_ = 1;
  this.exitted_ = Q.defer();
  this.process_ = childProcess.fork(
    path.join(__dirname, '../bin/inner-demon.js'), [principal]);
  // TODO(davidben): Ping the demons regularly to make sure they're
  // still working.
  this.needsCredentials_ = true;

  this.pendingPing_ = null;

  this.process_.on('message', this.onMessage_.bind(this));
  this.process_.on('exit', this.onExit_.bind(this));

  // Make the demon start listening.
  this.start(sessionState).then(function() {
    // Start the ping timer.
    this.schedulePing_();
  }.bind(this), function(err) {
    console.error('Failed to start demon', err);
    return this.expel();
  }).done();
};
util.inherits(InnerDemon, events.EventEmitter);

InnerDemon.prototype.schedulePing_ = function() {
  if (!Q.isPending(this.exitted_.promise))
    return;

  Q.nfcall(crypto.pseudoRandomBytes, 12).then(function(bytes) {
    if (!Q.isPending(this.exitted_.promise))
      return;

    this.pendingPing_ = bytes.toString('base64');
    var ping = {
      port: 1,
      class: ROOST_CTL_CLASS,
      instance: ROOST_CTL_INNER_DEMON,
      opcode: INNER_DEMON_PING,
      recipient: this.principal_,
      body: [ this.pendingPing_ ]
    };
    return Q.nfcall(zephyr.sendNotice, ping, zephyr.ZAUTH);
  }.bind(this)).then(function() {
    return Q.delay(conf.get('pingTimeout')).then(function() {
      if (!Q.isPending(this.exitted_.promise))
        return;

      // We missed the last ping.
      if (this.pendingPing_) {
        console.error('Failed to ping inner demon for', this.principal_);
        this.needsCredentials_ = true;
      }
    }.bind(this));
  }.bind(this), function(err) {
    console.error('Error pinging', this.principal_, err);
  }.bind(this)).then(function() {
    // Wait and then loop back again.
    return Q.delay(conf.get('demonPingTimer'));
  }.bind(this)).then(function() {
    this.schedulePing_();
  }.bind(this)).done();
};

InnerDemon.prototype.handlePong_ = function(msg) {
  if (this.pendingPing_ &&
      msg.auth === 1 &&
      msg.class === ROOST_CTL_CLASS &&
      msg.instance === ROOST_CTL_INNER_DEMON &&
      msg.opcode === INNER_DEMON_PING &&
      msg.recipient === this.principal_ &&
      msg.message === this.pendingPing_) {
    this.pendingPing_ = null;
    if (this.needsCredentials_)
      console.log('Successfully pinged inner demon for', this.principal_);
    this.needsCredentials_ = false;
  }
};

InnerDemon.prototype.needsCredentials = function() {
  return this.needsCredentials_;
};

InnerDemon.prototype.start = function(sessionState) {
  return this.command_('start', [sessionState]);
};

InnerDemon.prototype.dumpSession = function() {
  return this.command_('dumpSession', []);
};

InnerDemon.prototype.subscribeTo = function(subs, creds, knownGoodCreds) {
  // Inject subscriptions to ping messages for the inner demon.
  subs = subs.concat([
    [ROOST_CTL_CLASS, ROOST_CTL_INNER_DEMON, this.principal_]
  ]);
  return this.command_(
    'subscribeTo', [subs, creds, knownGoodCreds]
  ).then(function() {
    if (this.needsCredentials_) {
      console.log('Refreshed subs for', this.principal_,
                  'assuming creds good');
    }
    this.needsCredentials_ = false;
    // Clear the current pending ping.
    this.pendingPing_ = null;
  }.bind(this), function(err) {
    throw err;
  }.bind(this));
};

InnerDemon.prototype.expel = function() {
  return this.command_('expel', []).then(function() {
    return this.exitted_.promise;
  }.bind(this));
};

InnerDemon.prototype.command_ = function(cmd, args) {
  var msg = {
    id: this.nextCommand_++,
    cmd: cmd,
    args: args
  };
  this.process_.send(msg);
  this.pendingCommands_[msg.id] = Q.defer();
  return this.pendingCommands_[msg.id].promise;
};

InnerDemon.prototype.onMessage_ = function(msg) {
  if (msg.cmd == 'message') {
    if (msg.message.classKey === ROOST_CTL_CLASS) {
      this.handlePong_(msg.message);
    } else {
      this.emit('message', msg.message);
    }
  } else if (msg.cmd == 'response') {
    if (msg.id in this.pendingCommands_) {
      this.pendingCommands_[msg.id].resolve(msg.value);
      delete this.pendingCommands_[msg.id];
    } else {
      console.error("Unknown command id", msg);
    }
  } else if (msg.cmd == 'error') {
    if (msg.id in this.pendingCommands_) {
      this.pendingCommands_[msg.id].reject(msg.error);
      delete this.pendingCommands_[msg.id];
    } else {
      console.error("Unknown command id", msg);
    }
  }
};

InnerDemon.prototype.onExit_ = function(code, signal) {
  // Cancel all pending commands.
  Object.keys(this.pendingCommands_).forEach(function(id) {
    this.pendingCommands_[id].reject("Inner demon exited");
    delete this.pendingCommands_[id];
  }.bind(this));

  this.exitted_.resolve(code);
  this.emit('exit', code, signal);
};

exports.InnerDemon = InnerDemon;
