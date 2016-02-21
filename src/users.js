const Mservice = require('mservice');
const path = require('path');
const Mailer = require('ms-mailer-client');
const Promise = require('bluebird');
const Errors = require('common-errors');
const merge = require('lodash/merge');
const fsort = require('redis-filtered-sort');
const { NotImplementedError } = Errors;
const times = require('lodash/times');
const { USERS_ADMIN_ROLE } = require('./constants.js');

// utils
const register = require('./actions/register.js');

/**
 * @namespace Users
 */
module.exports = class Users extends Mservice {

  /**
   * Configuration options for the service
   * @type {Object}
   */
  static defaultOpts = {
    debug: process.env.NODE_ENV === 'development',
    // keep inactive accounts for 30 days
    deleteInactiveAccounts: 30 * 24 * 60 * 60,
    // amqp plugin configuration
    amqp: {
      queue: 'ms-users',
      // prefix routes with users.
      prefix: 'users',
      // postfixes for routes that we support
      postfix: path.join(__dirname, 'actions'),
      // automatically init routes
      initRoutes: true,
      // automatically init router
      initRouter: true,
    },
    captcha: {
      secret: 'put-your-real-gcaptcha-secret-here',
      ttl: 3600, // 1 hour - 3600 seconds
      uri: 'https://www.google.com/recaptcha/api/siteverify',
    },
    redis: {
      options: {
        // must have {}, so that the keys end up on a single machine
        keyPrefix: '{ms-users}',
      },
    },
    pwdReset: {
      memorable: true,
      length: 10,
    },
    jwt: {
      defaultAudience: '*.localhost',
      hashingFunction: 'HS256',
      issuer: 'ms-users',
      secret: 'i-hope-that-you-change-this-long-default-secret-in-your-app',
      ttl: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
      lockAfterAttempts: 5,
      keepLoginAttempts: 60 * 60, // 1 hour
    },
    validation: {
      secret: 'please-replace-this-as-a-long-nice-secret',
      algorithm: 'aes-256-ctr',
      throttle: 2 * 60 * 60, // dont send emails more than once in 2 hours
      ttl: 4 * 60 * 60, // do not let password to be reset with expired codes
      paths: {
        activate: '/activate',
        reset: '/reset',
      },
      subjects: {
        activate: 'Activate your account',
        reset: 'Reset your password',
        password: 'Account Recovery',
      },
      senders: {
        activate: 'noreply <support@example.com>',
        reset: 'noreply <support@example.com>',
        password: 'noreply <support@example.com>',
      },
      templates: {
        // specify template names here
      },
      email: 'support@example.com',
    },
    server: {
      proto: 'http',
      host: 'localhost',
      port: 8080,
    },
    mailer: {
      prefix: 'mailer',
      routes: {
        adhoc: 'adhoc',
        predefined: 'predefined',
      },
    },
    payments: {
      prefix: 'payments',
      routes: {
        planGet: 'plan.get',
      },
    },
    admins: [],
    // enable all plugins
    plugins: ['validator', 'logger', 'amqp', 'redisCluster'],
    // by default only ringBuffer logger is enabled in prod
    logger: process.env.NODE_ENV === 'development',
    // init local schemas
    validator: ['../schemas'],
    // default hooks - none
    hooks: {},
    // make sure we wait for admin accounts to init
    initAdminAccountsDelay: 10000,
  };

  /**
   * @namespace Users
   * @param  {Object} opts
   * @return {Users}
   */
  constructor(opts = {}) {
    super(merge({}, Users.defaultOpts, opts));
    const config = this.config;

    const { error } = this.validateSync('config', config);
    if (error) {
      this.log.fatal('Invalid configuration:', error.toJSON());
      throw error;
    }

    this.on('plugin:connect:amqp', (amqp) => {
      this._mailer = new Mailer(amqp, config.mailer);
    });

    this.on('plugin:close:amqp', () => {
      this._mailer = null;
    });

    this.on('plugin:connect:redisCluster', (redis) => {
      fsort.attach(redis, 'fsort');
    });
  }

  /**
   * Getter for mailer client
   * @return {Object}
   */
  get mailer() {
    const mailer = this._mailer;
    return mailer || this.emit('error', new NotImplementedError('amqp is not connected'));
  }

  /**
   * Getter for configuration
   * @return {Object}
   */
  get config() {
    return this._config;
  }

  /**
   * Initializes Admin accounts
   * @return {Promise}
   */
  initAdminAccounts() {
    const config = this.config;
    const accounts = config.admins;
    const audience = config.jwt.defaultAudience;

    return Promise
      .delay(config.initAdminAccountsDelay)
      .return(accounts)
      .map(account => (
        register.call(this, {
          username: account.username,
          password: account.password,
          audience,
          metadata: {
            firstName: account.firstName,
            lastName: account.lastName,
            roles: [USERS_ADMIN_ROLE],
          },
          activate: true,
        })
        .reflect()
      ))
      .bind(this)
      .then(function reportStats(users) {
        const totalAccounts = users.length;
        const errors = [];
        let registered = 0;
        users.forEach(user => {
          if (user.isFulfilled()) {
            registered++;
          } else {
            errors.push(user.reason());
          }
        });

        this.log.info(
          'Registered admins %d/%d. Errors: %d',
          registered, totalAccounts, errors.length
        );

        errors.forEach(err => {
          if (err.statusCode !== 403) {
            this.log.warn(err.stack);
          }
        });
      })
      .finally(() => {
        this.log.info('removing account references from memory');
        config.admins = [];
      });
  }

  initFakeAccounts() {
    const faker = require('faker');
    const config = this.config;

    const accounts = times(103, () => ({
      id: faker.internet.email(),
      metadata: {
        firstName: faker.name.firstName(),
        lastName: faker.name.lastName(),
      },
      activate: true,
    }));

    const audience = config.jwt.defaultAudience;

    return Promise
      .map(accounts, account => (
        register.call(this, {
          username: account.id,
          password: (Math.random() * 20).toFixed(20),
          audience,
          metadata: {
            firstName: account.metadata.firstName,
            lastName: account.metadata.lastName,
          },
          activate: true,
        })
        .reflect()
      ))
      .bind(this)
      .then(function reportStats(users) {
        const totalAccounts = users.length;
        const errors = [];
        let registered = 0;
        users.forEach(user => {
          if (user.isFulfilled()) {
            registered++;
          } else {
            errors.push(user.reason());
          }
        });

        this.log.info(
          'Registered fake users %d/%d. Errors: %d',
          registered, totalAccounts, errors.length
        );

        errors.forEach(err => {
          if (err.statusCode !== 403) {
            this.log.warn(err.stack);
          }
        });
      });
  }

};
