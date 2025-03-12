/**
 * Relayer System for NadRacer
 * 
 * This module implements a transaction relayer system that uses multiple wallets
 * to process transactions in parallel for improved throughput and reliability.
 */

const { ethers } = require('ethers');
require('dotenv').config();

// Import token ABI
const NPTokenABI = require('./NPTokenABI.json');

class RelayerSystem {
  constructor() {
    this.provider = null;
    this.relayers = [];
    this.relayerStats = {};
    this.tokenContract = null;
    this.tokenAddress = process.env.TOKEN_CONTRACT_ADDRESS;
    this.maxRelayers = parseInt(process.env.NUM_RELAYERS || 20);
    this.isInitialized = false;
    this.txQueues = {}; // One queue per relayer
    this.processingFlags = {}; // Track which relayer queues are being processed
    this.ownerWallet = null; // Store the owner wallet for contract operations
    this.onTransactionComplete = null; // Store the transaction complete callback
  }

  /**
   * Initialize the relayer system
   * @returns {Promise<boolean>} True if initialization successful
   */
  async initialize(provider) {
    try {
      this.provider = provider;
      console.log(`Initializing relayer system with ${this.maxRelayers} relayers`);
      
      // Initialize owner wallet first (this has the minting permissions)
      const ownerPrivateKey = process.env.PRIVATE_KEY;
      if (!ownerPrivateKey) {
        console.error('Owner private key not found in environment variables');
        return false;
      }
      
      this.ownerWallet = new ethers.Wallet(ownerPrivateKey, this.provider);
      console.log(`Using owner wallet ${this.ownerWallet.address} for contract operations`);
      
      // Initialize token contract with owner wallet
      this.tokenContract = new ethers.Contract(this.tokenAddress, NPTokenABI, this.ownerWallet);
      
      // Verify owner has minting permissions
      try {
        const contractOwner = await this.tokenContract.owner();
        const isOwner = contractOwner.toLowerCase() === this.ownerWallet.address.toLowerCase();
        console.log(`Owner wallet has contract ownership: ${isOwner}`);
        
        if (!isOwner) {
          console.warn('⚠️ Warning: Owner wallet does not own the contract. Minting operations may fail.');
        }
      } catch (error) {
        console.error('Error checking contract ownership:', error.message);
      }
      
      // Initialize relayers from environment variables
      for (let i = 0; i < this.maxRelayers; i++) {
        const privateKeyEnvVar = `RELAYER_WALLET_${i}`;
        const privateKey = process.env[privateKeyEnvVar];
        
        if (privateKey) {
          try {
            const wallet = new ethers.Wallet(privateKey, this.provider);
            this.relayers.push(wallet);
            this.txQueues[wallet.address] = [];
            this.processingFlags[wallet.address] = false;
            
            // Initialize nonce for each relayer
            const nonce = await this.provider.getTransactionCount(wallet.address);
            
            // Get wallet balance (BigInt)
            const balance = await this.provider.getBalance(wallet.address);
            
            this.relayerStats[wallet.address] = {
              address: wallet.address,
              index: i,
              currentNonce: nonce,
              totalTxSent: 0,
              totalTxSuccess: 0,
              totalTxFailed: 0,
              lastError: null,
              lastErrorTimestamp: null,
              lastSuccessTimestamp: null,
              lastSuccessHash: null,
              queueLength: 0,
              tokensMinted: 0,
              isActive: true,
              // Store balance as string to avoid BigInt serialization issues
              balance: balance.toString()
            };
            
            console.log(`Relayer ${i} initialized with address ${wallet.address}, nonce ${nonce}`);
          } catch (error) {
            console.error(`Failed to initialize relayer ${i}:`, error.message);
          }
        }
      }
      
      if (this.relayers.length === 0) {
        console.error('No valid relayers could be initialized. Check your .env configuration.');
        return false;
      }
      
      console.log(`Relayer system initialized with ${this.relayers.length} active relayers`);
      this.isInitialized = true;
      return true;
    } catch (error) {
      console.error('Failed to initialize relayer system:', error);
      return false;
    }
  }

  /**
   * Get the status of all relayers
   * @returns {Object} Status information for all relayers
   */
  getRelayerStatus() {
    return {
      totalRelayers: this.relayers.length,
      activeRelayers: this.relayers.filter(r => this.relayerStats[r.address].isActive).length,
      relayerStats: this.relayerStats
    };
  }

