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
    auth: notice.auth,
    // FIXME: Is this how you parse the body??
    body: notice.body[1],
    signature: notice.body[0],
    opcode: notice.opcode
  };
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
