var zephyr = require('zephyr');

exports.realm = function(user) {
  var idx = user.indexOf('@');
  if (idx >= 0 && idx < user.length - 1)
    return user.substring(idx + 1);
  return zephyr.getRealm();
};

exports.isPersonal = function(recip) {
  return recip !== '' && recip[0] !== '@';
};