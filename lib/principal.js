var zephyr = require('zephyr');

// Kerberos principal parsing and serializing code. Forked from
// Webathena and tweaked to remove the nameType thing. We don't care
// about that.

// TODO(davidben): Probably good to also have the realm in config.js?
// It's not even clear we need the parsing functions anyway.

var Principal = function(name, realm) {
  this.name = name;
  this.realm = realm;
};
function krbEscape(str) {
  // From src/lib/krb5/krb/unparse.c. Escape \0, \n, \t, \b, \\, \/,
  // and \@.  Other characters as-is.
  return str.replace("\\", "\\\\")
    .replace("\0", "\\0")
    .replace("\n", "\\n")
    .replace("\t", "\\t")
    .replace("\b", "\\b")
    .replace("/", "\\/")
    .replace("@", "\\@");
};
Principal.prototype.nameToString = function() {
  var escaped = [];
  for (var i = 0; i < this.name.length; i++) {
    escaped.push(krbEscape(this.name[i]));
  }
  return escaped.join("/");
};
Principal.prototype.toString = function() {
  return this.nameToString() + "@" + krbEscape(this.realm);
};
Principal.prototype.toStringShort = function() {
  // Ugh, circular dependency between modules.
  if (this.realm == zephyr.getRealm())
    return this.nameToString();
  return this.toString();
}
Principal.fromString = function(str) {
  var components = [];
  var component = "";
  var seenAt = false;
  for (var i = 0; i < str.length; i++) {
    if (str[i] == "\\") {
      i++;
      if (i >= str.length)
        throw "Malformed principal";
      switch (str[i]) {
      case "n": component += "\n"; break;
      case "t": component += "\t"; break;
      case "b": component += "\b"; break;
      case "0": component += "\0"; break;
      default: component += str[i];
      }
    } else if (str[i] == "/") {
      if (seenAt)
        throw "Malformed principal";
      components.push(component);
      component = "";
    } else if (str[i] == "@") {
      if (seenAt)
        throw "Malformed principal";
      components.push(component);
      component = "";
      seenAt = true;
    } else {
      component += str[i];
    }
  }
  if (!seenAt) {
    components.push(component);
    // If no realm, use the default.
    component = zephyr.getRealm();
  }
  return new Principal(components, component);
}

exports.Principal = Principal;
