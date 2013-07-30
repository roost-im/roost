function stringOrNull(v) {
  return (v == null) ? null : String(v);
}
function boolOrNull(v) {
  if (v == null)
    return null;
  // Filters passed through query params are going to be strings. As
  // strings, use '0' and '1'.
  if (typeof v == 'string')
    v = Number(v);
  return Boolean(v);
}

var baseString = require('./message.js').baseString;

Filter.FIELDS = ['class_key',
                 'class_key_base',
                 'instance_key',
                 'instance_key_base',
                 'conversation',
                 'recipient',
                 'sender',
                 'is_personal'];

function Filter(fields) {
  this.class_key = stringOrNull(fields.class_key);
  this.class_key_base = stringOrNull(fields.class_key_base);
  this.instance_key = stringOrNull(fields.instance_key);
  this.instance_key_base = stringOrNull(fields.instance_key_base);
  this.conversation = stringOrNull(fields.conversation);
  this.recipient = stringOrNull(fields.recipient);
  this.sender = stringOrNull(fields.sender);
  this.is_personal = boolOrNull(fields.is_personal);
}

Filter.prototype.matchesMessage = function(msg) {
  if (this.class_key != null && this.class_key !== msg.classKey)
    return false;
  if (this.class_key_base != null && this.class_key_base !== msg.classKeyBase)
    return false;
  if (this.instance_key != null && this.instance_key !== msg.instanceKey)
    return false;
  if (this.instance_key_base != null && this.instance_key_base !== msg.instanceKeyBase)
    return false;
  if (this.conversation != null && this.conversation !== msg.conversation)
    return false;
  if (this.recipient != null && this.recipient !== msg.recipient)
    return false;
  if (this.sender != null && this.sender !== msg.sender)
    return false;
  if (this.is_personal != null && this.is_personal !== msg.isPersonal)
    return false;
  return true;
};

Filter.prototype.isStricterThan = function(other) {
  // Normal fields.
  if (other.conversation != null && this.conversation !== other.conversation)
    return false;
  if (other.recipient != null && this.recipient !== other.recipient)
    return false;
  if (other.sender != null && this.sender !== other.sender)
    return false;
  if (other.is_personal != null && this.is_personal !== other.is_personal)
    return false;

  // Strict class/inst fields.
  if (other.class_key != null && this.class_key !== other.class_key)
    return false;
  if (other.instance_key != null && this.instance_key !== other.instance_key)
    return false;

  if (other.class_key_base != null) {
    // If we have a class_key_base, it had better match.
    if (this.class_key_base != null) {
      if (this.class_key_base !== other.class_key_base)
        return false;
    } else {
      // If we don't have a class_key_base, we can still save ourselves
      // if we have a compatible class_key.
      if (this.class_key == null ||
          baseString(this.class_key) !== other.class_key_base) {
        return false;
      }
    }
  }

  if (other.instance_key_base != null) {
    // If we have a instance_key_base, it had better match.
    if (this.instance_key_base != null) {
      if (this.instance_key_base !== other.instance_key_base)
        return false;
    } else {
      // If we don't have a instance_key_base, we can still save
      // ourselves if we have a compatible instance_key.
      if (this.instance_key == null ||
          baseString(this.instance_key) !== other.instance_key_base) {
        return false;
      }
    }
  }

  return true;
};

Filter.prototype.toDict = function() {
  var ret = {};
  Filter.FIELDS.forEach(function(field) {
    if (this[field] != null)
      ret[field] = this[field];
  }, this);
  return ret;
}

exports.Filter = Filter;