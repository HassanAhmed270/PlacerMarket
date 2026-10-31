const { ValidationError } = require('./errors');
const { getSecurityLimits } = require('../config');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[1-9]\d{7,19}$/;
const REGISTER_FIELDS = new Set(['name', 'phone', 'email', 'password', 'cityId']);
const LOGIN_FIELDS = new Set(['email', 'password', 'challengeToken']);
const LOGIN_CODE_FIELDS = new Set(['email', 'loginAttemptId', 'code']);
const STAFF_LOGIN_FIELDS = new Set(['email', 'password', 'code']);
const RESET_REQUEST_FIELDS = new Set(['email']);
const RESET_FIELDS = new Set(['token', 'password']);

function assertOnlyFields(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }
  if (Object.keys(body).some((key) => !fields.has(key))) {
    throw new ValidationError('Request contains unsupported fields');
  }
}

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new ValidationError('A valid email address is required');
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 255 || !EMAIL.test(email)) {
    throw new ValidationError('A valid email address is required');
  }
  return email;
}

function validatePhone(value) {
  if (typeof value !== 'string' || !PHONE.test(value.trim())) {
    throw new ValidationError('Phone number must use an international phone format');
  }
  return value.trim();
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || value.includes('\0')) {
    throw new ValidationError('Password must be 12 to 128 characters');
  }
  return value;
}

function validateRegistration(body) {
  assertOnlyFields(body, REGISTER_FIELDS);
  if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 150) {
    throw new ValidationError('Name must be 1 to 150 characters');
  }
  const email = normalizeEmail(body.email);
  const password = validatePassword(body.password);
  let cityId = null;
  if (body.cityId !== undefined && body.cityId !== null && body.cityId !== '') {
    if (typeof body.cityId !== 'string' || !UUID.test(body.cityId)) {
      throw new ValidationError('cityId must be a UUID');
    }
    cityId = body.cityId;
  }
  return { name: body.name.trim(), phone: validatePhone(body.phone), email, password, cityId };
}

function validateLogin(body) {
  assertOnlyFields(body, LOGIN_FIELDS);
  if (body.challengeToken !== undefined && (typeof body.challengeToken !== 'string' || body.challengeToken.length > 4096)) {
    throw new ValidationError('A valid challenge response is required');
  }
  return { email: normalizeEmail(body.email), password: validatePassword(body.password), ...(body.challengeToken ? { challengeToken: body.challengeToken } : {}) };
}

function validateLoginCode(body) {
  assertOnlyFields(body, LOGIN_CODE_FIELDS);
  const email = normalizeEmail(body.email);
  const codePattern = new RegExp(`^\\d{${getSecurityLimits().EMAIL_CODE_LENGTH}}$`);
  if (typeof body.loginAttemptId !== 'string' || !UUID.test(body.loginAttemptId) ||
      typeof body.code !== 'string' || !codePattern.test(body.code)) {
    throw new ValidationError('A valid login attempt and email code are required');
  }
  return { email, loginAttemptId: body.loginAttemptId, code: body.code };
}

function validateStaffLogin(body) {
  assertOnlyFields(body, STAFF_LOGIN_FIELDS);
  if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) {
    throw new ValidationError('A valid authenticator code is required');
  }
  return {
    email: normalizeEmail(body.email),
    password: validatePassword(body.password),
    code: body.code,
  };
}

function validateResetRequest(body) {
  assertOnlyFields(body, RESET_REQUEST_FIELDS);
  return { email: normalizeEmail(body.email) };
}

function validatePasswordReset(body) {
  assertOnlyFields(body, RESET_FIELDS);
  if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) throw new ValidationError('A valid reset token is required');
  return { token: body.token, password: validatePassword(body.password) };
}

module.exports = {
  validatePhone,
  validateRegistration,
  validateLogin,
  validateLoginCode,
  validateStaffLogin,
  validateResetRequest,
  validatePasswordReset,
};
