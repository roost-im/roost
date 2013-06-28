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
var Principal = require('../lib/principal.js').Principal;
var message = require('../lib/message.js');

var principalStr = process.argv[2];
var principal = Principal.fromString(principalStr);
var directory = temp.mkdirSync(
  'inner-demon-' + principalStr.replace(/[^a-zA-Z0-9]/g, '_'));
var ccachePath = path.join(directory, 'ccache');
process.env['KRB5CCNAME'] = 'FILE:' + ccachePath;

var commands = {};

function updateCredentialCacheSync(creds) {
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

  try {
    fs.unlinkSync(ccachePath);
  } catch (e) {
  }
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
    fs.writeSync(fd, header, 0, header.length);

    var name = {
      nameString: principal.name,
      nameType: krb_proto.KRB_NT_PRINCIPAL
    };
    writePrincipalSync(fd, name, principal.realm);
    creds.forEach(function(cred) {
      writeCredentialSync(fd, cred);
    });
  } catch(e) {
    fs.unlinkSync(ccachePath);
    throw e;
  } finally {
    fs.closeSync(fd);
  }
}

// Before initializing libzephyr, write out a credential-less
// ccache. Otherwise ZGetSender caches the wrong thing.
updateCredentialCacheSync([]);
zephyr.initialize();
zephyr.openPort();

// Sanity check the sender.
var zsender = zephyr.getSender();
if (zsender != principalStr) {
  // This should never happen. The only cause I can think of is if
  // principal.js and the real MIT Kerberos principal
  // (de)serialization code get out-of-sync.
  console.error('Failed to initialize zephyr. Wanted %s, got %s',
                zsender, principalStr);
  process.exit(1);
}

commands.subscribeTo = function(subs, cred) {
  updateCredentialCacheSync([cred]);
  return Q.nfcall(zephyr.subscribeToSansDefaults, subs);
};

commands.expel = function() {
  console.log('Inner demon exiting');
  // Attempt to cancel subs if we can from our tickets, just so I
  // don't leave all these things open in development.
  //
  // TODO(davidben): Session resumption and everything.
  return Q.nfcall(zephyr.cancelSubscriptions).then(function() {
  }, function(err) {
    console.error("Could not cancel subs", principalStr, err);
  }).finally(function() {
    // node-temp is messed up and can't delete temporary
    // directories. Blow away our ccache first.
    //
    // TODO(davidben): Just write your own thing. Really.
    try {
      fs.unlinkSync(ccachePath);
    } catch (e) {
    }
  });
};

process.on('message', function(m) {
  var id = m.id;
  if (commands[m.cmd]) {
    Q.fapply(commands[m.cmd], m.args).then(function(ret) {
      process.send({
        id: id,
        cmd: 'response',
        value: ret
      });
    }, function(err) {
      console.error(err);
      process.send({
        id: id,
        cmd: 'error',
        error: err
      });
    }).finally(function() {
      if (m.cmd === 'expel')
        process.exit();
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
  fs.writeSync(fd, buf, 0, buf.length);
}

function writeUInt16BESync(fd, value) {
  var buf = new Buffer(2);
  buf.writeUInt16BE(value, 0);
  fs.writeSync(fd, buf, 0, buf.length);
}

function writeUInt32BESync(fd, value) {
  var buf = new Buffer(4);
  buf.writeUInt32BE(value, 0);
  fs.writeSync(fd, buf, 0, buf.length);
}

function writeCountedOctetStringSync(fd, buf) {
  writeUInt32BESync(fd, buf.length);
  fs.writeSync(fd, buf, 0, buf.length);
}

function writePrincipalSync(fd, name, realm) {
  writeUInt32BESync(fd, Number(name.nameType));
  writeUInt32BESync(fd, Number(name.nameString.length));
  writeCountedOctetStringSync(fd, new Buffer(String(realm), "utf8"));
  name.nameString.forEach(function(component) {
    writeCountedOctetStringSync(fd, new Buffer(String(component), "utf8"));
  });
}

function writeCredentialSync(fd, cred) {
  writePrincipalSync(fd, cred.cname, cred.crealm);
  writePrincipalSync(fd, cred.sname, cred.srealm);
  writeUInt16BESync(fd, Number(cred.key.keytype));
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
  writeUInt32BESync(fd, flags >>> 0);
  writeUInt32BESync(fd, 0);
  writeUInt32BESync(fd, 0);

  // Convert base64-encoded cipher to use ArrayBuffers.
  cred.ticket.encPart.cipher = new Uint8Array(
    new Buffer(cred.ticket.encPart.cipher, "base64"));
  var ticketDER = krb_proto.Ticket.encodeDER(cred.ticket);
  // And convert the output back to a node buffer.
  ticketDER = new Buffer(new Uint8Array(
    ticketDER.buffer, ticketDER.byteOffset, ticketDER.byteLength));
  writeCountedOctetStringSync(fd, ticketDER);

  writeCountedOctetStringSync(fd, new Buffer(0));
}

// Bahh... I want to ^C the outer guy and have it kill the inner guys.
process.on('SIGINT', function() {
  console.log('Inner demon ignoring SIGINT');
});

process.on('disconnect', function() {
  console.log('Parent process disconnected');
  commands.expel().finally(function() {
    process.exit();
  }).done();
});
