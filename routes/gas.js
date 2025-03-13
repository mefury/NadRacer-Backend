const express = require('express');
const router = express.Router();
const gasOptimizer = require('../services/gasOptimizer');
const { ethers } = require('ethers');
const logger = require('../config/logger');

/**
 * Get current gas optimization status
 */
router.get('/status', async (req, res) => {
  try {
    const optimizedLimits = gasOptimizer.optimizedGasLimits;
    const lastUpdate = gasOptimizer.getLastUpdate();
    
    res.json({
      status: 'success',
      data: {
        optimizedLimits,
        lastUpdate,
        isRunning: gasOptimizer.isRunning,
        nextUpdateIn: lastUpdate ? 
          Math.max(0, (lastUpdate + gasOptimizer.updateInterval) - Date.now()) : 
          null
      }
    });
  } catch (error) {
    logger.error('Error getting gas optimization status:', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * Force update gas optimizations
 */
router.post('/update', async (req, res) => {
  try {
    const optimizedLimits = await gasOptimizer.updateGasOptimizations();
    
    res.json({
      status: 'success',
      data: {
        optimizedLimits,
        lastUpdate: gasOptimizer.getLastUpdate()
      }
    });
  } catch (error) {
    logger.error('Error updating gas optimizations:', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

module.exports = router; 