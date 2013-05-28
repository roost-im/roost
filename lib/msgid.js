var Buffer = require('buffer').Buffer;
var crypto = require('crypto');

var conf = require('./config.js');

// Yeah, yeah, ad-hoc crypto... this is not particularly
// important. Just a way to give us opaque message ids without having
// to actually maintain state, and the only purpose of opaque message
// ids is to not trivially reveal how many messages you can't see.

exports.seal = function(id) {
  var buf = new Buffer(16);
  buf.fill(0);
  // Declare that we only care about 2^32 and shrink the database
  // schema? Right now we're too big to reliably specialize to int32_t
  // (I believe uint32_t specialization is less consistently
  // implemented), this code can get into the realm of doubles.
  buf.writeUInt32BE((id / 0x100000000)>>>0, 8);
  buf.writeUInt32BE(id >>> 0, 12);

  var cipher = crypto.createCipher('aes128', conf.get('msgidSecret'));
  cipher.setAutoPadding(false);
  var ret = cipher.update(buf, 'buffer', 'base64');
  ret += cipher.final('base64');

  // Use a URL-friendly base64 to avoid /s. Matches Python's
  // urlsafe_b64encode.
  ret = ret.replace(/\+/g, '-').replace(/\//g, '_');
  // Strip off base64 padding while we're at it.
  ret = ret.replace(/=+$/, '');
  return ret;
};

exports.unseal = function(msgId) {
  msgId = msgId.replace(/-/g, '+').replace(/_/g, '/');
  msgId += ['', '===', '==', '='][msgId.length % 4];
  try {
    var decipher = crypto.createDecipher('aes128', conf.get('msgidSecret'));
    decipher.setAutoPadding(false);
    var buf1 = decipher.update(msgId, 'base64', 'buffer');
    var buf2 = decipher.final('buffer');  // This one should be empty...
  } catch (e) {
    // base64 error, not multiple of block length.
    return 0;
  }

  var buf = new Buffer(buf1.length + buf2.length);
  buf1.copy(buf);
  buf2.copy(buf, buf1.length);

  // I suppose mumble mumble constant-time?
  for (var i = 0; i < 8; i += 4) {
    if (buf.readUInt32BE(i) != 0)
      return 0;  // Eh? Should I return something else?
  }
  return buf.readUInt32BE(8) * 0x100000000 + buf.readUInt32BE(12);
};