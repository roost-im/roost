var Q = require('q');

function JobQueue(callback) {
  this.queue_ = [];
  this.waiting_ = false;
  this.callback_ = callback;
};
JobQueue.prototype.addJob = function(msg) {
  this.queue_.push(msg);
  this.processQueue_();
  return this.queue_.length;
};
JobQueue.prototype.processQueue_ = function() {
  if (this.waiting_)
    return;
  if (this.queue_.length == 0)
    return;
  var msg = this.queue_[0];
  this.waiting_ = true;
  this.callback_(msg).then(function() {
    this.queue_.shift();
    this.waiting_ = false;
    this.processQueue_();
  }.bind(this)).done();
  return;
};
exports.JobQueue = JobQueue;

function Throttler(callback, timeout) {
  this.timeout_ = timeout || 0;
  this.callback_ = callback;
  // State.
  this.requested_ = false;
  this.running_ = false;
  this.throttleTimer_ = null;
  this.nextCall_ = Q.defer();
};
Throttler.prototype.processState_ = function() {
  if (!this.requested_ ||
      this.running_ ||
      this.throttleTimer_ != null) {
    return;
  }
  // Fire off a new throttle timer.
  this.throttleTimer_ = setTimeout(function() {
    this.throttleTimer_ = null;
    this.processState_();
  }.bind(this), this.timeout_);
  // And the job itself.
  this.requested_ = false;
  this.running_ = true;
  this.nextCall_.resolve(Q.fcall(this.callback_).finally(function() {
    this.running_ = false;
    this.processState_();
  }.bind(this)));
  this.nextCall_ = Q.defer();
};
Throttler.prototype.request = function(opts) {
  opts = opts || {};
  this.requested_ = true;
  // Cancel the current throttle timer.
  if (opts.noThrottle && this.throttleTimer_ != null) {
    clearTimeout(this.throttleTimer_);
    this.throttleTimer_ = null;
  }
  process.nextTick(this.processState_.bind(this));
  return this.nextCall_.promise;
};
exports.Throttler = Throttler;
