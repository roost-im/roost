var zephyr = require('zephyr');

var zuser = require('./zuser.js');

exports.baseString = function(classInst) {
  return classInst.replace(/^(?:un)*/, '').replace(/(?:\.d)*$/, '');
};

exports.noticeToMessage = function(notice) {
  // Skip the random ACKs.
  if (notice.kind == zephyr.HMACK ||
      notice.kind == zephyr.SERVACK ||
      notice.kind == zephyr.SERVNAK) {
    return null;
  }

  // Also punt pings.
  // TODO(davidben): Default filter?
  if (notice.opcode.toLowerCase() === 'ping') {
    return null;
  }

  var classKey = zephyr.downcase(notice.class);
  var instanceKey = zephyr.downcase(notice.instance);
  var msg = {
    time: notice.time.getTime(),
    receiveTime: (new Date()).getTime(),
    class: notice.class,
    classKey: classKey,
    classKeyBase: exports.baseString(classKey),
    instance: notice.instance,
    instanceKey: instanceKey,
    instanceKeyBase: exports.baseString(instanceKey),
    sender: notice.sender,
    recipient: notice.recipient,
    // TODO(davidben): When supporting CC's, this hook needs to change.
    conversation: zuser.isPersonal(notice.recipient) ? notice.sender : '',
    realm: zuser.realm(notice.recipient),
    auth: notice.checkedAuth,
    opcode: notice.opcode
  };
  // TODO(davidben): Pull in the full logic from BarnOwl's
  // owl_zephyr_get_message? It checks on default formats and the
  // like.
  //
  // How much of this processing should be server-side and how much
  // client-side? If we want to be able to search on the body, that
  // suggests it should be in the server.
  if (notice.body.length > 1) {
    msg.signature = notice.body[0];
    msg.message = notice.body[1];
  } else {
    msg.signature = '';
    msg.message = notice.body[0] || '';
  }

  return msg;
};