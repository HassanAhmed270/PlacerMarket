const { NotYetSpecifiedError, NotImplementedError, NotFoundError, ValidationError, ForbiddenError } = require('../../src/lib/errors');

describe('lib/errors statusCode mapping (consumed by middleware/errorHandler.js)', () => {
  test('NotYetSpecifiedError is 501 and carries the FR code', () => {
    const err = new NotYetSpecifiedError('FR-33b', 'refusal-at-door flow undefined');
    expect(err.statusCode).toBe(501);
    expect(err.frCode).toBe('FR-33b');
    expect(err.message).toContain('FR-33b');
  });

  test('NotImplementedError is 501 but carries no FR code (decided, just not written)', () => {
    const err = new NotImplementedError('authenticate()');
    expect(err.statusCode).toBe(501);
    expect(err.frCode).toBeUndefined();
  });

  test('NotFoundError is 404', () => {
    expect(new NotFoundError('order', 'abc-123').statusCode).toBe(404);
  });

  test('ValidationError is 400', () => {
    expect(new ValidationError('bad input').statusCode).toBe(400);
  });

  test('ForbiddenError is 403', () => {
    expect(new ForbiddenError('nope').statusCode).toBe(403);
  });
});
