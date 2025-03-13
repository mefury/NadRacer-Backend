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
const gasOptimizer = require('./services/gasOptimizer');
const gasRoutes = require('./routes/gas');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./config/logger');

// Import token ABI
const NPTokenABI = require('./NPTokenABI.json');

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

// Global error handler for uncaught promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  stats.lastErrorMessage = reason?.message || 'Unknown promise rejection';
  stats.lastErrorTimestamp = Date.now();
  // Don't crash the server, just log the error
});

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
      await relayerSystem.initialize(provider);
      
      // Create contract instance for owner wallet (for admin operations)
      ownerWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
      tokenContract = new ethers.Contract(process.env.TOKEN_CONTRACT_ADDRESS, NPTokenABI, ownerWallet);
    
    console.log('Provider reconnected successfully');
    stats.rpcStatus = 'reconnected';
    return true;
    } else {
      console.error('Failed to reconnect provider');
      stats.rpcStatus = 'failed';
    return false;
  }
  } catch (error) {
    console.error('Error reconnecting provider:', error);
    stats.rpcStatus = 'failed';
    stats.lastErrorMessage = error.message;
    stats.lastErrorTimestamp = Date.now();
    return false;
  }
};

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

// Initialize the backend
const initializeBackend = async () => {
  try {
    console.log('Initializing NadRacer backend server...');
    
    // Initialize provider
    provider = await setupProvider();
    if (!provider) {
      throw new Error('Failed to initialize provider');
    }
    
    // Create owner wallet for admin operations
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey || !privateKey.startsWith('0x')) {
      throw new Error('Invalid private key format. Must start with 0x.');
    }
    
    ownerWallet = new ethers.Wallet(privateKey, provider);
    console.log(`Owner wallet address: ${ownerWallet.address}`);
    
    // Create token contract instance
    const tokenAddress = process.env.TOKEN_CONTRACT_ADDRESS;
    tokenContract = new ethers.Contract(tokenAddress, NPTokenABI, ownerWallet);
    
    // Check if owner wallet has token contract owner permissions
    try {
      const owner = await tokenContract.owner();
      const isOwner = owner.toLowerCase() === ownerWallet.address.toLowerCase();
      console.log('Owner wallet is contract owner:', isOwner);
      
      if (!isOwner) {
        console.log('⚠️ WARNING: Owner wallet is not the contract owner. Some operations may fail.');
        console.log('Contract owner:', owner);
        console.log('Owner wallet:', ownerWallet.address);
      }
    } catch (error) {
      console.error('Error checking contract ownership:', error);
    }
    
    // Initialize relayer system
    const relayerInitResult = await relayerSystem.initialize(provider);
    if (relayerInitResult) {
      console.log('Relayer system initialized successfully');
      
      // Set up transaction complete callback to add to history
      relayerSystem.setTransactionCompleteCallback((txData) => {
        addToTxHistory({
          type: 'token_mint',
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
    await gasOptimizer.initialize(provider, tokenContract, ownerWallet);
    console.log('Gas optimizer initialized');
    
    console.log('Backend initialization complete.');
    isBackendInitialized = true; // Mark backend as fully initialized
    
    return true;
  } catch (error) {
    console.error('Backend initialization failed:', error);
    return false;
  }
};

// Mint tokens for coin collection in real-time
app.post('/api/mint-tokens', async (req, res) => {
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
    console.log(`Processing ${pointsToMint} tokens for ${walletAddress}`);
    
    // Always update the database immediately for better UX
    player.totalPoints += pointsToMint;
    await player.save();
    
    stats.tokensTrackedInDb += pointsToMint;
    
    // Get optimized gas limit for the transaction
    const gasLimit = gasOptimizer.getOptimizedGasLimit('rewardPlayer') || 
                    config.gasConfig.defaultLimits.rewardPlayer;
    
    // Queue transaction using relayer system with optimized gas
    const success = relayerSystem.queueTransaction({
      walletAddress,
      pointsToMint,
      playerId: player._id,
      gasLimit
    });
    
    if (!success) {
      console.error('Failed to queue transaction');
      return res.status(500).json({ 
        error: 'Transaction queueing failed',
        dbUpdated: true // DB was still updated though
      });
    }
    
    return res.json({ 
      success: true, 
      message: 'Tokens minting initiated',
      pointsToMint,
      totalPoints: player.totalPoints,
      gasLimit // Include gas limit in response for transparency
    });
  } catch (error) {
    console.error('Token minting error:', error);
    res.status(500).json({ error: 'Failed to mint tokens' });
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
    
    // Debug log the relayer status to see what might be causing issues
    console.log('Relayer status retrieved:', 
      JSON.stringify({
        totalRelayers: relayerStatus.totalRelayers,
        activeRelayers: relayerStatus.activeRelayers
      })
    );
    
    // Convert BigInt values to strings
    const processedRelayerStatus = convertBigIntsToStrings(relayerStatus);
    const processedQueueStatus = convertBigIntsToStrings(queueStatus);
    
    // Calculate aggregated stats from all relayers
    let totalTxSent = 0;
    let totalTxSuccess = 0;
    let totalTxFailed = 0;
    let totalTokensMinted = 0;
    
    Object.values(processedRelayerStatus.relayerStats).forEach(stats => {
      totalTxSent += stats.totalTxSent;
      totalTxSuccess += stats.totalTxSuccess;
      totalTxFailed += stats.totalTxFailed;
      totalTokensMinted += stats.tokensMinted;
    });
    
    // Count active players (active in last 30 minutes)
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    const activePlayers = Object.entries(stats.activePlayers).filter(([_, data]) => data.lastActive > thirtyMinutesAgo).length;
    
    const responseData = {
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
        ...processedRelayerStatus,
        queueStatus: processedQueueStatus
      },
      txStats: {
        totalTxAttempted: totalTxSent,
        totalTxSuccess,
        totalTxFailed,
        successRate: totalTxSent > 0 ? (totalTxSuccess / totalTxSent * 100).toFixed(2) + '%' : '0%',
        lastErrorMessage: stats.lastErrorMessage,
        lastErrorTimestamp: stats.lastErrorTimestamp
      },
      gameStats: {
        uniquePlayers: stats.uniquePlayers,
        activePlayers,
        totalTokensMinted,
        tokensTrackedInDb: stats.tokensTrackedInDb
      }
    };
    
    // Convert any remaining BigInt values to strings before sending response
    console.log('Sending status response');
    res.json(convertBigIntsToStrings(responseData));
  } catch (error) {
    console.error('Status API error:', error);
    
    // Include more detailed error information in the response
    res.status(500).json({ 
      error: 'Failed to get server status',
      message: error.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : error.stack
    });
  }
});

// Admin API - Get transaction history
app.get('/api/admin/tx-history', (req, res) => {
  try {
    console.log('TX History API request received');
    
    // If backend isn't initialized yet, return empty history
    if (!isBackendInitialized) {
      console.log('Backend not fully initialized, returning empty history');
      return res.json([]);
    }
    
    // Convert any BigInt values to strings
    const processedTxHistory = convertBigIntsToStrings(txHistory);
    res.json(processedTxHistory);
  } catch (error) {
    console.error('TX History API error:', error);
    res.status(500).json({ 
      error: 'Failed to get transaction history',
      message: error.message 
    });
  }
});

// Admin API - Force process queue
app.post('/api/admin/process-queue', async (req, res) => {
  try {
    relayerSystem.startProcessingAllQueues();
    res.json({ success: true, message: 'Queue processing started' });
  } catch (error) {
    console.error('Force process queue error:', error);
    res.status(500).json({ error: 'Failed to start queue processing' });
  }
});

// Admin API - Set relayer status (active/inactive)
app.post('/api/admin/relayer-status', async (req, res) => {
  const { relayerAddress, isActive } = req.body;
  
  if (!relayerAddress || typeof isActive !== 'boolean') {
    return res.status(400).json({ error: 'Invalid relayer address or status' });
  }
  
  try {
    const success = relayerSystem.setRelayerStatus(relayerAddress, isActive);
    
    if (success) {
      res.json({ success: true, message: `Relayer ${relayerAddress} set to ${isActive ? 'active' : 'inactive'}` });
    } else {
      res.status(404).json({ error: 'Relayer not found' });
    }
  } catch (error) {
    console.error('Set relayer status error:', error);
    res.status(500).json({ error: 'Failed to set relayer status' });
  }
});

// Admin API - Refresh relayer nonce
app.post('/api/admin/refresh-nonce', async (req, res) => {
  const { relayerIndex } = req.body;
  
  if (typeof relayerIndex !== 'number' || relayerIndex < 0) {
    return res.status(400).json({ error: 'Invalid relayer index' });
  }
  
  try {
    const success = await relayerSystem.refreshRelayerNonce(relayerIndex);
    
    if (success) {
      res.json({ success: true, message: `Nonce refreshed for relayer ${relayerIndex}` });
    } else {
      res.status(404).json({ error: 'Relayer not found' });
    }
  } catch (error) {
    console.error('Refresh nonce error:', error);
    res.status(500).json({ error: 'Failed to refresh nonce' });
  }
});

// Admin API - Get player data
app.get('/api/admin/players', async (req, res) => {
  try {
    console.log('Admin Players API request received');
    
    // Count total players
    const totalPlayers = await Player.countDocuments();
    console.log(`Total players in database: ${totalPlayers}`);
    
    // Get all players with pagination
    const limit = parseInt(req.query.limit) || 100;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;
    
    const players = await Player.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    
    console.log(`Retrieved ${players.length} players`);
    
    // Get leaderboard data
    const leaderboard = await Leaderboard.find()
      .sort({ highestScore: -1 })
      .limit(100);
    
    console.log(`Retrieved ${leaderboard.length} leaderboard entries for admin panel`);
    
    res.json({
      totalPlayers,
      players,
      leaderboard,
      pagination: {
        page,
        limit,
        totalPages: Math.ceil(totalPlayers / limit)
      }
    });
  } catch (error) {
    console.error('Admin Players API error:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve player data',
      message: error.message 
    });
  }
});

// Admin API - Get leaderboard data
app.get('/api/admin/leaderboard', async (req, res) => {
  try {
    console.log('Admin Leaderboard API request received');
    
    // Count total entries in leaderboard collection
    const totalEntries = await Leaderboard.countDocuments();
    console.log(`Total leaderboard entries in database: ${totalEntries}`);
    
    // First entry for debugging
    const firstEntry = await Leaderboard.findOne().sort({ highestScore: -1 });
    if (firstEntry) {
      console.log('First leaderboard entry (for debugging):');
      console.log({
        id: firstEntry._id,
        walletAddress: firstEntry.walletAddress,
        username: firstEntry.username,
        highestScore: firstEntry.highestScore,
        updatedAt: firstEntry.updatedAt
      });
  } else {
      console.log('No leaderboard entries found');
    }
    
    const leaderboard = await Leaderboard.find()
      .sort({ highestScore: -1 })
      .limit(100);
    
    console.log(`Retrieved ${leaderboard.length} leaderboard entries for admin panel`);
    
    // Add detailed log of first few entries
    if (leaderboard.length > 0) {
      console.log(`First ${Math.min(3, leaderboard.length)} leaderboard entries:`);
      leaderboard.slice(0, 3).forEach((entry, index) => {
        console.log(`Entry ${index + 1}: username=${entry.username}, highestScore=${entry.highestScore}`);
      });
    }
    
    // Return the leaderboard data
    res.json(leaderboard);
  } catch (error) {
    console.error('Admin Leaderboard retrieval error:', error);
    res.status(500).json({ error: 'Failed to retrieve leaderboard' });
  }
});

// Add gas routes to your express app
app.use('/api/gas', gasRoutes);

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