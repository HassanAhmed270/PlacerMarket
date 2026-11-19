const { logDemoCompletion } = require('../../scripts/demo-smoke');

describe('SEC-27: demo smoke logging', () => {
  test('SEC-27: logs the seller id without contact details or credentials', () => {
    const logger = { log: jest.fn() };
    const sellerId = '123e4567-e89b-42d3-a456-426614174000';

    logDemoCompletion(sellerId, logger);

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining(sellerId));
    const logged = JSON.stringify(logger.log.mock.calls);
    for (const sensitiveValue of [
      'seller@example.test',
      '+15551234567',
      '4111111111111111',
      'step-up-grant',
      'authenticator-secret',
    ]) {
      expect(logged).not.toContain(sensitiveValue);
    }
  });
});
