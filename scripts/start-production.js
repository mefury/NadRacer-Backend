require('./validate-env')();
const logger = require('../config/logger');

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  // Give time for logs to be written
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled Rejection:', err);
  // Give time for logs to be written
  setTimeout(() => process.exit(1), 1000);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Performing graceful shutdown...');
  // Add cleanup logic here if needed
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received. Performing graceful shutdown...');
  // Add cleanup logic here if needed
  setTimeout(() => process.exit(0), 1000);
});

// Start the application
require('../index'); 