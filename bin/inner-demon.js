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
var zutil = require('../lib/zutil.js');

var principalStr = process.argv[2];
var principal = Principal.fromString(principalStr);
var directory = temp.mkdirSync(
  'inner-demon-' + principalStr.replace(/[^a-zA-Z0-9]/g, '_'));
var ccachePath = path.join(directory, 'ccache');
process.env['KRB5CCNAME'] = 'FILE:' + ccachePath;

var lastGoodTicket = null;
function handleGoodTicket(cred) {
  if (lastGoodTicket == null || lastGoodTicket.endtime < cred.endtime) {
    lastGoodTicket = cred;
  }
}

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

var started = false;
commands.start = function(sessionState) {
  if (started)
    throw "Already started";
  if (sessionState) {
    zephyr.loadSession(new Buffer(sessionState, 'base64'));
  } else {
    zephyr.openPort();
  }
  started = true;
};

commands.subscribeTo = function(subs, cred, knownGoodCreds) {
  updateCredentialCacheSync([cred]);
  return Q.nfcall(zephyr.subscribeToSansDefaults, subs).then(function() {
    // These tickets were good. Hold onto them.
    handleGoodTicket(cred);
  }, function(err) {
    // We know these tickets are good from a previous run. Hold on to
    // them anyway. Spurious error. This is so we don't lose the
    // tickets again afterwards.
    if (knownGoodCreds)
      handleGoodTicket(cred);
    throw err;
  });
};

commands.zwrite = function(msg, cred) {
  updateCredentialCacheSync([cred]);
  var deferred = Q.defer();
  var notice =
    zephyr.sendNotice(message.zwriteToNotice(principalStr, msg), zephyr.ZAUTH);
  notice.on('servack', function(err, ack) {
    if (err) {
      deferred.reject(err);
    } else {
      handleGoodTicket(cred);
      deferred.resolve(ack);

      // This shouldn't happen.
      if (sec === undefined || usec === undefined)
        throw "Didn't get uid!";

      // Add outgoing messages. It's awkward that we want to do this
      // here, but other code doesn't have access to the
      // timestamp.
      //
      // TODO(davidben): Unless we maybe return it and then deliver
      // the SERVACK later. Arguably we want to do that anyway so that
      // it can be passed all the way back to the client on the socket
      // /before/ any forward-tails continue. Then the client knows
      // what to correlate its pending message with.
      //
      // Of course, if we do that, we have the additional awkwardness
      // of losing precision in the timestamp. Actually want to return
      // the ZUnique_Id_t. So we add ANOTHER COLUMN. Except the
      // column's not really used for much, so that feels really quite
      // silly. Maybe we could get away with only doing it for live
      // messages? I dunno. It feels wrong to have live messages and
      // database messages return different things.
      //
      // It wooould just be another 12 bytes per message... doesn't
      // have to be indexed or even variable-length.
      //
      // Anyway, we'll do all that later if that UI is ever
      // added. Given that it's just an animation, maybe we don't need
      // as correct a correlation.
      //
      // (The question is, if you want to do some animation or
      // whatever to transition the pending message to the
      // outgoing/received version, you want to be able to match them
      // up. Moreover, you have to avoid the race where you find out
      // the correlation parameters after the message comes in.)
      if (zutil.isPersonal(msg.recipient)) {
        var classKey = zephyr.downcase(msg.class);
        var instanceKey = zephyr.downcase(msg.instance);
        process.send({
          cmd: 'message',
          message: {
            time: sec * 1000 + usec / 1000,
            receiveTime: new Date().getTime(),
            class: msg.class,
            classKey: classKey,
            classKeyBase: message.baseString(classKey),
            instance: msg.instance,
            instanceKey: instanceKey,
            instanceKeyBase: message.baseString(instanceKey),
            sender: principalStr,
            recipient: msg.recipient,
            // TODO(davidben): When supporting CC's, this hook needs to change.
            conversation: msg.recipient,
            isPersonal: true,
            isOutgoing: true,
            // TODO(davidben): Merp?
            auth: 1,
            opcode: msg.opcode,
            signature: msg.signature,
            message: msg.message
          }
        });
      }
    }
  });

  // Extract the time from the uid. First 32-bits are in_addr. Then
  // tv_sec, then tv_usec.
  var sec, usec;
  if (notice.uid) {
    sec = notice.uid.readUInt32BE(4);
    usec = notice.uid.readUInt32BE(8);
  }

  return deferred.promise;
};

commands.dumpSession = function() {
  return {
    sessionState: zephyr.dumpSession().toString('base64'),
    lastGoodTicket: lastGoodTicket
  };
};

commands.expel = function() {
  console.log('Inner demon exiting');
  // We intentionally /don't/ cancel subscriptions. Instead, the
  // session state is preserved for later.
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

  // Make a copy of the ticket, but with the base64 bits decoded as
  // Uint8Array. (This is the format the ASN.1 code expects.)
  var ticket = {
    tktVno: cred.ticket.tktVno,
    realm: cred.ticket.realm,
    sname: cred.ticket.sname,
    encPart: {
      kvno: cred.ticket.encPart.kvno,
      etype: cred.ticket.encPart.etype,
      cipher: new Uint8Array(new Buffer(cred.ticket.encPart.cipher, "base64"))
    }
  };
  // Now we encode to DER.
  var ticketDER = krb_proto.Ticket.encodeDER(ticket);
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
  Q.invoke(commands, 'expel').finally(function() {
    process.exit();
  }).done();
});
