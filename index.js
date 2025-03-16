const express = require('express');
const mongoose = require('mongoose');
const { ethers } = require('ethers'); // Correct import for v6
const cors = require('cors');
const compression = require('compression');
const path = require('path');
require('dotenv').config();

const Player = require('./models/Player');
const Leaderboard = require('./models/Leaderboard');
const relayerSystem = require('./relayer'); // Import relayer system
const GasOptimizer = require('./services/gasOptimizer');
const gasRoutes = require('./routes/gas');
const healthRoutes = require('./routes/health');
const relayerRoutes = require('./routes/relayer');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./config/logger');
const config = require('./config/config'); // Import config

// Import token ABI
const TokenABI = require('./TokenABI.json');

// Stats tracking
const stats = {
  totalTxAttempted: 0,
  totalTxSuccess: 0, 
  totalTxFailed: 0,
  lastErrorMessage: '',
  lastErrorTimestamp: null,
  lastSuccessTimestamp: null,
  lastSuccessHash: '',
  rpcStatus: 'unknown',
  serverStartTime: Date.now(),
  rpcReconnectAttempts: 0,
  tokensMinted: 0,
  tokensTrackedInDb: 0,
  activePlayers: {},
  uniquePlayers: 0,
  lastResetTime: null
};

// Transaction history for the admin panel
const txHistory = [];
const MAX_HISTORY = 100;

const app = express();
const port = process.env.PORT || 3001;

// Variable declarations
let provider;
let ownerWallet; // For contract ownership operations only
let tokenContract;
let isBackendInitialized = false; // Track if backend is fully initialized

// Configure CORS with proper options
app.use((req, res, next) => {
  const allowedOrigins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:3000'];
  const origin = req.headers.origin;
  
  // Check if the origin is in our allowed list or use wildcard for development
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (process.env.NODE_ENV !== 'production') {
    // In development, be more permissive
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

app.use(express.json());

// Add middleware to handle BigInt serialization
app.use((req, res, next) => {
  // Store the original res.json method
  const originalJson = res.json;
  
  // Override res.json to handle BigInt values
  res.json = function(data) {
    // Convert BigInt values to strings
    return originalJson.call(this, convertBigIntsToStrings(data));
  };
  
  next();
});

// Global error handler for uncaught promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  stats.lastErrorMessage = reason?.message || 'Unknown promise rejection';
  stats.lastErrorTimestamp = Date.now();
  // Don't crash the server, just log the error
});

// Helper function to convert BigInt values to strings in an object
function convertBigIntsToStrings(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => convertBigIntsToStrings(item));
  }
  
  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = convertBigIntsToStrings(value);
    }
    return result;
  }
  
  return obj;
}

// Set up provider with automatic reconnection
const setupProvider = () => {
  try {
    const provider = new ethers.JsonRpcProvider(process.env.MONAD_RPC_URL, undefined, {
      staticNetwork: true,
      polling: true,
      pollingInterval: 4000, // Poll every 4 seconds
      cacheTimeout: -1 // Don't cache results
    });
    
    stats.rpcStatus = 'connected';
    
    // Handle provider disconnects
    provider.on('error', (error) => {
      console.error('RPC provider error:', error);
      stats.rpcStatus = 'error';
      stats.lastErrorMessage = error?.message || 'RPC provider error';
      stats.lastErrorTimestamp = Date.now();
      stats.rpcReconnectAttempts++;
      // No need to reconnect here, ethers v6 handles reconnection automatically
    });
    
    provider.on('network', (newNetwork, oldNetwork) => {
      console.log('Network changed:', oldNetwork, '->', newNetwork);
      if (oldNetwork) {
        stats.rpcStatus = 'reconnected';
      }
    });
    
    return provider;
  } catch (error) {
    console.error('Failed to set up provider:', error);
    stats.rpcStatus = 'failed';
    stats.lastErrorMessage = error.message;
    stats.lastErrorTimestamp = Date.now();
    return null;
  }
};

// Check if RPC is healthy
const checkRpcHealth = async () => {
  try {
    await provider.getBlockNumber();
    stats.rpcStatus = 'connected';
    return true;
  } catch (error) {
    console.error('RPC health check failed:', error.message);
    stats.rpcStatus = 'error';
    stats.lastErrorMessage = error.message;
    stats.lastErrorTimestamp = Date.now();
    return false;
  }
};

