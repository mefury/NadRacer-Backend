const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');
const config = require('../config/config');
const { formatUnits, parseUnits } = ethers;

// Get gas price for Monad network
router.get('/price', async (req, res) => {
  try {
    const provider = new ethers.JsonRpcProvider(process.env.MONAD_RPC_URL);
    
    // Get current gas price
    const feeData = await provider.getFeeData();
    
    // Format the gas price in different units
    const gasPriceGwei = formatUnits(feeData.gasPrice, 'gwei');
    const gasPriceEth = formatUnits(feeData.gasPrice, 'ether');
    
    // Get gas limits from config
    const gasLimits = {
      transfer: config.gasLimits.transfer || 80000,
    };
    
    // Calculate transaction costs for different operations
    const txCosts = {
      transfer: {
        wei: (BigInt(gasLimits.transfer) * feeData.gasPrice).toString(),
        gwei: formatUnits(BigInt(gasLimits.transfer) * feeData.gasPrice, 'gwei'),
        ether: formatUnits(BigInt(gasLimits.transfer) * feeData.gasPrice, 'ether')
      }
    };
    
    res.json({
      current: {
        wei: feeData.gasPrice.toString(),
        gwei: gasPriceGwei,
        ether: gasPriceEth
      },
      gasLimits,
      txCosts,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting gas price:', error);
    res.status(500).json({
      error: 'Failed to get gas price',
      message: error.message
    });
  }
});

// Get estimated gas limits for token operations
router.get('/limits', async (req, res) => {
  try {
    // Check if gas optimizer is available
    if (!global.gasOptimizer) {
      return res.status(500).json({
        error: 'Gas optimizer not initialized',
        fallbackLimits: config.gasLimits
      });
    }
    
    // Get optimized gas limits
    const optimizedLimits = global.gasOptimizer.getOptimizedGasLimits();
    
    // Format for response
    const response = {
      optimized: {},
      default: config.gasLimits,
      timestamp: new Date().toISOString()
    };
    
    // Convert BigInt values to strings
    for (const [key, value] of Object.entries(optimizedLimits)) {
      response.optimized[key] = value.toString();
    }
    
    res.json(response);
  } catch (error) {
    console.error('Error getting gas limits:', error);
    res.status(500).json({
      error: 'Failed to get gas limits',
      message: error.message,
      fallbackLimits: config.gasLimits
    });
  }
});

// Update gas limits manually
router.post('/limits', async (req, res) => {
  try {
    const { operation, limit } = req.body;
    
    // Validate input
    if (!operation || !limit || !['transfer'].includes(operation)) {
      return res.status(400).json({
        error: 'Invalid input',
        message: 'Operation must be "transfer" and limit must be a positive number'
      });
    }
    
    // Convert limit to number
    const gasLimit = parseInt(limit);
    if (isNaN(gasLimit) || gasLimit <= 0) {
      return res.status(400).json({
        error: 'Invalid gas limit',
        message: 'Gas limit must be a positive number'
      });
    }
    
    // Check if gas optimizer is available
    if (!global.gasOptimizer) {
      return res.status(500).json({
        error: 'Gas optimizer not initialized'
      });
    }
    
    // Update gas limit in optimizer
    const updated = global.gasOptimizer.setCustomGasLimit(operation, BigInt(gasLimit));
    
    if (updated) {
      res.json({
        success: true,
        message: `Gas limit for ${operation} updated to ${gasLimit}`,
        updatedLimits: global.gasOptimizer.getOptimizedGasLimits()
      });
    } else {
      res.status(500).json({
        error: 'Failed to update gas limit'
      });
    }
  } catch (error) {
    console.error('Error updating gas limits:', error);
    res.status(500).json({
      error: 'Failed to update gas limits',
      message: error.message
    });
  }
});

// Get gas statistics
router.get('/stats', async (req, res) => {
  try {
    // Check if gas optimizer is available
    if (!global.gasOptimizer) {
      return res.status(500).json({
        error: 'Gas optimizer not initialized'
      });
    }
    
    // Get gas statistics
    const stats = global.gasOptimizer.getStats();
    
    // Format for response (convert BigInt values)
    const response = {
      estimationCount: stats.estimationCount,
      lastEstimation: stats.lastEstimation,
      averageGasUsed: {
        transfer: stats.averageGasUsed?.transfer?.toString() || '0'
      },
      timestamp: new Date().toISOString()
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error getting gas statistics:', error);
    res.status(500).json({
      error: 'Failed to get gas statistics',
      message: error.message
    });
  }
});

// Trigger manual gas estimation
router.post('/estimate', async (req, res) => {
  try {
    // Check if gas optimizer is available
    if (!global.gasOptimizer) {
      return res.status(500).json({
        error: 'Gas optimizer not initialized'
      });
    }
    
    // Trigger estimation
    await global.gasOptimizer.updateGasOptimizations();
    
    // Get updated gas limits
    const optimizedLimits = global.gasOptimizer.getOptimizedGasLimits();
    
    // Format for response
    const response = {
      success: true,
      message: 'Gas estimation completed successfully',
      optimizedLimits: {},
      timestamp: new Date().toISOString()
    };
    
    // Convert BigInt values to strings
    for (const [key, value] of Object.entries(optimizedLimits)) {
      response.optimizedLimits[key] = value.toString();
    }
    
    res.json(response);
  } catch (error) {
    console.error('Error estimating gas:', error);
    res.status(500).json({
      error: 'Failed to estimate gas',
      message: error.message
    });
  }
});

module.exports = router; 