const Promise = require('bluebird');
const { strict: assert } = require('assert');
const { expect } = require('chai');
const { faker } = require('@faker-js/faker');
const ld = require('lodash');
const redisKey = require('../../../src/utils/key');
const { USERS_INDEX, USERS_METADATA } = require('../../../src/constants');

const getUserName = (audience) => (data) => data.metadata[audience].username;

const sortByCaseInsensitive = (getMember) => (list) => list
  .sort((a, b) => getMember(a).toLowerCase() < getMember(b).toLowerCase());

const createUser = (id, { username, firstName, lastName } = {}) => ({
  id,
  metadata: {
    username: username || faker.internet.email(),
    firstName: firstName || faker.name.firstName(),
    lastName: lastName || faker.name.lastName(),
  },
});

const saveUser = (redis, audience, user) => redis
  .pipeline()
  .sadd(USERS_INDEX, user.id)
  .hmset(
    redisKey(user.id, USERS_METADATA, audience),
    ld.mapValues(user.metadata, JSON.stringify.bind(JSON))
  )
  .exec();

describe('Redis Search: list', function listSuite() {
  this.timeout(50000);

  const ctx = {
    redisSearch: {
      enabled: true,
    },
  };

  const totalUsers = 10;

  beforeEach(async function startService() {
    await global.startService.call(this, ctx);
  });
  afterEach('reset redis', global.clearRedis);

  beforeEach('populate redis', function populateRedis() {
    const audience = this.users.config.jwt.defaultAudience;
    const promises = [];

    ld.times(totalUsers, () => {
      const user = createUser(this.users.flake.next());
      const item = saveUser(this.users.redis, audience, user);
      promises.push(item);
    });

    const people = [
      { username: 'ann@gmail.org', firstName: 'Ann', lastName: faker.lastName },
      { username: 'johnny@gmail.org', firstName: 'Johhny', lastName: faker.lastName },
      { username: 'joe@yahoo.org', firstName: 'Joe', lastName: faker.lastName },
      { username: 'ann@yahoo.org', firstName: 'Anna', lastName: faker.lastName },
      { username: 'kim@yahoo.org', firstName: 'Kim', lastName: 'Joe' },
    ];

    for (const x of people) {
      const user = createUser(this.users.flake.next(), { ...x });
      const inserted = saveUser(this.users.redis, audience, user);
      promises.push(inserted);
    }

    this.audience = audience;
    this.extractUserName = getUserName(this.audience);

    this.filteredListRequest = (filter, criteria = 'username') => {
      return this.users
        .dispatch('list', {
          params: {
            criteria,
            audience: this.audience,
            filter,
          },
        });
    };

    this.userStubs = Promise.all(promises);
    return this.userStubs;
  });

  it('responds with error when index not created', async function test() {
    const query = {
      params: {
        audience: 'not-existing-audience',
      },
    };

    await assert.rejects(
      this.users.dispatch('list', query),
      /Search index does not registered for/
    );
  });

  it('list by username', function test() {
    return this
      .users
      .dispatch('list', {
        params: {
          offset: 0,
          limit: 10,
          criteria: 'username', // sort by
          audience: this.audience,
          filter: {
            username: 'yahoo',
          },
        },
      })
      .then((result) => {
        expect(result.users).to.have.length.lte(10);
        expect(result.users.length);

        result.users.forEach((user) => {
          expect(user).to.have.ownProperty('id');
          expect(user).to.have.ownProperty('metadata');
          expect(user.metadata[this.audience]).to.have.ownProperty('firstName');
          expect(user.metadata[this.audience]).to.have.ownProperty('lastName');
        });

        const copy = [].concat(result.users);
        sortByCaseInsensitive(this.extractUserName)(copy);

        copy.forEach((data) => {
          expect(data.metadata[this.audience].username).to.match(/yahoo/i);
        });

        expect(copy).to.be.deep.eq(result.users);
      });
  });

  it('list by first name', function test() {
    return this
      .filteredListRequest({ firstName: 'Johhny' }, 'firstName')
      .then((result) => {
        assert(result);
        expect(result.users).to.have.length(1);
        const [u1] = result.users;

        assert(u1);
        const uname = this.extractUserName(u1);
        expect(uname).to.be.equal('johnny@gmail.org');
      });
  });

  it('responds with empty list by full username', function test() {
    return this
      .filteredListRequest({ username: '"ann@gmail.org"' })
      .then((result) => {
        assert(result);
        expect(result.users).to.have.length(0);
      });
  });

  it('responds with empty list if username has 2 tokens', function test() {
    return this
      .filteredListRequest({ username: 'yahoo.org' })
      .then((result) => {
        assert(result);
        expect(result.users).to.have.length(0);
      });
  });

  it('user list if username has only 1 token', function test() {
    return this
      .filteredListRequest({ username: 'org' })
      .then((result) => {
        assert(result);
        expect(result.users).to.have.length.gte(4);
      });
  });

  it('list with #multi fields', function test() {
    return this
      .filteredListRequest({
        '#multi': {
          fields: [
            'firstName',
            'lastName',
          ],
          match: 'Joe',
        },
      })
      .then((result) => {
        assert(result);
        expect(result.users).to.have.length.gte(2);

        const copy = [].concat(result.users);
        sortByCaseInsensitive(this.extractUserName)(copy);

        const [u1, u2] = copy;
        expect(this.extractUserName(u1)).to.be.equal('joe@yahoo.org');
        expect(this.extractUserName(u2)).to.be.equal('kim@yahoo.org');
      });
  });

  it('list: EQ action', function test() {
    return this
      .filteredListRequest({ username: { eq: 'kim@yahoo.org' } })
      .then((result) => {
        assert(result);
        expect(result.users).to.have.length(0);
      });
  });

  it('list: MATCH action with one token', function test() {
    // @firstName:($f_firstName_m*) PARAMS 2 f_firstName_m Johhny
    return this
      .filteredListRequest({ firstName: { match: 'Johhny' } })
      .then((result) => {
        assert(result);
        expect(result.users).to.have.length.gte(1);
      });
  });

  it('list: MATCH action with many tokens', function test() {
    //  @username:($f_username_m*) PARAMS 2 f_username_m \"johnny@gmail.org\"
    return this
      .filteredListRequest({ username: { match: 'johnny@gmail.org"' } })
      .then((result) => {
        assert(result);
        expect(result.users).to.have.length(0);
      });
  });

  it('list: NE action', function test() {
    return this
      .filteredListRequest({ username: { ne: 'gmail' } })
      .then((result) => {
        assert(result);
        expect(result.users).to.have.length.gte(2);

        result.users.forEach((user) => {
          const username = this.extractUserName(user);
          const domain = username.split('@')[1];
          expect(domain).to.have.length.gte(1);
          // TODO expect(domain.includes('gmail')).to.equal(false)
        });
      });
  });
});