// Reconnect provider if needed
const reconnectProvider = async () => {
  try {
  stats.rpcReconnectAttempts++;
    console.log('Attempting to reconnect provider...');
  
    provider = await setupProvider();
    
    if (provider) {
      // Re-initialize relayer system with new provider
      await relayerSystem.resetProvider(provider);
      
      // Re-initialize contracts with new provider
      if (!isBackendInitialized) {
        // Create contract instance for owner wallet (for admin operations)
        ownerWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        tokenContract = new ethers.Contract(process.env.TOKEN_CONTRACT_ADDRESS, TokenABI, ownerWallet);
      }
      
      console.log('Provider reconnected successfully');
      stats.rpcStatus = 'reconnected';
      return true;
    } else {
      console.error('Failed to reconnect provider');
      stats.rpcStatus = 'disconnected';
      return false;
    }
  } catch (error) {
    console.error('Error reconnecting provider:', error);
    stats.rpcStatus = 'error';
    stats.lastErrorMessage = error.message;
    stats.lastErrorTimestamp = Date.now();
    return false;
  }
};

// Add transaction to history for admin panel
const addToTxHistory = (txData) => {
  // Convert any BigInt values to strings before storing
  const processedTxData = convertBigIntsToStrings(txData);
  
  // Add to beginning of array for most recent first
  txHistory.unshift({
    ...processedTxData,
    timestamp: Date.now()
  });
  
  // Limit the history size
  if (txHistory.length > MAX_HISTORY) {
    txHistory.length = MAX_HISTORY;
  }
};

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  dbName: 'nadracer'
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

// Import gas optimizer and make it global
global.gasOptimizer = new GasOptimizer(config);

// Initialize the backend
const initializeBackend = async () => {
  try {
    console.log('Initializing NadRacer backend server...');
    
    // Examine token ABI for debugging
    try {
      console.log('Examining TokenABI for available methods:');
      const contractMethods = TokenABI
        .filter(item => item.type === 'function')
        .map(item => item.name);
      
      console.log(`Available token contract methods: ${contractMethods.join(', ')}`);
      
      // Check for important methods
      const hasTransferFrom = contractMethods.includes('transferFrom');
      const hasMint = contractMethods.includes('mint');
      const hasGameTreasury = contractMethods.includes('gameTreasury');
      
      console.log(`Contract supports transferFrom: ${hasTransferFrom ? 'YES' : 'NO - THIS IS A PROBLEM'}`);
      console.log(`Contract has mint function: ${hasMint ? 'YES (this might explain what you see in explorer)' : 'NO'}`);
      console.log(`Contract has gameTreasury function: ${hasGameTreasury ? 'YES' : 'NO'}`);
    } catch (error) {
      console.error('Error examining TokenABI:', error);
    }
    
    // Initialize provider
    provider = await setupProvider();
    if (!provider) {
      throw new Error('Failed to initialize provider');
    }
    
    // Create treasury wallet for token transfers
    const treasuryPrivateKey = process.env.TREASURY_PRIVATE_KEY;
    if (!treasuryPrivateKey || !treasuryPrivateKey.startsWith('0x')) {
      throw new Error('Invalid treasury private key format. Must start with 0x.');
    }
    
    // Keep the owner wallet for admin operations
    const ownerPrivateKey = process.env.PRIVATE_KEY;
    if (!ownerPrivateKey || !ownerPrivateKey.startsWith('0x')) {
      throw new Error('Invalid owner private key format. Must start with 0x.');
    }
    
    ownerWallet = new ethers.Wallet(ownerPrivateKey, provider);
    console.log(`Owner wallet address: ${ownerWallet.address}`);
    
    // Create token contract instance with treasury address
    const tokenAddress = process.env.TOKEN_CONTRACT_ADDRESS;
    tokenContract = new ethers.Contract(tokenAddress, TokenABI, ownerWallet);
    
    // Initialize relayer system
    const relayerInitResult = await relayerSystem.initialize(provider);
    if (relayerInitResult) {
      console.log('Relayer system initialized successfully');
      
      // Set up transaction complete callback to add to history
      relayerSystem.setTransactionCompleteCallback((txData) => {
        addToTxHistory({
          type: 'token_transfer',
          walletAddress: txData.walletAddress,
          pointsToMint: txData.pointsToMint,
          status: txData.success ? 'success' : 'failed',
          txHash: txData.hash,
          relayerAddress: txData.relayerAddress,
          relayerIndex: txData.relayerIndex,
          error: txData.error,
          gasUsed: txData.gasUsed
        });
        
        // Update stats
        if (txData.success) {
        stats.totalTxSuccess++;
        stats.lastSuccessTimestamp = Date.now();
          stats.lastSuccessHash = txData.hash;
        } else {
        stats.totalTxFailed++;
          stats.lastErrorMessage = txData.error || 'Unknown error';
        stats.lastErrorTimestamp = Date.now();
        }
        stats.totalTxAttempted++;
      });
    } else {
      console.warn('⚠️ Warning: Relayer system initialization had some issues');
    }
    
    // Initialize gas optimizer
    await global.gasOptimizer.initialize(provider, process.env.TOKEN_CONTRACT_ADDRESS);
    console.log('Gas optimizer initialized');
    
    console.log('Backend initialization complete.');
    isBackendInitialized = true; // Mark backend as fully initialized
    
    return true;
  } catch (error) {
    console.error('Backend initialization failed:', error);
    return false;
  }
};

