var convict = require('convict');

// TODO(davidben): Is there a less stupid way to do this?
var DEFAULT_SECRET = '<default secret blargh>';

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
    default: DEFAULT_SECRET
  },
  sessionSecret: {
    doc: 'Secret key for sessions.',
    format: String,
    default: DEFAULT_SECRET
  },
  sessionLifetime: {
    doc: 'How long session tokens are valid for, in milliseconds.',
    format: 'nat',
    default: 7 * 24 * 60 * 60 * 1000
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
});

if (process.env.CONFIG_FILES)
  conf.loadFile(process.env.CONFIG_FILES.split(','));
conf.validate();

// TODO(davidben): Is there a less stupid way to do this?
['msgidSecret', 'sessionSecret'].forEach(function(key) {
  if (conf.get(key) == DEFAULT_SECRET) {
    console.error('!!!!!!!!!!!!!!!!!!!!!');
    console.error('Config \'%s\' not set.', key);
    console.error('Do NOT run this in production!');
    console.error('!!!!!!!!!!!!!!!!!!!!!');
  }
});

module.exports = conf;
