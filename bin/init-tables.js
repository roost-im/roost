#!/usr/bin/env node

var db = require('../lib/db');

db.initTables().then(function() {
  console.log("Done");
  process.exit();
}, function(err) {
  console.error(err);
  process.exit();
}).done();