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

module.exports = conf;
