const { ValidationError } = require('./errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[1-9]\d{7,19}$/;
const REGISTER_FIELDS = new Set(['name', 'phone', 'email', 'password', 'cityId']);
const LOGIN_FIELDS = new Set(['email', 'password']);

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
  if (typeof body.phone !== 'string' || !PHONE.test(body.phone.trim())) {
    throw new ValidationError('Phone number must use an international phone format');
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
  return { name: body.name.trim(), phone: body.phone.trim(), email, password, cityId };
}

function validateLogin(body) {
  assertOnlyFields(body, LOGIN_FIELDS);
  return { email: normalizeEmail(body.email), password: validatePassword(body.password) };
}

module.exports = { validateRegistration, validateLogin };
