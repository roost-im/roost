var Buffer = require('buffer').Buffer;
var fs = require('fs');
var path = require('path');
var Q = require('q');
// TODO(davidben): This library is ridiculous. If you create a
// temporary file per-request you slowly grow your memory usage over
// the lifetime of your program and never actually delete your
// temporaries anyway. 
var temp = require('temp');
var zephyr = require('zephyr');

var krb_proto = require('../lib/krb_proto.js');
var message = require('../lib/message.js');

var principal = process.argv[2];
var directory = temp.mkdirSync(
  'inner-demon-' + principal.replace(/[^a-zA-Z0-9]/g, '_'));
var ccachePath = path.join(directory, 'ccache');
process.env['KRB5CCNAME'] = 'FILE:' + ccachePath;

zephyr.openPort();

var commands = {};

commands.subscribeTo = function(subs, cred) {
  // Write the credential to the ccache. We do this synchronously to avoid
  // dealing having to deal with synchronization here. This should be
  // on a tmpfs, and everything here is for a single user anyway.
  //
  // This is taken from ssh-krb-wrapper in the shell-in-a-box hack in
  // Webathena.
  //
  // TODO(davidben): We could probably also do this with the Kerberos
  // API. Maybe even GSSAPI credential delegation? An awful lot of
  // machinery though.
  //
  // TODO(davidben): do a temporary+rename thing.

  var fd = fs.openSync(ccachePath, 'wx+', 0600);
  try {
    // Write the header.
    var header = new Buffer(2 + 2 + 2 + 2 + 4 + 4);
    header.writeUInt16BE(0x0504, 0);  // file_format_version
    header.writeUInt16BE(12, 2);  // headerlen
    header.writeUInt16BE(1, 4);  // tag (DeltaTime)
    header.writeUInt16BE(8, 6);  // taglen (two uint32_ts)
    header.writeUInt32BE(0, 8);  // time_offset
    header.writeUInt32BE(0, 12);  // uset_offset
    fs.writeSync(fd, header);

    writePrincipalSync(fd, cred.cname, cred.crealm);
    writeCredentialSync(fd, cred);

  } catch(e) {
    fs.unlinkSync(ccachePath);
    throw e;
  } finally {
    fs.closeSync(fd);
  }

  return Q.nfcall(zephyr.subscribeTo, subs);
};

commands.expel = function() {
  console.log('Inner demon exiting');
  return Q();
};

process.on('message', function(m) {
  var id = m.id;
  if (commands[m.cmd]) {
    Q.fapply(commands.m.cmd, m.args).then(function(ret) {
      process.send({
        id: id,
        cmd: 'response',
        value: ret
      });
    }, function(err) {
      process.send({
        id: id,
        cmd: 'error',
        error: err
      });
    }).done();
  } else {
    process.send({
      id: id,
      cmd: 'error',
      error: 'Unknown command'
    });
    console.error('Unknown command', m);
  }
});

zephyr.on('notice', function(notice) {
  var msg = message.noticeToMessage(notice);
  if (msg) {
    process.send({
      cmd: 'message',
      message: msg
    });
  }
});

function writeUInt8Sync(fd, value) {
  var buf = new Buffer(1);
  buf.writeUInt8(value, 0);
  fs.writeSync(fd, buffer);
}

function writeUInt16BESync(fd, value) {
  var buf = new Buffer(2);
  buf.writeUInt16BE(value, 0);
  fs.writeSync(fd, buffer);
}

function writeUInt32BESync(fd, value) {
  var buf = new Buffer(4);
  buf.writeUInt32BE(value, 0);
  fs.writeSync(fd, buffer);
}

function writeCountedOctetStringSync(fd, buf) {
  writeUInt32BESync(fd, buf.length);
  fs.writeSync(fd, buf);
}

function writePrincipalSync(fd, name, realm) {
  writeUInt32BESync(fd, Number(name.nameType));
  writeUInt32BESync(fd, Number(name.nameString.length));
  writeCountedOctetStringSync(fd, new Buffer(String(realm), "utf8"));
  name.nameString.forEach(function(component) {
    writeCountedOctetStringSync(fd, new Buffer(String(component), "utf8"));
  }
}

function writeCredentialSync(fd, cred) {
  writePrincipalSync(cred.cname, cred.crealm);
  writePrincipalSync(cred.sname, cred.srealm);
  writeUInt16BESync(fd, Number(cred.key.keyType));
  writeCountedOctetStringSync(fd, new Buffer(cred.key.keyvalue, "base64"));
  writeUInt32BESync(fd, (cred.authtime / 1000)|0);
  writeUInt32BESync(fd, ((cred.authtime || cred.starttime) / 1000)|0);
  writeUInt32BESync(fd, (cred.endtime / 1000)|0);
  writeUInt32BESync(fd, ((cred.renewTill || 0) / 1000)|0);
  writeUInt8Sync(fd, 0);
  var flags = 0;
  for (var i = 0; i < cred.flags.length; i++) {
    if (cred.flags[i])
      flags |= 1 << (31 - i);
  }
  writeUInt32BESync(fd, flags);
  writeUInt32BESync(fd, 0);
  writeUInt32BESync(fd, 0);

  // Convert base64-encoded cipher to use ArrayBuffers.
  cred.ticket.encPart.cipher = new Uint8Array(
    new Buffer(cred.ticket.encPart.cipher, "base64"));
  var ticketDER = krb_proto.Ticket.encodeDER(cred.ticket);
  // And convert the output back to a node buffer.
  ticketDER = new Buffer(new Uint8Array(
    derEncoded.buffer, derEncoded.byteOffset, derEncoded.byteLength));
  writeCountedOctetStringSync(fd, ticketDER);

  writeCountedOctetStringSync(fd, new Buffer(0));
}