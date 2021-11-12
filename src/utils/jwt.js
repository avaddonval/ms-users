const Promise = require('bluebird');
const jwtLib = Promise.promisifyAll(require('jsonwebtoken'));

const {
  USERS_INVALID_TOKEN,
  USERS_AUDIENCE_MISMATCH,
  USERS_USERNAME_FIELD,
  USERS_ID_FIELD,
} = require('../constants');
const getMetadata = require('./get-metadata');

const legacyJWT = require('./jwt-legacy');
const statelessJWT = require('./jwt-stateless');

const {
  assertRefreshToken,
  isStatelessToken, isStatelessEnabled,
  assertStatelessEnabled,
} = statelessJWT;

const {
  verifyData,
  signData,
  internal,
} = legacyJWT;

module.exports = exports = {
  verifyData,
  signData,
  internal,
};

const mapJWT = (userId, { jwt, jwtRefresh }, metadata) => ({
  jwt,
  jwtRefresh,
  user: {
    [USERS_ID_FIELD]: userId,
    metadata,
  },
});

/**
 * Verify data
 * @param  {String} token
 * @param  {Object} tokenOptions
 * @return {Promise}
 */
async function decodeAndVerify(service, token, audience) {
  const { jwt: { secret, extra, issuer, hashingFunction } } = service.config;
  try {
    // should await here, otherwise jwt.Error thrown
    const decoded = await jwtLib.verifyAsync(token, secret, {
      ...extra,
      audience,
      issuer,
      algorithms: [hashingFunction],
    });
    return decoded;
  } catch (e) {
    service.log.debug('error decoding token', e);
    throw USERS_INVALID_TOKEN;
  }
}

const getAudience = (defaultAudience, audience) => {
  if (audience !== defaultAudience) {
    return [audience, defaultAudience];
  }

  return [audience];
};

const nopFn = () => {};

exports.login = async function login(userId, _audience, stateless = false) {
  const { defaultAudience, stateless: { force, enabled } } = this.config.jwt;

  const audience = _audience || defaultAudience;
  const metadataAudience = getAudience(defaultAudience, audience);

  const tokenFlow = force || (enabled && stateless)
    ? () => statelessJWT.login(this, userId, audience)
    : () => legacyJWT.login(this, userId, audience);

  const [flowResult, metadata] = await Promise.all([
    tokenFlow(),
    getMetadata.call(this, userId, metadataAudience),
  ]);

  return mapJWT(userId, flowResult, metadata);
};

exports.logout = async function logout(token, audience) {
  const decodedToken = await decodeAndVerify(this, token, audience);

  assertRefreshToken(decodedToken);

  await Promise.all([
    legacyJWT.logout(this, token, decodedToken),
    isStatelessEnabled(this)
      ? statelessJWT.logout(this, decodedToken)
      : nopFn,
  ]);

  return { success: true };
};

// Should check old tokens and new tokens
exports.verify = async function verifyToken(token, audience, peek) {
  const decodedToken = await decodeAndVerify(this, token, audience);

  if (audience.indexOf(decodedToken.aud) === -1) {
    throw USERS_AUDIENCE_MISMATCH;
  }
  const isStateless = isStatelessToken(decodedToken);

  // verify only legacy tokens
  if (!isStateless) {
    await legacyJWT.verify(this, token, decodedToken, peek);
  }

  // btw if someone passed stateless token
  if (isStateless) {
    assertStatelessEnabled(this);
    await statelessJWT.verify(this, decodedToken);
  }

  return decodedToken;
};

exports.reset = async function reset(userId) {
  const resetResult = await Promise.all([
    statelessJWT.reset(this, userId),
    isStatelessEnabled(this)
      ? legacyJWT.reset(this, userId)
      : nopFn,
  ]);

  return resetResult;
};

exports.refresh = async function refresh(token, audience) {
  assertStatelessEnabled(this);

  const decodedToken = await decodeAndVerify(this, token, audience);

  assertRefreshToken(decodedToken);

  const userId = decodedToken[USERS_USERNAME_FIELD];

  const { defaultAudience } = this.config.jwt;
  const metadataAudience = getAudience(defaultAudience, audience);

  const [refreshResult, metadata] = await Promise.all([
    statelessJWT.refresh(this, token, decodedToken, audience),
    getMetadata.call(this, userId, metadataAudience),
  ]);

  return mapJWT(userId, refreshResult, metadata);
};
