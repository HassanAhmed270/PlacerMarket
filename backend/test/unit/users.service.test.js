const users = require('../../src/modules/users.service');

describe('users service incomplete authentication message', () => {
  test('does not duplicate the not-implemented suffix', async () => {
    await expect(users.authenticate({ email: 'seller@example.test', password: 'placeholder' }))
      .rejects.toThrow('authenticate() — required session and 2FA persistence is not implemented yet');
  });
});
