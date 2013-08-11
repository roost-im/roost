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

function ExponentialBackoff(callback, opts) {
  opts = opts || {};

  this.callback_ = callback;
  this.deferred_ = Q.defer();

  this.attemptPending_ = false;
  this.retryTimer_ = null;
  this.maxTries_ = opts.maxTries || 9;
  this.nextDelay_ = opts.firstDelay || 500;
  this.description_ = opts.description;

  process.nextTick(this.retry.bind(this));
}
ExponentialBackoff.prototype.promise = function() {
  return this.deferred_.promise;
}
// Can be called manually if the caller has reason to believe it will
// actually succeed this time. Such calls don't contribute to
// maxTries.
ExponentialBackoff.prototype.retry = function() {
  // Don't do anything if we've already resolved the promise.
  if (!Q.isPending(this.deferred_.promise))
    return;
  // Are we currently attempting it?
  if (this.attemptPending_)
    return;

  this.attemptPending_ = true;
  Q.fcall(this.callback_).then(function(ret) {
    // Yay, it succeeded. Okay, that's the end of it.
    this.attemptPending_ = false;
    this.deferred_.resolve(ret);

    // Shut off the retry timer, if it exists.
    if (this.retryTimer_ != null) {
      clearTimeout(this.retryTimer_);
      this.retryTimer_ = null;
    }
  }.bind(this), function(err) {
    this.attemptPending_ = false;

    console.error("Failed to " + this.description_, err);
    // Bah. It failed. Refresh the retry timer if not already
    // running. If it's already running, this was a manual
    // retry. Leave it alone.
    if (this.retryTimer_ == null) {
      // We've tried too much. Reject.
      if (--this.maxTries_ <= 0) {
        console.error("Too many retries");
        this.deferred_.reject(err);
      } else {
        console.error("Retrying in %d seconds (%d retries left)",
                      this.nextDelay_ / 1000.0,
                      this.maxTries_);
        this.retryTimer_ = setTimeout(function() {
          this.retryTimer_ = null;
          this.retry();
        }.bind(this), this.nextDelay_);
        this.nextDelay_ *= 2;
      }
    }
  }.bind(this)).done();
}
exports.ExponentialBackoff = ExponentialBackoff;