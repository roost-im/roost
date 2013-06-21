function NetworkError(msg) {
  this.msg = msg;
}
NetworkError.prototype.toString = function() {
  return "Network error";
};
function HttpError(status, statusText, responseText) {
  this.status = status;
  this.statusText = statusText;
  this.responseText = responseText;
}
HttpError.prototype.toString = function() {
  return this.responseText;
};

function corsRequest(method, url, data) {
  var xhr = new XMLHttpRequest();
  if ("withCredentials" in xhr) {
    // XHR with CORS
    xhr.open(method, url, true);
  } else if (typeof XDomainRequest != "undefined") {
    // XDomainRequest for IE9.
    xhr = new XDomainRequest();
    xhr.open(method, url);
  } else {
    return Q.reject("CORS not supported.");
  }

  var deferred = Q.defer();
  xhr.onload = function() {
    if (this.status == 200) {
      deferred.resolve(this.responseText);
    } else if (this.status) {
      deferred.reject(new HttpError(this.status, this.statusText,
                                    this.responseText));
    } else {
      deferred.reject(new NetworkError());
    }
  };
  xhr.onerror = function() {
    deferred.reject("Request failed");
  };

  if (data !== undefined) {
    // TODO(davidben): Make the server handle text/plain Content-Types
    // too for IE9.
    if (xhr.setRequestHeader)
      xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(JSON.stringify(data));
  } else {
    xhr.send();
  }
  return deferred.promise;
}

var RECONNECT_DELAY = 500;
var RECONNECT_TRIES = 10;

function API(urlBase) {
  io.EventEmitter.call(this);
  this.urlBase_ = urlBase;
  this.token_ = null;

  this.socket_ = null;
  this.socketPending_ = false;
  this.reconnectDelay_ = RECONNECT_DELAY;
  this.reconnectTries_ = RECONNECT_TRIES;

  this.tryConnectSocket_();

  // If we go online, try to reconnect then and there.
  window.addEventListener("online", this.tryConnectSocket_.bind(this));
}
API.prototype = Object.create(io.EventEmitter.prototype);

API.prototype.refreshAuthToken_ = function() {
  // TODO(davidben): Actually authenticate and stuff. This will
  // potentially require emitting an event or something else to pop up
  // a dialog (with a button to Webathena) when cached tickets expire.
  return corsRequest("POST", this.urlBase_ + "/api/v1/auth", {
    principal: "davidben@ATHENA.MIT.EDU"
  }).then(function(json) {
    var resp = JSON.parse(json);
    this.token_ = resp.authToken;
    return this.token_;
  }.bind(this));
};

API.prototype.badToken_ = function() {
  console.log("Bad token!");
  this.token_ = null;
};

API.prototype.getAuthToken_ = function() {
  if (this.token_)
    return Q(this.token_);
  return this.refreshAuthToken_();
};

API.prototype.request = function(method, path, params, data, isRetry) {
  return this.getAuthToken_().then(function(token) {
    var url =
      this.urlBase_ + path + "?access_token=" + encodeURIComponent(token);
    for (var key in params) {
      url += "&" + key + "=" + encodeURIComponent(params[key]);
    }
    return corsRequest(method, url, data).then(function(responseText) {
      return JSON.parse(responseText);
    }, function(err) {
      // 401 means we had a bad token (it may have expired). Refresh it.
      if (err instanceof HttpError && err.status == 401) {
        this.badToken_();
        // TODO(davidben): Retry the request after we get a new
        // one. Only retry it once though.
        if (!isRetry)
          return this.request(method, path, params, data, true);
      }
      throw err;
    }.bind(this));
  }.bind(this));
};

API.prototype.get = function(path, params) {
  return this.request("GET", path, params);
};

API.prototype.post = function(path, data) {
  return this.request("POST", path, {}, data);
};

API.prototype.socket = function() {
  return this.socket_;
};

API.prototype.tryConnectSocket_ = function() {
  if (this.socket_ || this.socketPending_)
    return;

  this.socketPending_ = true;
  this.getAuthToken_().then(function(token) {
    // Socket.IO's reconnect behavior is weird (it buffers up what you
    // send and such). Don't bother. Also implementing it ourselves
    // means we can integrate with navigator.onLine and the like.
    var url =  this.urlBase_ + "/?access_token=" + encodeURIComponent(token);
    var socket = io.connect(url, {
      "reconnect": false,
      "force new connection": true
    });

    socket.once("connect", function() {
      this.socketPending_ = false;
      this.socket_ = socket;
      // Reset reconnect state.
      this.reconnectDelay_ = RECONNECT_DELAY;
      this.reconnectTries_ = RECONNECT_TRIES;

      this.emit("connect");
      this.socket_.once("disconnect", function() {
        this.emit("disconnect");
        this.socket_ = null;

        setTimeout(this.tryConnectSocket_.bind(this), this.reconnectDelay_);
      }.bind(this));
    }.bind(this));

    // Ensure only one of error and connect_failed are handled.
    var cancelled = false;
    socket.once("error", function(err) {
      if (cancelled) return;
      cancelled = true;
      this.socketPending_ = false;
      // Blegh. Retry with a new token.
      if (err == "handshake unauthorized") {
        this.badToken_();
      }

      // Reconnect with exponential back-off.
      this.reconnectDelay_ *= 2;
      if (this.reconnectTries_-- > 0) {
        setTimeout(this.tryConnectSocket_.bind(this), this.reconnectDelay_);
      }
    }.bind(this));

    socket.once("connect_failed", function() {
      if (cancelled) return;
      cancelled = true;
      this.socketPending_ = false;
      // Reconnect with exponential back-off.
      this.reconnectDelay_ *= 2;
      if (this.reconnectTries_-- > 0) {
        setTimeout(this.tryConnectSocket_.bind(this), this.reconnectDelay_);
      }
    }.bind(this));

  }.bind(this), function(err) {
    // Failure to get auth token... should this also reconnect?
    this.socketPending_ = false;
    throw err;
  }.bind(this)).done();
};