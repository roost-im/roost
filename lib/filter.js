function stringOrNull(v) {
  return (v == null) ? null : String(v);
}

Filter.FIELDS = ['class_key',
                 'class_key_base',
                 'instance_key',
                 'instance_key_base',
                 'conversation',
                 'recipient',
                 'sender'];

function Filter(fields) {
  this.class_key = stringOrNull(fields.class_key);
  this.class_key_base = stringOrNull(fields.class_key_base);
  this.instance_key = stringOrNull(fields.instance_key);
  this.instance_key_base = stringOrNull(fields.instance_key_base);
  this.conversation = stringOrNull(fields.conversation);
  this.recipient = stringOrNull(fields.recipient);
  this.sender = stringOrNull(fields.sender);
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
  return true;
};

exports.Filter = Filter;