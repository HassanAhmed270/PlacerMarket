module.exports = {
  rootDir: '../..',
  testMatch: ['<rootDir>/test/integration/**/*.test.js'],
  globalSetup: '<rootDir>/test/integration/global-setup.js',
  setupFilesAfterEnv: ['<rootDir>/test/integration/setup.js'],
};