  /**
   * Refresh nonce for a specific relayer
   * @param {number} relayerIndex Index of the relayer to refresh
   * @returns {Promise<boolean>} True if refresh was successful
   */
  async refreshRelayerNonce(relayerIndex) {
    try {
      if (relayerIndex >= this.relayers.length) return false;
      
      const relayer = this.relayers[relayerIndex];
      const nonce = await this.provider.getTransactionCount(relayer.address);
      this.relayerStats[relayer.address].currentNonce = nonce;
      
      console.log(`Refreshed nonce for relayer ${relayerIndex} (${relayer.address}): ${nonce}`);
      return true;
    } catch (error) {
      console.error(`Failed to refresh nonce for relayer ${relayerIndex}:`, error.message);
      return false;
    }
  }

  /**
   * Select the best relayer for a new transaction
   * @returns {Object} The selected relayer wallet
   */
  selectRelayer() {
    if (this.relayers.length === 0) {
      return null;
    }
    
    // Filter out inactive relayers
    const activeRelayers = this.relayers.filter(r => 
      this.relayerStats[r.address] && this.relayerStats[r.address].isActive
    );
    
    if (activeRelayers.length === 0) {
      return null;
    }
    
    // Simple load balancing: choose the relayer with the shortest queue
    let bestRelayer = activeRelayers[0];
    let shortestQueueLength = this.txQueues[bestRelayer.address].length;
    
    for (const relayer of activeRelayers) {
      const queueLength = this.txQueues[relayer.address].length;
      if (queueLength < shortestQueueLength) {
        shortestQueueLength = queueLength;
        bestRelayer = relayer;
      }
    }
    
    return bestRelayer;
  }

  /**
   * Set a transaction complete callback
   * @param {Function} callback Function to call when transaction completes
   */
  setTransactionCompleteCallback(callback) {
    this.onTransactionComplete = callback;
  }

  /**
   * Add a transaction to the queue
   * @param {Object} txData Transaction data
   * @returns {boolean} True if added to queue successfully
   */
  queueTransaction(txData) {
    if (!this.isInitialized) {
      console.error('Cannot queue transaction: relayer system not initialized');
      return false;
    }
    
    if (!txData.walletAddress || !txData.pointsToMint) {
      console.error('Invalid transaction data:', txData);
      return false;
    }
    
    // Add timestamp to the transaction
    txData.timestamp = Date.now();
    
    // Select the best relayer to handle this transaction
    const relayer = this.selectRelayer();
    if (!relayer) {
      console.error('No suitable relayer available');
      return false;
    }
    
    // Add to the selected relayer's queue
    this.txQueues[relayer.address].push(txData);
    this.relayerStats[relayer.address].queueLength = this.txQueues[relayer.address].length;
    
    console.log(`Transaction for ${txData.walletAddress} added to relayer ${this.relayerStats[relayer.address].index} queue (${this.txQueues[relayer.address].length} pending)`);
    
    // Start queue processing (if not already processing)
    this.processQueue(relayer);
    
    return true;
  }

