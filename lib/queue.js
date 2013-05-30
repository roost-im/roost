function JobQueue(callback) {
  this.queue_ = [];
  this.waiting_ = false;
  this.callback_ = callback;
};
JobQueue.prototype.addJob = function(msg) {
  this.queue_.push(msg);
  this.processQueue_();
};
JobQueue.prototype.processQueue_ = function() {
  if (this.waiting_)
    return;
  if (this.queue_.length == 0)
    return;
  var msg = this.queue_.shift();
  this.waiting_ = true;
  this.callback_(msg).then(function() {
    this.waiting_ = false;
    this.processQueue_();
  }.bind(this)).done();
};

exports.JobQueue = JobQueue;
