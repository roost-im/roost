var convict = require('convict');

var conf = convict({
  ip: {
    doc: 'The IP address to bind.',
    format: 'ipaddress',
    default: '127.0.0.1',
    env: 'IP_ADDRESS',
  },
  port: {
    doc: 'The port to bind.',
    format: 'port',
    default: 8080,
    env: 'PORT'
  },
  msgidSecret: {
    doc: 'Secret key for masking message ids.',
    format: String,
    default: ''
  },
  sessionSecret: {
    doc: 'Secret key for sessions.',
    format: String,
    default: ''
  },
  sessionLifetime: {
    doc: 'How long session tokens are valid for, in milliseconds.',
    format: 'nat',
    default: 30 * 24 * 60 * 60 * 1000
  },
  db: {
    host: {
      format: String,
      default: 'localhost',
    },
    port: {
      format: 'port',
      default: 3306,
    },
    user: {
      format: String,
      default: 'roost_dev',
    },
    password: {
      format: String,
      default: '',
    },
    database: {
      format: String,
      default: 'roost_dev',
    },
  },
  serverKeytab: {
    format: String,
    default: ''
  }
});

if (process.env.CONFIG_FILES)
  conf.loadFile(process.env.CONFIG_FILES.split(','));
conf.validate();

// TODO(davidben): Is there a less stupid way to do this?
['msgidSecret', 'sessionSecret'].forEach(function(key) {
  if (!conf.get(key)) {
    console.error('Missing secret \'%s\'', key);
    console.error('Please run bin/generate-secrets.js and supply the');
    console.error('file via the CONFIG_FILES variable.')
    process.exit(1);
  }
});

module.exports = conf;