  /**
   * Process the transaction queue for a specific relayer
   * @param {Object} relayer The relayer wallet object
   */
  async processQueue(relayer) {
    const relayerAddress = relayer.address;
    
    if (this.processingFlags[relayerAddress] || this.txQueues[relayerAddress].length === 0) {
      return;
    }
    
    this.processingFlags[relayerAddress] = true;
    console.log(`Processing queue for relayer ${relayerAddress} (${this.txQueues[relayerAddress].length} transactions)`);
    
    try {
      let consecutiveFailures = 0;
      
      while (this.txQueues[relayerAddress].length > 0) {
        // Too many consecutive failures, pause processing
        if (consecutiveFailures >= 3) {
          console.log(`Too many consecutive failures for relayer ${relayerAddress}, pausing queue processing for cooldown`);
          await new Promise(resolve => setTimeout(resolve, 15000)); // 15 second cooldown
          
          // Refresh nonce before continuing
          const nonce = await this.provider.getTransactionCount(relayerAddress);
          this.relayerStats[relayerAddress].currentNonce = nonce;
          
          console.log(`Resuming queue processing for relayer ${relayerAddress} after cooldown`);
          consecutiveFailures = 0;
        }
        
        const txData = this.txQueues[relayerAddress][0];
        const stats = this.relayerStats[relayerAddress];
        
        // Check if this transaction has been retried too many times
        const retryCount = txData.retryCount || 0;
        const maxRetries = 5; // Maximum number of retries per transaction
        
        if (retryCount >= maxRetries) {
          console.log(`Transaction for ${txData.walletAddress} (${txData.pointsToMint} tokens) has been retried ${retryCount} times - removing from queue`);
          
          // Record permanent failure
          if (this.onTransactionComplete) {
            this.onTransactionComplete({
              hash: null,
              walletAddress: txData.walletAddress,
              pointsToMint: txData.pointsToMint,
              success: false,
              relayerAddress,
              relayerIndex: this.relayerStats[relayerAddress].index,
              error: `Max retries (${maxRetries}) exceeded`
            });
          }
          
          // Remove from queue and continue with next transaction
          this.txQueues[relayerAddress].shift();
          this.relayerStats[relayerAddress].queueLength = this.txQueues[relayerAddress].length;
          continue;
        }
        
        try {
          // We'll use the owner wallet for contract operations since it has minting rights
          // But we'll still track the transaction as belonging to this relayer
          
          // Prepare transaction data
          const walletAddress = txData.walletAddress;
          const pointsToMint = txData.pointsToMint;
          const tokenAmount = ethers.parseUnits(pointsToMint.toString(), 18);
          
          console.log(`Relayer ${relayerAddress} processing ${pointsToMint} tokens for ${walletAddress} (using owner wallet) - attempt #${retryCount + 1}`);
          
          let tx;
          try {
            // Check if we can use treasury or need direct minting
            const hasTreasury = await this.tokenContract.gameTreasury().catch(() => ethers.ZeroAddress);
            const useTreasury = hasTreasury !== ethers.ZeroAddress;
            
            if (useTreasury) {
              // Try reward from treasury first
              const treasury = await this.tokenContract.gameTreasury();
              const treasuryBalance = await this.tokenContract.balanceOf(treasury);
              
              if (treasuryBalance.gte(tokenAmount)) {
                console.log(`Using treasury reward method for ${walletAddress}`);
                tx = await this.tokenContract.rewardPlayer(walletAddress, tokenAmount);
              } else {
                console.log(`Insufficient treasury balance, using direct minting for ${walletAddress}`);
                tx = await this.tokenContract.mintTokens(walletAddress, tokenAmount);
              }
            } else {
              // Direct minting if no treasury available
              console.log(`Using direct minting for ${walletAddress}`);
              tx = await this.tokenContract.mintTokens(walletAddress, tokenAmount);
            }
            
            // Wait for transaction confirmation with timeout
            console.log(`Waiting for transaction ${tx.hash} to be confirmed...`);
            const receipt = await Promise.race([
              tx.wait(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Transaction confirmation timeout')), 60000))
            ]);
            
            // Transaction successful - update stats for relayer
            this.relayerStats[relayerAddress].totalTxSent++;
            this.relayerStats[relayerAddress].totalTxSuccess++;
            this.relayerStats[relayerAddress].lastSuccessTimestamp = Date.now();
            this.relayerStats[relayerAddress].lastSuccessHash = receipt.hash;
            this.relayerStats[relayerAddress].tokensMinted += Number(pointsToMint);
            
            console.log(`✅ Transaction successful: ${receipt.hash} for ${walletAddress} (${pointsToMint} tokens)`);
            
            // Add to transaction history
            if (this.onTransactionComplete) {
              this.onTransactionComplete({
                hash: receipt.hash,
                walletAddress,
                pointsToMint,
                success: true,
                relayerAddress,
                relayerIndex: this.relayerStats[relayerAddress].index,
                gasUsed: receipt.gasUsed?.toString() || '0'
              });
            }
            
            // Remove from queue and continue processing
            this.txQueues[relayerAddress].shift();
            this.relayerStats[relayerAddress].queueLength = this.txQueues[relayerAddress].length;
            consecutiveFailures = 0;
          } catch (error) {
            console.error(`❌ Transaction error for relayer ${relayerAddress}:`, error.message);
            
            // Track failure stats
            this.relayerStats[relayerAddress].totalTxSent++;
            this.relayerStats[relayerAddress].totalTxFailed++;
            this.relayerStats[relayerAddress].lastError = error.message || 'Unknown error';
            this.relayerStats[relayerAddress].lastErrorTimestamp = Date.now();
            
            // Increment retry count for this transaction
            this.txQueues[relayerAddress][0].retryCount = retryCount + 1;
            
            // If this is a permanent error, don't retry
            const isPermanentError = 
              error.message.includes('insufficient funds') || 
              error.message.includes('execution reverted: Ownable: caller is not the owner') ||
              error.message.includes('cannot estimate gas') ||
              error.message.includes('invalid address');
            
            if (isPermanentError) {
              console.log(`Permanent error detected, removing transaction from queue`);
              
              // Record permanent failure
              if (this.onTransactionComplete) {
                this.onTransactionComplete({
                  hash: null,
                  walletAddress,
                  pointsToMint,
                  success: false,
                  relayerAddress,
                  relayerIndex: this.relayerStats[relayerAddress].index,
                  error: error.message || 'Transaction failed permanently'
                });
              }
              
              // Remove from queue
              this.txQueues[relayerAddress].shift();
              this.relayerStats[relayerAddress].queueLength = this.txQueues[relayerAddress].length;
            } else {
              // For temporary errors, increment consecutive failures counter
              consecutiveFailures++;
              
              // Wait longer between each retry based on retry count
              const delayMs = Math.min(1000 * Math.pow(2, retryCount), 30000); // Exponential backoff, max 30 seconds
              console.log(`Retrying transaction for ${walletAddress} in ${delayMs/1000} seconds (attempt ${retryCount + 1}/${maxRetries})`);
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }
          }
        } catch (error) {
          console.error(`Queue processing error for relayer ${relayerAddress}:`, error.message);
          
          // Increment retry count
          if (this.txQueues[relayerAddress][0]) {
            const currentRetryCount = this.txQueues[relayerAddress][0].retryCount || 0;
            this.txQueues[relayerAddress][0].retryCount = currentRetryCount + 1;
          }
          
          consecutiveFailures++;
          await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds before trying next transaction
        }
      }
    } catch (error) {
      console.error(`Fatal error in queue processing for relayer ${relayerAddress}:`, error);
    } finally {
      this.processingFlags[relayerAddress] = false;
      this.relayerStats[relayerAddress].queueLength = this.txQueues[relayerAddress].length;
      
      // If there are still items in the queue, restart processing after a delay
      if (this.txQueues[relayerAddress].length > 0) {
        setTimeout(() => this.processQueue(relayer), 1000);
      }
    }
  }

  /**
   * Manually start processing all relayer queues
   */
  startProcessingAllQueues() {
    this.relayers.forEach(relayer => {
      if (!this.processingFlags[relayer.address] && this.txQueues[relayer.address].length > 0) {
        this.processQueue(relayer);
      }
    });
  }

  /**
   * Update relayer activity status
   * @param {string} relayerAddress The address of the relayer
   * @param {boolean} isActive New active status
   */
  setRelayerStatus(relayerAddress, isActive) {
    if (this.relayerStats[relayerAddress]) {
      this.relayerStats[relayerAddress].isActive = isActive;
      console.log(`Set relayer ${relayerAddress} status to ${isActive ? 'active' : 'inactive'}`);
      return true;
    }
    return false;
  }

  /**
   * Get the current state of all transaction queues
   */
  getQueueStatus() {
    const queueStatus = {};
    let totalPending = 0;
    
    for (const relayerAddress in this.txQueues) {
      queueStatus[relayerAddress] = {
        queueLength: this.txQueues[relayerAddress].length,
        isProcessing: this.processingFlags[relayerAddress],
        oldestTransaction: this.txQueues[relayerAddress].length > 0 
          ? this.txQueues[relayerAddress][0].timestamp 
          : null
      };
      totalPending += this.txQueues[relayerAddress].length;
    }
    
    return {
      totalPendingTransactions: totalPending,
      relayerQueues: queueStatus
    };
  }
}

// Export a singleton instance
const relayerSystem = new RelayerSystem();
module.exports = relayerSystem; 