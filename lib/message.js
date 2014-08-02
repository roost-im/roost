var zephyr = require('zephyr');

var conf = require('./config.js');
var zutil = require('./zutil.js');

exports.baseString = function(classInst) {
  return classInst.replace(/^(?:un)*/, '').replace(/(?:\.d)*$/, '');
};

exports.zwriteToNotices = function(principal, msg) {
  var ccLine = zutil.buildCcLine(msg.recipient);
  return msg.recipient.map(function(recipient) {
    return {
      port: 1,  // Mask the port number.
      class: msg.class,
      instance: msg.instance,
      format: conf.get('zwriteDefaultFormat'),
      opcode: msg.opcode,
      recipient: recipient,
      // TODO(davidben): If we ever allow zsender spoofing, one thing to
      // be careful about: we currently assume and enforce that the
      // sender attribute on outgoing messages is accurate. This should
      // be fine though; zsender spoofing on personals is bogus because
      // they're unreplyable, and only personals get outgoing messages.
      sender: principal,
      body: [ msg.signature, ccLine + msg.message ]
    };
  });
};

// Parse the CC line out of a message body, if any.
exports.parseCcLine = function(body) {
  firstLine = body.split(/\n/)[0];
  ccTest = firstLine.match(/^CC:\s+(.*)$/i);
  if (ccTest) {
    ccs = ccTest[1].trim();
    return ccs.split(/,?\s+/).map(zutil.longZuser);
  } else {
    return null;
  }
}

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
    class: notice.class,
    classKey: classKey,
    classKeyBase: exports.baseString(classKey),
    instance: notice.instance,
    instanceKey: instanceKey,
    instanceKeyBase: exports.baseString(instanceKey),
    sender: notice.sender,
    recipient: notice.recipient,
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

  if (isPersonal) {
    ccs = exports.parseCcLine(msg.message);
    if (ccs) {
      // Remove ourselves from the conversation and add the sender.
      var conversation = ccs.filter(function(principal) {
        return zutil.longZuser(principal) != notice.recipient;
      });
      conversation.push(notice.sender);
      msg.conversation = conversation.sort().join('\0');
    } else {
      msg.conversation = notice.sender;
    }
  } else {
    msg.conversation = '';
  }

  return msg;
};
