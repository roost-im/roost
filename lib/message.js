var zephyr = require('zephyr');

var conf = require('./config.js');
var zutil = require('./zutil.js');

exports.baseString = function(classInst) {
  return classInst.replace(/^(?:un)*/, '').replace(/(?:\.d)*$/, '');
};

exports.zwriteToNotice = function(principal, msg) {
  return {
    port: 1,  // Mask the port number.
    class: msg.class,
    instance: msg.instance,
    format: conf.get('zwriteDefaultFormat'),
    opcode: msg.opcode,
    recipient: msg.recipient,
    // TODO(davidben): If we ever allow zsender spoofing, one thing to
    // be careful about: we currently assume and enforce that the
    // sender attribute on outgoing messages is accurate. This should
    // be fine though; zsender spoofing on personals is bogus because
    // they're unreplyable, and only personals get outgoing messages.
    sender: principal,
    body: [ msg.signature, msg.message ]
  };
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
  var isPersonal = zutil.isPersonal(notice.recipient);
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
    conversation: isPersonal ? notice.sender : '',
    isPersonal: isPersonal,
    isOutgoing: false,
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