// Token rewards for coin collection in real-time
app.post('/api/transfer-tokens', async (req, res) => {
  const { walletAddress, coinsCollected } = req.body;

  if (!walletAddress || !ethers.isAddress(walletAddress) || !coinsCollected || coinsCollected <= 0) {
    return res.status(400).json({ error: 'Invalid wallet address or coin count' });
  }

  try {
    // Find player or create if doesn't exist
    let player = await Player.findOne({ walletAddress });
    
    if (!player) {
      return res.status(404).json({ error: 'Player not registered. Please register first.' });
    }

    // Calculate token amount (1 point per coin)
    const pointsToMint = coinsCollected;
    
    // Always update the database immediately for better UX
    player.totalPoints += pointsToMint;
    await player.save();
    
    stats.tokensTrackedInDb += pointsToMint;
    
    // Check if token rewards are enabled
    const enableTokenRewards = process.env.ENABLE_TOKEN_REWARDS === 'true';
    
    if (!enableTokenRewards) {
      console.log(`Token rewards disabled. Skipping blockchain transfer for ${pointsToMint} tokens to ${walletAddress}`);
      return res.json({ 
        success: true, 
        message: 'Points saved to database only. Token transfers disabled.',
        txHash: null,
        enabledTokenRewards: false,
        dbUpdated: true
      });
    }
    
    console.log(`Processing transfer of ${pointsToMint} tokens from treasury to ${walletAddress} (gas paid by owner wallet)`);
    
    // Get optimized gas limit for the transaction
    let gasLimit = global.gasOptimizer.getOptimizedGasLimit('GAS_LIMIT_TRANSFER') || 
                  BigInt(process.env.GAS_LIMIT_TRANSFER || 80000);
    
    // Ensure gasLimit is a BigInt and convert to string for the response
    if (typeof gasLimit !== 'bigint') {
      gasLimit = BigInt(String(gasLimit).replace(/[^\d]/g, ''));
    }
    const gasLimitStr = gasLimit.toString();
    
    // Queue transaction using relayer system with optimized gas
    const success = relayerSystem.queueTransaction({
      walletAddress,
      pointsToMint,
      playerId: player._id,
      gasLimit
    });
    
    if (!success) {
      console.error('Failed to queue transaction');
      return res.json({ 
        error: 'Transaction queueing failed',
        dbUpdated: true, // DB was still updated though
        success: false
      });
    }
    
    return res.json({ 
      success: true, 
      message: 'Token transfer queued successfully',
      gasLimit: gasLimitStr,
      pointsToMint,
      enabledTokenRewards: true,
      dbUpdated: true
    });
  } catch (error) {
    console.error('Token transfer error:', error);
    return res.status(500).json({ error: 'Token transfer failed', message: error.message });
  }
});

