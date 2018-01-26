const { ActionTransport } = require('@microfleet/core');

/**
 * @api {http.get|amqp} <prefix>/_/me Return decoded data from JWT
 * @apiVersion 1.0.0
 * @apiName Me
 * @apiGroup Users
 * @apiPermission user
 *
 * @apiDescription Verifies JWT and returns user's default metadata
 *
 * @apiHeader (Authorization) {String} Authorization JWT :accessToken
 * @apiHeaderExample Authorization-Example:
 *     "Authorization: JWT my.reallyniceandvalid.jsonwebtoken"
 *
 */
function Me({ auth }) {
  return auth.credentials;
}

Me.auth = {
  name: 'bearer',
  strategy: 'required',
  passError: true,
};
Me.schema = 'me';
Me.transports = [ActionTransport.http, ActionTransport.amqp];
Me.transportOptions = {
  [ActionTransport.http]: {
    methods: ['get'],
  },
  [ActionTransport.amqp]: {
    methods: [ActionTransport.amqp],
  },
};


module.exports = Me;