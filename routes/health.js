const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { ethers } = require('ethers');
const os = require('os');
const config = require('../config/config');
const tokenABI = require('../TokenABI.json');

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
    let blockNumber = 0;
    try {
      const provider = new ethers.JsonRpcProvider(process.env.MONAD_RPC_URL);
      blockNumber = await provider.getBlockNumber();
      rpcStatus = blockNumber > 0 ? 'connected' : 'error';
    } catch (error) {
      rpcStatus = 'error';
    }
    
    // Get system uptime
    const uptime = process.uptime();
    
    // Get memory usage
    const memoryUsage = process.memoryUsage();
    
    // Get system info
    const systemInfo = {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      loadAvg: os.loadavg(),
      totalmem: Math.round(os.totalmem() / 1024 / 1024) + ' MB',
      freemem: Math.round(os.freemem() / 1024 / 1024) + ' MB'
    };
    
    // Token contract info
    let tokenInfo = {
      status: 'error',
      address: process.env.TOKEN_CONTRACT_ADDRESS || 'not set',
      treasuryAddress: process.env.TREASURY_ADDRESS || 'not set'
    };
    
    try {
      if (process.env.TOKEN_CONTRACT_ADDRESS && process.env.MONAD_RPC_URL) {
        const provider = new ethers.JsonRpcProvider(process.env.MONAD_RPC_URL);
        const tokenContract = new ethers.Contract(
          process.env.TOKEN_CONTRACT_ADDRESS,
          tokenABI,
          provider
        );
        
        const [name, symbol, treasury] = await Promise.all([
          tokenContract.name(),
          tokenContract.symbol(),
          tokenContract.gameTreasury()
        ]);
        
        tokenInfo = {
          status: 'connected',
          address: process.env.TOKEN_CONTRACT_ADDRESS,
          name,
          symbol,
          treasuryAddress: treasury,
          configuredTreasury: process.env.TREASURY_ADDRESS
        };
      }
    } catch (error) {
      tokenInfo.error = error.message;
    }
    
    // Return health status
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: uptime,
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      token: tokenInfo,
      database: {
        status: dbStatus,
        uri: process.env.MONGO_URI ? 
          process.env.MONGO_URI.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@') : 
          'not set'
      },
      blockchain: {
        status: rpcStatus,
        network: 'monad-testnet',
        blockNumber,
        rpcUrl: process.env.MONAD_RPC_URL ? 
          process.env.MONAD_RPC_URL.substring(0, 20) + '...' : 
          'not set'
      },
      system: systemInfo,
      memory: {
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
        external: `${Math.round(memoryUsage.external / 1024 / 1024)} MB`,
        arrayBuffers: `${Math.round((memoryUsage.arrayBuffers || 0) / 1024 / 1024)} MB`
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : error.stack
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

// Add a detailed health check for monitoring services
router.get('/detailed', async (req, res) => {
  try {
    // Basic health check
    const basicHealth = await getBasicHealth();
    
    // Database collections check
    const dbCollections = await getDatabaseCollectionsHealth();
    
    // Check token contract and treasury
    const tokenHealth = await getTokenContractHealth();
    
    // Server resources
    const resourceHealth = getResourceHealth();
    
    res.json({
      status: basicHealth.status,
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      uptime: process.uptime(),
      checks: {
        database: basicHealth.database,
        collections: dbCollections,
        blockchain: basicHealth.blockchain,
        tokenContract: tokenHealth,
        system: resourceHealth
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Helper Functions

async function getBasicHealth() {
  // Check MongoDB connection
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  
  // Check RPC connection
  let rpcStatus = 'unknown';
  let blockNumber = 0;
  try {
    const provider = new ethers.JsonRpcProvider(process.env.MONAD_RPC_URL);
    blockNumber = await provider.getBlockNumber();
    rpcStatus = blockNumber > 0 ? 'connected' : 'error';
  } catch (error) {
    rpcStatus = 'error';
  }
  
  return {
    status: dbStatus === 'connected' && rpcStatus === 'connected' ? 'ok' : 'degraded',
    database: {
      status: dbStatus
    },
    blockchain: {
      status: rpcStatus,
      blockNumber
    }
  };
}

async function getDatabaseCollectionsHealth() {
  try {
    const Player = mongoose.model('Player');
    const Leaderboard = mongoose.model('Leaderboard');
    
    // Try loading GameStats, which might not exist yet
    let GameStats;
    try {
      GameStats = mongoose.model('GameStats');
    } catch (error) {
      // Model doesn't exist yet, try to require it
      try {
        GameStats = require('../models/GameStats');
      } catch (innerError) {
        GameStats = null;
      }
    }
    
    const collectionsHealth = {
      player: {
        status: 'ok',
        count: await Player.countDocuments()
      },
      leaderboard: {
        status: 'ok',
        count: await Leaderboard.countDocuments()
      }
    };
    
    if (GameStats) {
      collectionsHealth.gameStats = {
        status: 'ok',
        count: await GameStats.countDocuments()
      };
    } else {
      collectionsHealth.gameStats = {
        status: 'missing',
        message: 'GameStats model not found'
      };
    }
    
    return collectionsHealth;
  } catch (error) {
    return {
      status: 'error',
      message: error.message
    };
  }
}

async function getTokenContractHealth() {
  try {
    if (!process.env.TOKEN_CONTRACT_ADDRESS || !process.env.MONAD_RPC_URL) {
      return {
        status: 'misconfigured',
        message: 'Token contract address or RPC URL not set'
      };
    }
    
    const provider = new ethers.JsonRpcProvider(process.env.MONAD_RPC_URL);
    const tokenContract = new ethers.Contract(
      process.env.TOKEN_CONTRACT_ADDRESS,
      tokenABI,
      provider
    );
    
    // Check if contract exists and has basic ERC20 functions
    const [name, symbol, decimals, treasuryBalance] = await Promise.all([
      tokenContract.name(),
      tokenContract.symbol(),
      tokenContract.decimals(),
      process.env.TREASURY_ADDRESS ? 
        tokenContract.balanceOf(process.env.TREASURY_ADDRESS) : 
        Promise.resolve(0)
    ]);
    
    return {
      status: 'ok',
      name,
      symbol,
      decimals: decimals.toString(),
      treasuryBalance: ethers.formatUnits(treasuryBalance, decimals),
      transferMethod: 'treasury'
    };
  } catch (error) {
    return {
      status: 'error',
      message: error.message
    };
  }
}

function getResourceHealth() {
  const memoryUsage = process.memoryUsage();
  const cpuUsage = os.loadavg();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  
  // Calculate memory usage percentage
  const memoryUsagePercent = 100 - (freeMemory / totalMemory * 100);
  
  return {
    status: 'ok',
    cpu: {
      loadAverage: cpuUsage,
      cores: os.cpus().length
    },
    memory: {
      total: `${Math.round(totalMemory / 1024 / 1024)} MB`,
      free: `${Math.round(freeMemory / 1024 / 1024)} MB`,
      usage: `${memoryUsagePercent.toFixed(2)}%`,
      heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`
    }
  };
}

module.exports = router; 