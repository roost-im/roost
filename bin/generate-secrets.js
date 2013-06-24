#!/usr/bin/env node

var crypto = require('crypto');
var fs = require('fs');

var args = process.argv.slice(2);
var oldFile, newFile;
if (args.length == 1) {
  newFile = args[0];
} else if (args.length == 2) {
  oldFile = args[0];
  newFile = args[1];
} else {
  console.error('Usage: %s %s [OLDFILE] NEWFILE', process.argv[0], process.argv[1]);
  process.exit();
}

var config = { };
// If we supplied an old file, merge it in.
if (oldFile)
  config = JSON.parse(fs.readFileSync(oldFile, {encoding: 'utf8'}));

['msgidSecret', 'sessionSecret'].forEach(function(key) {
  if (key in config)
    return;
  // Generate a new secret.
  var buf = crypto.randomBytes(128);
  config[key] = buf.toString('base64');
});

// Write out the new config.
fs.writeFileSync(newFile, JSON.stringify(config, null, 2), {encoding: 'utf8'});