var express = require('express');
var http = require('http');
var socketIo = require('socket.io');
var zephyr = require('zephyr');

zephyr.openPort();

var app = express();

app.use(express.bodyParser());

app.post('/api/subscribe', function(req, res) {
  if (!req.body.class) {
    res.send(400, 'class parameter required');
    return;
  }
  zephyr.subscribeTo([[req.body.class, req.body.instance, '*']], function(err) {
    if (err) {
      res.send(500);
      console.log(err.code, err.message);
      return;
    }
    res.send(200);
  });
});

app.post('/api/unsubscribe', function(req, res) {
  if (!req.body.class) {
    res.send(400, 'class parameter required');
    return;
  }
  zephyr.unsubscribeTo([[req.body.class, req.body.instance, '*']], function(err) {
    if (err) {
      res.send(500);
      console.log(err.code, err.message);
      return;
    }
    res.send(200);
  });
});

app.use(express.static(__dirname + '/static'));

var server = http.createServer(app);
var io = socketIo.listen(server);

function zuserRealm(user) {
  var idx = user.indexOf('@');
  if (idx >= 0 && idx < user.length - 1)
    return user.substring(idx + 1);
  return zephyr.getRealm();
}

var connections = { };
zephyr.on('notice', function(notice) {
  // Skip the random ACKs.
  if (notice.kind == zephyr.HMACK ||
      notice.kind == zephyr.SERVACK ||
      notice.kind == zephyr.SERVNAK) {
    return;
  }

  console.log("%s / %s / %s %s [%s] (%s)\n%s",
              notice.class, notice.instance, notice.sender,
              (notice.checkedAuth == zephyr.ZAUTH_YES) ?
              "AUTHENTIC" : "UNAUTHENTIC",
              notice.opcode, notice.body[0], notice.body[1]);

  var msg = {
    time: notice.time,
    class: notice.class,
    instance: notice.instance,
    sender: notice.sender,
    recipient: notice.recipient,
    realm: zuserRealm(notice.recipient),
    auth: notice.auth,
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
    msg.body = notice.body[1];
  } else {
    msg.signature = '';
    msg.body = notice.body[0] || '';
  }
  for (var id in connections) {
    connections[id].emit('message', msg);
  }
});

io.sockets.on('connection', function(socket) {
  connections[socket.id] = socket;
  socket.on('end', function() {
    delete connections[socket.id];
  });
});

server.listen(8080);
