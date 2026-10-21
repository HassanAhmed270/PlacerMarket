const { parseAllowedOrigins, createCorsMiddleware } = require('../../src/middleware/cors');
const errorHandler = require('../../src/middleware/errorHandler');

function mockResponse() {
  return {
    headers: {},
    statusCode: 200,
    vary: jest.fn(),
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
  };
}

describe('SEC-22: CORS accepts only configured exact origins', () => {
  test('SEC-22 allows the configured origin and rejects wildcard, paths and unlisted origins', () => {
    expect([...parseAllowedOrigins('https://shop.example')]).toEqual(['https://shop.example']);
    expect(() => parseAllowedOrigins('*')).toThrow(/exact HTTP\(S\) origins/);
    expect(() => parseAllowedOrigins('https://shop.example/path')).toThrow(/exact HTTP\(S\) origins/);
    const res = mockResponse();
    const next = jest.fn();
    createCorsMiddleware({ allowedOrigins: new Set(['https://shop.example']) })(
      { get: () => 'https://evil.example', method: 'GET' }, res, next
    );
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('SEC-28: unexpected server errors are generic and traceable', () => {
  test('SEC-27/28 logs only redacted metadata and returns a generic 500 with request id', () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = mockResponse();
    errorHandler(new Error('database password must not leak'), { requestId: 'req-123' }, res, jest.fn());
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error', requestId: 'req-123' });
    expect(log).toHaveBeenCalledWith('Request failed', expect.objectContaining({ requestId: 'req-123' }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('database password must not leak');
    log.mockRestore();
  });
});
