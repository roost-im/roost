var util = require('util');

function UserError(code, msg) {
  // Apparently you're supposed to do this?
  Error.captureStackTrace(this, UserError);
  this.code = code;
  this.msg = msg;
};
util.inherits(UserError, Error);

exports.UserError = UserError;