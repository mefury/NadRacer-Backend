const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('../config/config');

// Rate limiting configuration
const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests, please try again later.'
  }
});

// Higher rate limit for leaderboard endpoint
const leaderboardLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max * 2, // Double the standard limit
  standardHeaders: true,
  legacyHeaders: false
});

// Apply security middleware
const applySecurityMiddleware = (app) => {
  // Use Helmet for security headers
  app.use(helmet());
  
  // Apply rate limiting to all API routes
  app.use('/api/', apiLimiter);
  
  // Apply specific rate limiter to leaderboard endpoint
  app.use('/api/leaderboard', leaderboardLimiter);
  
  // Add CORS headers for all origins, including file:// protocol
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    
    next();
  });
};

module.exports = {
  applySecurityMiddleware
}; 