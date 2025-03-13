const logger = require('../config/logger');

/**
 * Global error handling middleware
 */
const errorHandler = (err, req, res, next) => {
  // Log the error
  logger.error({
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
    userId: req.user ? req.user.id : 'unauthenticated'
  });

  // Determine status code
  const statusCode = err.statusCode || 500;
  
  // Send error response
  res.status(statusCode).json({
    error: {
      message: process.env.NODE_ENV === 'production' && statusCode === 500
        ? 'Internal server error'
        : err.message,
      status: statusCode,
      // Only include stack trace in development
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
    }
  });
};

module.exports = errorHandler; 