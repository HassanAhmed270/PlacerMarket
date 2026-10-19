module.exports = {
  rootDir: '../..',
  testMatch: ['<rootDir>/test/integration/**/*.test.js'],
  globalSetup: '<rootDir>/test/integration/global-setup.js',
  globalTeardown: '<rootDir>/test/integration/global-teardown.js',
  setupFilesAfterEnv: ['<rootDir>/test/integration/setup.js'],
};
