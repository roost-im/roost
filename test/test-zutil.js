var assert = require('chai').assert;
var zephyr = require('zephyr');

var zutil = require('../lib/zutil.js');

// Initialize zephyr for zephyr.getRealm().
zephyr.initialize();

describe('realm', function() {
  it('should handle the default realm', function() {
    assert.strictEqual(zutil.realm('davidben'), zephyr.getRealm());
    assert.strictEqual(zutil.realm(''), zephyr.getRealm());
  });

  it('should handle cross-realm recipients', function() {
    assert.strictEqual(zutil.realm('@ZONE.MIT.EDU'), 'ZONE.MIT.EDU');
    assert.strictEqual(zutil.realm('davidben@ZONE.MIT.EDU'), 'ZONE.MIT.EDU');
  });

  it('should handle trailing @s', function() {
    assert.strictEqual(zutil.realm('davidben@'), zephyr.getRealm());
    assert.strictEqual(zutil.realm('@'), zephyr.getRealm());
  });
});

describe('isPersonal', function() {
  it('should include users', function() {
    assert.isTrue(zutil.isPersonal('davidben'));
    assert.isTrue(zutil.isPersonal('davidben@ATHENA.MIT.EDU'));
  });

  it('should not include realms', function() {
    assert.isFalse(zutil.isPersonal('@ZONE.MIT.EDU'));
  });

  it('should not include the empty string', function() {
    assert.isFalse(zutil.isPersonal(''));
  });
});

describe('isValidString', function() {
  it('should only include strings', function() {
    assert.isTrue(zutil.isValidString('foo'));
    assert.isFalse(zutil.isValidString(null));
    assert.isFalse(zutil.isValidString(undefined));
    assert.isFalse(zutil.isValidString(true));
    assert.isFalse(zutil.isValidString(42));
    assert.isFalse(zutil.isValidString([1,2,3]));
    assert.isFalse(zutil.isValidString({foo: 'bar'}));
  });

  it('should not allow NULs', function() {
    assert.isFalse(zutil.isValidString('\0'));
    assert.isFalse(zutil.isValidString('foo\0bar'));
    assert.isFalse(zutil.isValidString('\0baz'));
  });
});