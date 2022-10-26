const {
  expression,
  numericRange,
  paramRef,
  namedField,
  tag,
  negative,
  matchAny,
} = require('./expressions');

const EMPTY_VALUE = '""';

const buildParamName = (...args) => args.join('_');
const normalizePropName = (prop) => prop.replace(/\|/g, '_');

const searchQueryBuilder = {
  // (prop, field, expr)
  gte: (_, field, expr) => expression(field, numericRange(expr.gte, expr.lte)),
  lte: (_, field, expr) => expression(field, numericRange(expr.gte, expr.lte)),
  exists: (_, field) => negative(expression((field), EMPTY_VALUE)),
  isempty: (_, field) => expression(field, EMPTY_VALUE),
  eq: (prop, field) => {
    const name = buildParamName('f', prop, 'eq');
    return expression(field, tag(paramRef(name)));
  },
  ne: (prop, field) => {
    const name = buildParamName('f', prop, 'ne');
    return negative(expression(field), tag(paramRef(name)));
  },
  match: (prop, field) => {
    // TODO: verify correctness of this
    const propName = normalizePropName(prop);
    const name = buildParamName('f', propName, 'm');

    return expression(field, matchAny(paramRef(name)));
  },
};

const searchParamBuilder = {
  // (prop, expr)
  eq: (prop, expr) => {
    const name = buildParamName('f', prop, 'eq');
    return [name, expr.eq];
  },
  ne: (prop, expr) => {
    const name = buildParamName('f', prop, 'ne');
    return [name, expr.ne];
  },
  match: (prop, expr) => {
    const propName = normalizePropName(prop);
    const name = buildParamName('f', propName, 'm');

    return [name, expr.match];
  },
};

const buildSearchQuery = (propName, valueOrExpr) => {
  const field = namedField(propName);

  if (typeof valueOrExpr === 'string') { // Value
    const pName = buildParamName('f', field);
    const query = expression(field, tag(paramRef(pName)));

    const params = [pName, valueOrExpr];
    return [query, params];
  }
  // TODO consider to build together
  const buildQuery = searchQueryBuilder[valueOrExpr];
  const query = buildQuery(propName, field, valueOrExpr);

  const buildParams = searchParamBuilder[valueOrExpr];
  const params = buildParams !== undefined ? buildParams(propName, valueOrExpr) : [];

  return [query, params];
};

module.exports = buildSearchQuery;