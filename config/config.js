require('dotenv').config();
const { ethers } = require('ethers');

// Import validation function
const validateEnv = require('../scripts/validate-env');

// Run environment validation
validateEnv();

// Configuration object
const config = {
  // Application configuration
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  
  // Database configuration
  mongoUri: process.env.MONGO_URI,
  dbConfig: {
    name: process.env.DB_NAME || 'nadracer',
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: parseInt(process.env.MONGO_POOL_SIZE || '10', 10),
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    }
  },
  
  // Blockchain configuration
  blockchain: {
    rpcUrl: process.env.MONAD_RPC_URL,
    tokenContract: process.env.TOKEN_CONTRACT_ADDRESS,
    ownerKey: process.env.PRIVATE_KEY,
    chainId: parseInt(process.env.CHAIN_ID || '1', 10)
  },
  
  // Relayer configuration
  relayer: {
    count: parseInt(process.env.NUM_RELAYERS || '20', 10),
    minBalance: ethers.parseEther(process.env.RELAYER_MIN_BALANCE || '0.01'),
    maxQueueSize: parseInt(process.env.RELAYER_MAX_QUEUE_SIZE || '100', 10),
    retryAttempts: parseInt(process.env.RELAYER_RETRY_ATTEMPTS || '3', 10),
    retryDelay: parseInt(process.env.RELAYER_RETRY_DELAY || '1000', 10),
    getWallet: (index) => {
      if (index < 0 || index >= config.relayer.count) {
        throw new Error(`Invalid relayer index: ${index}. Must be between 0 and ${config.relayer.count - 1}`);
      }
      const key = process.env[`RELAYER_WALLET_${index}`];
      if (!key) {
        throw new Error(`Relayer wallet private key not found for index ${index}`);
      }
      return key;
    },
    getAllWallets: () => {
      const wallets = [];
      for (let i = 0; i < config.relayer.count; i++) {
        const key = process.env[`RELAYER_WALLET_${i}`];
        if (key) {
          wallets.push({ index: i, privateKey: key });
        }
      }
      return wallets;
    }
  },
  
  // Gas optimization configuration
  gas: {
    updateInterval: parseInt(process.env.GAS_UPDATE_INTERVAL || '300000', 10),
    bufferPercent: parseInt(process.env.GAS_BUFFER_PERCENT || '20', 10),
    limits: {
      transfer: parseInt(process.env.GAS_LIMIT_TRANSFER || '80000', 10)
    },
    prices: {
      max: ethers.parseUnits(process.env.MAX_GAS_PRICE || '100', 'gwei'),
      min: ethers.parseUnits(process.env.MIN_GAS_PRICE || '1', 'gwei')
    }
  },
  
  // Security configuration
  security: {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    },
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
      max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10)
    },
    trustProxy: process.env.TRUST_PROXY === '1'
  },
  
  // Logging configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'json',
    directory: process.env.LOG_DIR || 'logs'
  },
  
  // Monitoring configuration
  monitoring: {
    enabled: process.env.ENABLE_METRICS === 'true',
    port: parseInt(process.env.METRICS_PORT || '9090', 10)
  }
};

module.exports = config; 