const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { ethers } = require('ethers');
const config = require('../config/config');

/**
 * Health check endpoint
 * Returns the status of various system components
 */
router.get('/', async (req, res) => {
  try {
    // Check MongoDB connection
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    
    // Check RPC connection
    let rpcStatus = 'unknown';
    try {
      const provider = new ethers.JsonRpcProvider(config.monadRpcUrl);
      const blockNumber = await provider.getBlockNumber();
      rpcStatus = blockNumber > 0 ? 'connected' : 'error';
    } catch (error) {
      rpcStatus = 'error';
    }
    
    // Get system uptime
    const uptime = process.uptime();
    
    // Get memory usage
    const memoryUsage = process.memoryUsage();
    
    // Return health status
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: uptime,
      database: {
        status: dbStatus
      },
      blockchain: {
        status: rpcStatus
      },
      memory: {
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Add a CORS test endpoint to help debug cross-origin issues
router.get('/cors-test', (req, res) => {
  const responseData = {
    success: true,
    message: 'CORS test successful',
    requestHeaders: {
      origin: req.headers.origin,
      referer: req.headers.referer,
      host: req.headers.host
    },
    corsSettings: {
      allowedOrigins: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:3000'],
      environment: process.env.NODE_ENV
    },
    timestamp: new Date().toISOString()
  };
  
  res.json(responseData);
});

module.exports = router; 