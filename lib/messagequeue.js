function MessageQueue(callback) {
  this.queue_ = [];
  this.waiting_ = false;
  this.callback_ = callback;
};
MessageQueue.prototype.addMessage = function(msg) {
  this.queue_.push(msg);
  this.processQueue_();
};
MessageQueue.prototype.processQueue_ = function() {
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

exports.MessageQueue = MessageQueue;
