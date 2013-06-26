"use strict"

function webathenaRequest(webathenaRoot, params) {
  var deferred = Q.defer();
  var channel = WinChan.open({
    url: webathenaRoot + "/#!request_ticket_v1",
    relay_url: webathenaRoot + "/relay.html",
    params: params
  }, function (err, r) {
    if (err) {
      deferred.reject(err);
      return;
    }
    if (r.status !== "OK") {
      deferred.reject(r);
      return;
    }
    deferred.resolve(r.sessions.map(krb.Session.fromDict));
  });
  // Bah.
  return [deferred.promise, channel];
}

// TODO(davidben): Make this much much fancier. Periodically check on
// the state of tickets and emit an event when they're expiring. Also
// the iframe ticket renewal remember state thing Webathena-side. Yeah, I dunno.

var MINIMUM_LIFETIME = 10 * 60 * 1000;

function TicketManager(webathenaRoot) {
  io.EventEmitter.call(this);

  this.webathenaRoot_ = webathenaRoot;
  this.sessions_ = null;
  this.waitForSession_ = Q.defer();
  this.pendingRequest_ = null;

  this.expectedPrincipal_ = null;

  window.addEventListener("storage", this.loadFromStorage_.bind(this));
  this.loadFromStorage_();
}
TicketManager.prototype = Object.create(io.EventEmitter.prototype);

TicketManager.prototype.checkUser_ = function(sessions) {
  var principal = sessions.server.client.toString();
  if (this.expectedPrincipal_ == null) {
    this.expectedPrincipal_ = principal;
  } else if (this.expectedPrincipal_ !== principal) {
    this.emit("user-mismatch", principal, this.expectedPrincipal_);
    return false;
  }

  principal = sessions.zephyr.client.toString();
  if (this.expectedPrincipal_ !== principal) {
    this.emit("user-mismatch", principal, this.expectedPrincipal_);
    return false;
  }
  return true;
};

TicketManager.prototype.isLoggedIn = function() {
  return this.expectedPrincipal_ != null;
};

TicketManager.prototype.loadFromStorage_ = function() {
  var data = localStorage.getItem("sessions");
  if (!data) {
    // TODO(davidben): We just discovered we were logged out in
    // another window. Do something useful.
    return;
  }
  var sessionsDict = JSON.parse(data);
  var sessions = {
    server: krb.Session.fromDict(sessionsDict.server),
    zephyr: krb.Session.fromDict(sessionsDict.zephyr)
  };
  if (!this.checkUser_(sessions))
    return;
  if (sessions.server.timeRemaining() <= MINIMUM_LIFETIME ||
      sessions.zephyr.timeRemaining() <= MINIMUM_LIFETIME) {
    return;
  }
  this.handleNewSessions_(sessions);
};

TicketManager.prototype.refreshInteractive_ = function() {
  // If there is already a pending request, just focus it.
  if (this.pendingRequest_) {
    this.pendingRequest_.focus();
    return;
  }

  // Fire a new one.
  var r = webathenaRequest(this.webathenaRoot_, {
    services: [
      {
        principal: ["HTTP", "roost-api.mit.edu"],
        realm: "ATHENA.MIT.EDU"
      },
      {
        principal: ["zephyr", "zephyr"],
        realm: "ATHENA.MIT.EDU"
      }
    ]
  });
  var promise = r[0], channel = r[1];
  this.pendingRequest_ = channel;
  promise.then(function(ret) {
    this.pendingRequest_ = null;
    var sessions = {
      server: ret[0],
      zephyr: ret[1]
    };
    if (!this.checkUser_(sessions))
      return;
    localStorage.setItem("sessions", JSON.stringify({
      server: sessions.server.toDict(),
      zephyr: sessions.zephyr.toDict()
    }));
    this.handleNewSessions_(sessions);
  }.bind(this), function(err) {
    this.pendingRequest_ = null;
    this.emit("webathena-error", err);
  }.bind(this)).done();
};

TicketManager.prototype.handleNewSessions_ = function(sessions) {
  // Save locally.
  this.sessions_ = sessions;
  // Unblock any promises.
  this.waitForSession_.resolve(sessions);
  this.waitForSession_ = Q.defer();
};

TicketManager.prototype.getTicket = function(which, interactive, data) {
  // If we have one saved, use it.
  if (this.sessions_ &&
      this.sessions_[which].timeRemaining() > MINIMUM_LIFETIME) {
    return Q(this.sessions_[which]);
  }

  if (interactive) {
    this.refreshInteractive_();
  } else {
    this.emit("ticket-needed", data);
  }

  return this.waitForSession_.promise.then(function(sessions) {
    return sessions[which];
  });
};

TicketManager.prototype.ticketPromptIfNeeded = function(which) {
  if (this.sessions_ &&
      this.sessions_[which].timeRemaining() > MINIMUM_LIFETIME) {
    return;
  }

  this.refreshInteractive_();
};