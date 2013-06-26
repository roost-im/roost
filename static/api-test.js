var ticketManager = new TicketManager("https://webathena.mit.edu");
var api = new API(location.protocol + "//" + location.host,
                  "HTTP/roost-api.mit.edu",
                  ticketManager);

var dialog = null;
ticketManager.on("ticket-needed", function() {
  if (dialog)
    return;
  var dialogTemplate = document.getElementById(
    ticketManager.isLoggedIn() ? "renew-template" : "login-template");
  dialog = dialogTemplate.cloneNode(true);
  dialog.id = null;
  dialog.removeAttribute("hidden");

  dialog.querySelector(".login-button").addEventListener("click", function(ev) {
    ticketManager.ticketPromptIfNeeded();
  });

  // Close the dialog when we get our tickets.
  Q.all(
    [ticketManager.getTicket("server"), ticketManager.getTicket("zephyr")]
  ).then(function() {
    document.body.removeChild(dialog);
    dialog = null;
  }).done();

  document.body.appendChild(dialog);
});
ticketManager.on("user-mismatch", function() {
  console.log("User mismatch do something useful");
});
ticketManager.on("webathena-error", function() {
  console.log("Webathena error do something useful");
});

function checkCreds() {
  api.get("/api/v1/zephyrcreds").then(function(result) {
    if (result.needsRefresh) {
      log("Needs credential refresh");
    } else {
      log("Zephyr credentials up-to-date");
    }
  }, function(err) {
    log("Error checking inner demon status: " + err);
  }).done();
}

document.getElementById("clearlog").addEventListener("click", function(ev) {
  document.getElementById("log").textContent = "";
});

document.getElementById("subscribe").addEventListener("submit", function(ev) {
  ev.preventDefault();

  var msgClass = this.class.value;
  var msgInstance = this.instance.value;
  var msgRecipient = this.recipient.value;
  if (msgRecipient == "%me%")
    msgRecipient = "davidben@ATHENA.MIT.EDU";

  var withZephyr = (msgRecipient && msgRecipient[0] !== '@') ? true : false;
  var data = {
    subscription: {
      class: msgClass,
      instance: msgInstance,
      recipient: msgRecipient
    },
  };
  return api.post("/api/v1/subscribe", data, {
    withZephyr: withZephyr,
    interactive: true
  }).then(function() {
    log("Subscribed to " + msgClass);
  }, function(err) {
    log("Failed to subscribed to " + msgClass + ": " + err);
    throw err;
  }).done();
});

document.getElementById("unsubscribe").addEventListener("submit", function(ev) {
  ev.preventDefault();

  var msgClass = this.class.value;
  var msgInstance = this.instance.value;
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
  api.post("/api/v1/unsubscribe", data, {interactive:true}).then(function() {
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
  api.get("/api/v1/messages", params, {
    interactive:true
  }).then(function(result) {
    result.messages.forEach(function(msg) {
      log(msg.id + ": " + msg.class + " / " + msg.instance + " / " +
          msg.sender + " " + new Date(msg.time) + "\n" +
          msg.message + "\n");
    });
  }, function(err) {
    log("Failed to get messages: " + err);
  }).done();
});

document.getElementById("checkdemon").addEventListener("click", function(ev) {
  api.get("/api/v1/zephyrcreds", {}, {interactive:true}).then(function(result) {
    if (result.needsRefresh) {
      log("Needs credential refresh");
    } else {
      log("Zephyr credentials up-to-date");
    }
  }, function(err) {
    log("Error checking inner demon status: " + err);
  }).done();
});

document.getElementById("refreshcreds").addEventListener("click", function(ev) {
  api.post("/api/v1/zephyrcreds", {}, {
    withZephyr: true,
    interactive: true
  }).then(function() {
    log("Refreshed");
  }, function(err) {
    log("Error refreshing creds: " + err);
  }).done();
});

function log(msg) {
  document.getElementById("log").textContent += msg + "\n";
}

(function() {
  api.get("/api/v1/subscriptions").then(function(subs) {
    log("Currently subscribed to:");
    subs.forEach(function(sub) {
      log(" <" + sub.class + "," + sub.instance + "," + sub.recipient + ">");
    });
  }, function(err) {
    log("Failed to get subscriptions: " + err);
    throw err;
  }).done();
  checkCreds();
})();
