module.exports = {
  testEnvironment: 'node',
  setupFiles: ['./jest.setup.js'],
  testMatch: ['**/__tests__/**/*.test.js'],
  clearMocks: true,
  restoreMocks: true,
};
