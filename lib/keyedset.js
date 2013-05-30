function KeyedSet() {
  this.length = 0;
  this.set_ = {};
  this.nextKey_ = 0;
}
KeyedSet.prototype.forEach = function(cb) {
  Object.keys(this.set_).forEach(function(key) {
    cb(this.set_[key]);
  }, this);
};
KeyedSet.prototype.add = function(obj) {
  var key = ++this.nextKey_;
  this.set_[key] = obj;
  this.length++;
  return key;
};
KeyedSet.prototype.removeKey = function(key) {
  delete this.set_[key];
  this.length--;
};

exports.KeyedSet = KeyedSet;