// Backward compatibility for old mint-tokens endpoint
app.post('/api/mint-tokens', async (req, res) => {
  console.log('Deprecated /api/mint-tokens endpoint called - redirecting to /api/transfer-tokens');
  
  // Forward the request to the new endpoint
  const { walletAddress, coinsCollected } = req.body;
  
  if (!walletAddress || !ethers.isAddress(walletAddress) || !coinsCollected || coinsCollected <= 0) {
    return res.status(400).json({ error: 'Invalid wallet address or coin count' });
  }
  
  try {
    // Find player
    let player = await Player.findOne({ walletAddress });
    
    if (!player) {
      return res.status(404).json({ error: 'Player not registered. Please register first.' });
    }
    
    // Calculate token amount (1 point per coin)
    const pointsToMint = coinsCollected;
    
    // Get optimized gas limit for the transaction
    let gasLimit = global.gasOptimizer.getOptimizedGasLimit('GAS_LIMIT_TRANSFER') || 
                  BigInt(process.env.GAS_LIMIT_TRANSFER || 80000);
    
    // Queue transaction using relayer system
    const success = relayerSystem.queueTransaction({
      walletAddress,
      pointsToMint,
      playerId: player._id,
      gasLimit
    });
    
    // Update player record
    player.totalPoints += pointsToMint;
    await player.save();
    
    stats.tokensTrackedInDb += pointsToMint;
    
    if (!success) {
      return res.json({ 
        error: 'Transaction queueing failed',
        dbUpdated: true,
        success: false
      });
    }
    
    return res.json({ 
      success: true, 
      message: 'Token transfer initiated (using treasury transfer)',
      pointsToMint,
      totalPoints: player.totalPoints
    });
  } catch (error) {
    console.error('Token transfer error (legacy endpoint):', error);
    res.status(500).json({ error: 'Failed to transfer tokens', success: false });
  }
});

// Register a new player
app.post('/api/register', async (req, res) => {
  const { walletAddress, username } = req.body;
  
  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }
  
  if (!username || username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be between 3 and 20 characters' });
  }
  
  try {
    // Check if wallet already registered
    const existingPlayer = await Player.findOne({ walletAddress });
    if (existingPlayer) {
      return res.status(409).json({ error: 'Wallet already registered', player: existingPlayer });
    }
    
    // Check if username is taken
    const existingUsername = await Player.findOne({ username });
    if (existingUsername) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    
    // Create new player
    const player = new Player({
      walletAddress,
      username,
      totalPoints: 0,
      registeredAt: new Date()
    });
    
    await player.save();
    
    // Create initial leaderboard entry
    const leaderboardEntry = new Leaderboard({
      walletAddress,
      username: username,
      highestScore: 0,
      updatedAt: new Date()
    });
    
    await leaderboardEntry.save();
    
    // Track unique players
    stats.uniquePlayers++;
    stats.activePlayers[walletAddress] = { username, lastActive: Date.now() };
    
    res.json({ success: true, player });
  } catch (error) {
    console.error('Player registration error:', error);
    res.status(500).json({ error: 'Failed to register player' });
  }
});

// Check if a player is registered
app.get('/api/player/:walletAddress', async (req, res) => {
  const { walletAddress } = req.params;
  
  console.log(`Player API request received for wallet: ${walletAddress}`);

  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    console.log('Invalid wallet address provided');
    return res.status(400).json({ error: 'Invalid wallet address' });
  }
  
  try {
    console.log(`Looking up player with wallet address: ${walletAddress}`);
    
    // Count total players in the database
    const totalPlayers = await Player.countDocuments();
    console.log(`Total players in database: ${totalPlayers}`);
    
    const player = await Player.findOne({ walletAddress });
    
    if (player) {
      console.log(`Player found: ${player.username}`);
      
      // Get leaderboard info for this player
      const leaderboardEntry = await Leaderboard.findOne({ walletAddress });
      console.log(`Leaderboard entry found: ${leaderboardEntry ? 'Yes' : 'No'}`);
      
      // Track active player
      stats.activePlayers[walletAddress] = { username: player.username, lastActive: Date.now() };
      
      // Return player data with leaderboard info
      const playerData = player.toObject();
      
      // If leaderboard entry exists, include the highest score
      if (leaderboardEntry) {
        playerData.highestScore = leaderboardEntry.highestScore;
        playerData.lastScoreUpdate = leaderboardEntry.updatedAt;
      }
      
      console.log(`Returning player data with highestScore: ${playerData.highestScore || 'not set'}`);
      
      return res.json({ 
        registered: true, 
        player: playerData
      });
    } else {
      console.log(`No player found with wallet address: ${walletAddress}`);
      return res.json({ registered: false });
    }
  } catch (error) {
    console.error('Player lookup error:', error);
    res.status(500).json({ error: 'Failed to check player registration' });
  }
});

