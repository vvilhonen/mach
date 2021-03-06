var RSVP = require('rsvp');
var utils = require('../utils');
var CookieStore = require('./session/cookie-store');
module.exports = Session;

var MAX_COOKIE_SIZE = 4096;

/**
 * A middleware that provides support for HTTP sessions using cookies.
 *
 * Accepts the following options:
 *
 * - secret         A cryptographically secure secret key that will be used to verify
 *                  the integrity of session data that is received from the client
 * - name           The name of the cookie. Defaults to "_session"
 * - path           The path of the cookie. Defaults to "/"
 * - domain         The cookie's domain. Defaults to null
 * - secure         True to only send this cookie over HTTPS. Defaults to false
 * - expireAfter    The number of seconds after which sessions expire. Defaults
 *                  to 0 (no expiration)
 * - httpOnly       True to restrict access to this cookie to HTTP(S) APIs.
 *                  Defaults to true
 * - store          An instance of a mach.session.Store subclass that is used
 *                  to store session data. Defaults to a new instance of
 *                  mach.session.CookieStore
 *
 * Note: Since cookies are only able to reliably store about 4k of data, if the
 * session cookie payload exceeds that the session will be dropped.
 */
function Session(app, options) {
  if (!(this instanceof Session))
    return new Session(app, options);

  options = options || {};

  if (typeof options === 'string')
    options = { secret: options };

  this._secret = options.secret;

  if (!this._secret) {
    console.warn([
      'WARNING: There was no "secret" option provided to mach.session! This poses',
      'a security vulnerability because session data will be stored on clients without',
      'any server-side verification that it has not been tampered with. It is strongly',
      'recommended that you set a secret to prevent exploits that may be attempted using',
      'carefully crafted cookies.'
    ].join('\n'));
  }

  this._name = options.name || '_session';
  this._path = options.path || '/';
  this._domain = options.domain;
  this._isSecure = options.secure || false;
  this._expireAfter = options.expireAfter || 0;

  if ('httpOnly' in options) {
    this._isHttpOnly = options.httpOnly || false;
  } else {
    this._isHttpOnly = true;
  }

  this._store = options.store || new CookieStore(options);
  this._app = app;
}

Session.prototype.apply = function (request) {
  var app = this._app;
  var cookieName = this._name;
  var expireAfter = this._expireAfter;

  if (request.session)
    return request.call(app); // Don't overwrite the existing session.

  var cookie = request.cookies[cookieName];
  var self = this;

  return RSVP.resolve(cookie && self.decodeCookie(cookie)).then(function (session) {
    request.session = session || {};

    return request.call(app).then(function (response) {
      return RSVP.resolve(request.session && self.encodeSession(request.session)).then(function (newCookie) {
        var expires = expireAfter && new Date(Date.now() + (expireAfter * 1000));

        // Don't bother setting the cookie if its value
        // hasn't changed and there is no expires date.
        if (newCookie === cookie && !expires)
          return response;

        utils.setCookie(response.headers, cookieName, {
          value: newCookie,
          path: self._path,
          domain: self._domain,
          expires: expires,
          httpOnly: self._isHttpOnly,
          secure: self._isSecure
        });

        return response;
      }, function (error) {
        request.error.write('Error encoding session data: ' + error);
        return response;
      });
    });
  }, function (error) {
    request.error.write('Error decoding session data: ' + error);
    return request.call(app);
  });
};

/**
 * Stores the given session and returns a promise for a value that should be stored
 * in the session cookie to retrieve the session data again on the next request.
 */
Session.prototype.encodeSession = function (session) {
  var secret = this._secret;

  return this._store.save(session).then(function (data) {
    var cookie = utils.encodeBase64(data + '--' + _makeHash(data, secret));

    if (cookie.length > MAX_COOKIE_SIZE)
      throw new Error('Cookie data size exceeds 4kb; content dropped');

    return cookie;
  });
};

/**
 * Decodes the given cookie value and returns a promise for the corresponding session
 * data from the store. Also verifies the hash value to ensure the cookie has not been
 * tampered with. If it has, returns null.
 */
Session.prototype.decodeCookie = function (cookie) {
  var value = utils.decodeBase64(cookie);
  var index = value.lastIndexOf('--');
  var data = value.substring(0, index);
  var hash = value.substring(index + 2);

  // Verify the cookie has not been tampered with.
  if (hash === _makeHash(data, this._secret))
    return this._store.load(data);

  return null;
};

function _makeHash(data, secret) {
  return utils.makeHash(secret ? data + secret : data);
}

var submodules = {
  CookieStore: './session/cookie-store',
  MemoryStore: './session/memory-store',
  RedisStore:  './session/redis-store'
};

Object.keys(submodules).forEach(function (name) {
  module.exports.__defineGetter__(name, function () {
    return require(submodules[name]);
  });
});
