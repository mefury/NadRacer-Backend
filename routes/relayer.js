const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');
const relayerSystem = require('../relayer');
const logger = require('../config/logger');

/**
 * Convert BigInt values to strings in an object for JSON responses
 */
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

/**
 * Get relayer system status
 */
router.get('/status', async (req, res) => {
  try {
    const relayerStatus = relayerSystem.getRelayerStatus();
    res.json(convertBigIntsToStrings(relayerStatus));
  } catch (error) {
    console.error('Error getting relayer status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get queue status
 */
router.get('/queue', async (req, res) => {
  try {
    const queueStatus = relayerSystem.getQueueStatus();
    res.json(convertBigIntsToStrings(queueStatus));
  } catch (error) {
    console.error('Error getting queue status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Force process queue
 */
router.post('/process-queue', async (req, res) => {
  try {
    relayerSystem.startProcessingAllQueues();
    res.json({ success: true, message: 'Queue processing started' });
  } catch (error) {
    console.error('Error starting queue processing:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Set relayer status (active/inactive)
 */
router.post('/relayer-status', async (req, res) => {
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
    console.error('Error setting relayer status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Refresh relayer nonce
 */
router.post('/refresh-nonce', async (req, res) => {
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
    console.error('Error refreshing nonce:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Start processing all queued transactions
 */
router.post('/process-all-queues', async (req, res) => {
  try {
    // Since we removed this method in our implementation, we need a work-around
    // We'll access relayers through the status and manually call processQueue
    const relayerStatus = relayerSystem.getRelayerStatus();
    const queueStatus = relayerSystem.getQueueStatus();
    
    // Get all relayers with pending transactions
    const relayersWithQueue = Object.entries(queueStatus.queuesByRelayer)
      .filter(([_, queue]) => queue.length > 0)
      .map(([address]) => address);
    
    // Find and process queues for each relayer
    for (const address of relayersWithQueue) {
      const relayerObj = relayerSystem.relayers.find(r => r.address === address);
      if (relayerObj && !queueStatus.queuesByRelayer[address].isProcessing) {
        // Call process queue for each relayer
        relayerSystem.processQueue(relayerObj);
      }
    }
    
    res.json({
      success: true,
      message: `Started processing queues for ${relayersWithQueue.length} relayers with pending transactions`
    });
  } catch (error) {
    logger.error('Error starting queue processing', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

/**
 * Get queue for a specific relayer
 */
router.get('/queue/:address', async (req, res) => {
  const { address } = req.params;
  
  if (!address || !ethers.isAddress(address)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid relayer address'
    });
  }
  
  try {
    const queueStatus = relayerSystem.getQueueStatus();
    
    // Convert txQueues[address] safely to JSON
    const queueData = relayerSystem.txQueues[address] || [];
    const formattedQueue = queueData.map(tx => ({
      ...tx,
      timestamp: tx.timestamp,
      retryCount: tx.retryCount || 0,
      walletAddress: tx.walletAddress,
      pointsToMint: tx.pointsToMint.toString()
    }));
    
    res.json({
      success: true,
      address,
      queueLength: formattedQueue.length,
      isProcessing: queueStatus.queuesByRelayer[address]?.isProcessing || false,
      transactions: formattedQueue
    });
  } catch (error) {
    logger.error(`Error getting queue for relayer ${address}`, error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

module.exports = router; 