// Save player score and update leaderboard
app.post('/api/save-score', async (req, res) => {
  const { walletAddress, score } = req.body;

  if (!walletAddress || !ethers.isAddress(walletAddress) || typeof score !== 'number') {
    return res.status(400).json({ error: 'Invalid wallet address or score' });
  }

  try {
    // Find player
    const player = await Player.findOne({ walletAddress });
    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }
    
    // Track active player
    stats.activePlayers[walletAddress] = { username: player.username, lastActive: Date.now() };
    
    // Update leaderboard
    let leaderboardEntry = await Leaderboard.findOne({ walletAddress });
    
    if (leaderboardEntry) {
      // Update if new score is higher
      if (score > leaderboardEntry.highestScore) {
        leaderboardEntry.highestScore = score;
        leaderboardEntry.updatedAt = new Date();
        await leaderboardEntry.save();
      }
    } else {
      // Create new entry if not exists
      leaderboardEntry = new Leaderboard({
          walletAddress, 
          username: player.username,
          highestScore: score,
        updatedAt: new Date()
      });
      await leaderboardEntry.save();
    }
    
    res.json({ success: true, message: 'Score saved' });
  } catch (error) {
    console.error('Score saving error:', error);
    res.status(500).json({ error: 'Failed to save score' });
  }
});

// Get leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    console.log('Leaderboard API request received');
    
    // Count total entries in leaderboard collection
    const totalEntries = await Leaderboard.countDocuments();
    console.log(`Total leaderboard entries in database: ${totalEntries}`);
    
    const leaderboard = await Leaderboard.find()
      .sort({ highestScore: -1 })
      .limit(100);
    
    console.log(`Retrieved ${leaderboard.length} leaderboard entries`);
    
    // If no entries, try to check if there are any players
    if (leaderboard.length === 0) {
      const playerCount = await Player.countDocuments();
      console.log(`No leaderboard entries, but found ${playerCount} players in database`);
    }
    
    res.json(leaderboard);
  } catch (error) {
    console.error('Leaderboard retrieval error:', error);
    res.status(500).json({ error: 'Failed to retrieve leaderboard' });
  }
});

