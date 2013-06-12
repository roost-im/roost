var api = new API(location.protocol + "//" + location.host);

(function() {
  api.apiRequest("GET", "/api/v1/subscriptions").then(function(subs) {
    log("Currently subscribed to:");
    subs.forEach(function(sub) {
      var inst = sub.instance == null ? '*' : sub.instance;
      log(" <" + sub.class + "," + inst + "," + sub.recipient + ">");
    });
  }, function(err) {
    log("Failed to get subscriptions: " + err);
    throw err;
  }).done();
})();

var creds = null;
function getZephyrCreds() {
  if (creds)
    return Q(creds);
  var deferred = Q.defer();
  WinChan.open({
    url: "https://webathena.mit.edu/#!request_ticket_v1",
    relay_url: "https://webathena.mit.edu/relay.html",
    params: {
      services: [
        {
          realm: 'ATHENA.MIT.EDU',
          principal: ['zephyr', 'zephyr'],
        }
      ]
    }
  }, function (err, r) {
    console.log("got reply", err, r);
    if (err) {
      deferred.reject(err);
      return;
    }
    if (r.status !== "OK") {
      deferred.reject(r);
      return;
    }
    creds = r.sessions[0];
    deferred.resolve(creds);
  });
  return deferred.promise;
}

document.getElementById("clearlog").addEventListener("click", function(ev) {
  document.getElementById("log").textContent = "";
});

document.getElementById("subscribe").addEventListener("submit", function(ev) {
  ev.preventDefault();

  var msgClass = this.class.value;
  var msgInstance = this.instance.value;
  if (msgInstance == '*') msgInstance = null; // Meh.
  var msgRecipient = this.recipient.value;
  if (msgRecipient == "%me%")
    msgRecipient = "davidben@ATHENA.MIT.EDU";

  var credsPromise;
  if (msgRecipient && msgRecipient[0] !== '@') {
    credsPromise = getZephyrCreds();
  } else {
    credsPromise = Q();
  }
  credsPromise.then(function(creds) {
    var data = {
      subscription: {
        class: msgClass,
        instance: msgInstance,
        recipient: msgRecipient
      },
      credentials: creds
    };
    return api.apiRequest("POST", "/api/v1/subscribe", {}, data).then(function() {
      log("Subscribed to " + msgClass);
    });
  }, function(err) {
    log("Failed to subscribed to " + msgClass + ": " + err);
    throw err;
  }).done();
});

document.getElementById("unsubscribe").addEventListener("submit", function(ev) {
  ev.preventDefault();

  var msgClass = this.class.value;
  var msgInstance = this.instance.value;
  if (msgInstance == '*') msgInstance = null; // Meh.
  var msgRecipient = this.recipient.value;
  if (msgRecipient == "%me%")
    msgRecipient = "davidben@ATHENA.MIT.EDU";

  var data = {
    subscription: {
      class: msgClass,
      instance: msgInstance,
      recipient: msgRecipient
    }
  };
  api.apiRequest("POST", "/api/v1/unsubscribe", {}, data).then(function() {
    log("Unsubscribed from " + msgClass);
  }, function(err) {
    log("Failed to unsubscribed from " + msgClass + ": " + err);
    throw err;
  }).done();
});

document.getElementById("getmessages").addEventListener("submit", function(ev) {
  ev.preventDefault();

  var params = {
    offset: this.offset.value,
    count: '10'
  };
  api.apiRequest("GET", "/api/v1/messages", params).then(function(result) {
    result.messages.forEach(function(msg) {
      log(msg.id + ": " + msg.class + " / " + msg.instance + " / " +
          msg.sender + " " + new Date(msg.time) + "\n" +
          msg.message + "\n");
    });
  }, function(err) {
    log("Failed to get messages: " + err);
  }).done();
});

function log(msg) {
  document.getElementById("log").textContent += msg + "\n";
}
