var express = require('express');
var zephyr = require('zephyr');

zephyr.openPort();

zephyr.on('notice', function(msg) {
  // Skip the random ACKs.
  if (msg.kind == zephyr.HMACK ||
      msg.kind == zephyr.SERVACK ||
      msg.kind == zephyr.SERVNAK) {
    return;
  }

  console.log("%s / %s / %s %s [%s] (%s)\n%s",
              msg.class, msg.instance, msg.sender,
              (msg.checkedAuth == zephyr.ZAUTH_YES) ?
              "AUTHENTIC" : "UNAUTHENTIC",
              msg.opcode, msg.body[0], msg.body[1]);
});

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
app.listen(8080);