// Status API endpoint
app.get('/api/admin/status', async (req, res) => {
  try {
    // Log initial entry
    console.log('Status API request received');
    
    const blockNumber = await provider.getBlockNumber();
    
    // If the server isn't initialized yet, return minimal status
    if (!isBackendInitialized) {
      console.log('Returning initializing status - backend not fully initialized yet');
      return res.json({ 
        serverStatus: {
          status: 'initializing',
          message: 'Backend server is still initializing...'
        }
      });
    }
    
    // Check if relayerSystem is initialized
    if (!relayerSystem || !relayerSystem.isInitialized) {
      console.log('Relayer system not fully initialized yet');
      return res.json({
        serverStatus: {
          status: 'online',
          uptime: Date.now() - stats.serverStartTime,
          startTime: stats.serverStartTime
        },
        rpcStatus: {
          status: stats.rpcStatus,
          blockNumber,
          reconnectAttempts: stats.rpcReconnectAttempts
        },
        relayerSystem: {
          status: 'initializing',
          message: 'Relayer system is still initializing...'
        }
      });
    }
    
    // Get relayer system status and convert BigInt values
    console.log('Getting relayer system status');
    const relayerStatus = relayerSystem.getRelayerStatus();
    const queueStatus = relayerSystem.getQueueStatus();
    
    // Format Relayer Stats to remove BigInt values
    const formattedRelayerStats = {};
    for (const [address, stats] of Object.entries(relayerStatus.relayerStats)) {
      formattedRelayerStats[address] = {
        ...stats,
        // Convert any BigInt values to strings
        balance: stats.balance ? stats.balance.toString() : '0',
      };
    }
    
    const treasuryBalance = await getTokenBalance(process.env.TREASURY_ADDRESS);
    const ownerBalance = await provider.getBalance(process.env.PRIVATE_KEY ? 
      new ethers.Wallet(process.env.PRIVATE_KEY).address : '0x0');
    
    return res.json({
      serverStatus: {
        status: 'online',
        version: '1.0.0',
        uptime: Date.now() - stats.serverStartTime,
        startTime: stats.serverStartTime
      },
      rpcStatus: {
        status: stats.rpcStatus,
        provider: process.env.MONAD_RPC_URL,
        blockNumber,
        reconnectAttempts: stats.rpcReconnectAttempts
      },
      contractStatus: {
        address: process.env.TOKEN_CONTRACT_ADDRESS,
        treasuryAddress: process.env.TREASURY_ADDRESS,
        treasuryBalance: treasuryBalance.toString(),
        ownerBalance: ethers.formatEther(ownerBalance.toString())
      },
      playerStats: {
        totalPlayers: await Player.countDocuments(),
        leaderboardEntries: await Leaderboard.countDocuments()
      },
      relayerSystem: {
        ...relayerStatus,
        relayerStats: formattedRelayerStats
      },
      queueStatus: {
        ...queueStatus
      },
      transactionStats: {
        totalTxAttempted: stats.totalTxAttempted,
        totalTxSuccess: stats.totalTxSuccess,
        totalTxFailed: stats.totalTxFailed,
        lastSuccessHash: stats.lastSuccessHash,
        lastSuccessTimestamp: stats.lastSuccessTimestamp,
        lastErrorMessage: stats.lastErrorMessage,
        lastErrorTimestamp: stats.lastErrorTimestamp,
        tokensTrackedInDb: stats.tokensTrackedInDb
      }
    });
  } catch (error) {
    console.error('Error in admin status endpoint:', error);
    res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
});

// Get transaction history
app.get('/api/admin/tx-history', async (req, res) => {
  res.json({
    history: txHistory
  });
});

// Get all players with pagination
app.get('/api/admin/players', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    
    const players = await Player.find()
      .sort({ registeredAt: -1 })
      .skip(skip)
      .limit(limit);
    
    const totalPlayers = await Player.countDocuments();
    const totalPages = Math.ceil(totalPlayers / limit);
    
    res.json({
      success: true,
      players,
      pagination: {
        total: totalPlayers,
        page,
        totalPages,
        limit
      }
    });
  } catch (error) {
    console.error('Error getting players:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Get game statistics
app.get('/api/admin/game-stats', async (req, res) => {
  try {
    const GameStats = require('./models/GameStats');
    const stats = await GameStats.findOne() || {};
    
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error getting game stats:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Update game statistics
app.post('/api/admin/game-stats', async (req, res) => {
  try {
    const GameStats = require('./models/GameStats');
    const statsData = req.body;
    
    // Validate input
    if (!statsData || typeof statsData !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Invalid statistics data'
      });
    }
    
    const updatedStats = await GameStats.updateDailyStats(statsData);
    
    res.json({
      success: true,
      message: 'Game statistics updated successfully',
      stats: updatedStats
    });
  } catch (error) {
    console.error('Error updating game stats:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Helper function to get token balance
async function getTokenBalance(address) {
  try {
    if (!address || !ethers.isAddress(address)) {
      return BigInt(0);
    }
    
    const balance = await tokenContract.balanceOf(address);
    return balance;
  } catch (error) {
    console.error(`Error getting token balance for ${address}:`, error);
    return BigInt(0);
  }
}

// Add routes to your express app
app.use('/api/gas', gasRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/relayer', relayerRoutes);

// Start the server
app.listen(port, async () => {
  console.log(`Server running on port ${port}`);
  
  // Initialize the backend
  try {
    await initializeBackend();
  } catch (error) {
    console.error('Failed to initialize backend. Server not started.', error);
  }
});

// Apply error handler middleware (must be after all routes)
app.use(errorHandler);

// Export app for testing
module.exports = app;