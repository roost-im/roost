var zephyr = require('zephyr');

exports.realm = function(user) {
  var idx = user.indexOf('@');
  if (idx >= 0 && idx < user.length - 1)
    return user.substring(idx + 1);
  return zephyr.getRealm();
};

exports.longZuser = function(user) {
  var idx = user.indexOf("@");
  if (idx < 0) {
    // Append @REALM, unless "".
    return user ? (user + "@" + zephyr.getRealm()) : "";
  } else if (idx == user.length - 1) {
    // Ends in @.
    return user + zephyr.getRealm();
  } else {
    // Already has a realm.
    return user;
  }
}

exports.shortZuser = function(user) {
  var idx = user.indexOf("@");
  if (idx < 0) {
    return user;
  } else if (idx == user.length - 1 ||
             (user.substring(idx + 1).toLowerCase() ==
              zephyr.getRealm().toLowerCase())) {
    return user.substring(0, idx);
  } else {
    return user;
  }
}

exports.buildCcLine = function(recipients) {
  if (recipients.length == 1) {
    return "";
  } else {
    return "CC: " + recipients.map(exports.shortZuser).join(" ") + "\n";
  }
};

exports.isPersonal = function(recip) {
  return recip !== '' && recip[0] !== '@';
};

exports.arePersonal = function(recipients) {
  return recipients.every(exports.isPersonal);
};

exports.isValidString = function(v) {
  // Zephyr suffers from C's NUL-terminated string bug, so it can't
  // deal with all strings.
  return (typeof v === 'string') && (v.indexOf('\0') === -1);
};

exports.areValidRecipients = function(recipients) {
  if (!recipients.length) {
    return false;
  } else if (recipients.length == 1) {
    // A single recipient only needs to be valid.
    return exports.isValidString(recipients[0]);
  } else {
    // A list of recipients need to all be personal.
    return recipients.every(function(recipient) {
      return (recipient !== '' &&
              recipient[0] !== '@' &&
              exports.isValidString(recipient));
    })
  }
};
