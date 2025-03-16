/**
 * Relayer System for NadRacer
 * 
 * This module implements a transaction relayer system that uses multiple wallets
 * to process transactions in parallel for improved throughput and reliability.
 * Updated to use treasury wallet transfers instead of direct minting.
 */

const { ethers } = require('ethers');
require('dotenv').config();

// Import token ABI
const TokenABI = require('./TokenABI.json');

// Add this after other imports and constants
const TX_DELAY_MS = 100; // Delay between transactions to prevent rate limiting

// Add this helper function for waiting
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class RelayerSystem {
  constructor() {
    this.provider = null;
    this.relayers = [];
    this.relayerStats = {};
    this.tokenContract = null;
    this.tokenAddress = process.env.TOKEN_CONTRACT_ADDRESS;
    this.treasuryWallet = null;
    this.treasuryAddress = process.env.TREASURY_ADDRESS;
    this.ownerWallet = null;
    this.maxRelayers = parseInt(process.env.NUM_RELAYERS || 20);
    this.isInitialized = false;
    this.txQueues = {}; // One queue per relayer
    this.processingFlags = {}; // Track which relayer queues are being processed
    this.onTransactionComplete = null; // Store the transaction complete callback
    this.approvalAmount = ethers.parseUnits('1000000', 18); // Default large approval amount
  }

  /**
   * Initialize the relayer system
   * @returns {Promise<boolean>} True if initialization successful
   */
  async initialize(provider) {
    try {
      this.provider = provider;
      console.log(`Initializing relayer system with ${this.maxRelayers} relayers`);
      
      // Check if relayer system is enabled
      const enableRelayerSystem = process.env.ENABLE_RELAYER_SYSTEM === 'true';
      console.log(`Relayer system enabled: ${enableRelayerSystem}`);
      
      // Log gas priority settings
      const priority = (process.env.GAS_PRIORITY || 'medium').toLowerCase();
      console.log(`Relayer gas priority set to: ${priority.toUpperCase()} EIP-1559 fee model`);
      console.log(`Gas fee strategy:
  * SLOW: 120% base fee, standard priority fee (minimum 60 gwei / 2 gwei)
  * MEDIUM: 150% base fee, 150% priority fee (minimum 90 gwei / 3 gwei)
  * FAST: 250% base fee, 200% priority fee (minimum 120 gwei / 4 gwei)
  * SAFETY: If network fee data is unavailable, defaults to 50 gwei base fee and 1.5 gwei priority fee
  * Current mode: ${priority.toUpperCase()}`);
      
      // Initialize owner wallet for paying gas fees
      if (process.env.OWNER_PRIVATE_KEY) {
        this.ownerWallet = new ethers.Wallet(process.env.OWNER_PRIVATE_KEY, this.provider);
        console.log(`Owner wallet initialized: ${this.ownerWallet.address}`);
      } else if (process.env.PRIVATE_KEY) {
        // Fallback to PRIVATE_KEY if OWNER_PRIVATE_KEY is not set
        console.log('Using PRIVATE_KEY as owner wallet (legacy configuration)');
        this.ownerWallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);
        console.log(`Owner wallet initialized: ${this.ownerWallet.address}`);
      } else {
        console.error('Neither OWNER_PRIVATE_KEY nor PRIVATE_KEY configured');
        return false;
      }
      
      // Initialize treasury wallet that holds tokens
      if (process.env.TREASURY_PRIVATE_KEY) {
        this.treasuryWallet = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY, this.provider);
        console.log(`Treasury wallet initialized: ${this.treasuryWallet.address}`);
      } else {
        console.error('TREASURY_PRIVATE_KEY not configured');
        return false;
      }
      
      // Initialize token contract
      if (this.tokenAddress) {
        this.tokenContract = new ethers.Contract(this.tokenAddress, TokenABI, this.ownerWallet);
        console.log(`Token contract initialized at ${this.tokenAddress}`);
      } else {
        console.error('TOKEN_CONTRACT_ADDRESS not configured');
        return false;
      }
      
      if (enableRelayerSystem) {
        // Load relayer wallets from environment variables - prioritize this method
        console.log('Loading relayer wallets from environment variables');
        await this.initializeRelayersFromEnv();
        
        // If no relayers were loaded from env vars, try the JSON file as fallback
        if (this.relayers.length === 0) {
          console.log('No relayers loaded from environment variables, trying JSON file as fallback');
          try {
            const fs = require('fs');
            const path = require('path');
            const relayersPath = path.join(__dirname, 'important files/relayer-wallets.json');
            
            if (fs.existsSync(relayersPath)) {
              // Load relayers from JSON file
              const relayerWallets = JSON.parse(fs.readFileSync(relayersPath, 'utf8'));
              console.log(`Found ${relayerWallets.numWallets} relayer wallets in JSON file`);
              
              // Limit to maxRelayers if more are provided
              const numToUse = Math.min(relayerWallets.numWallets, this.maxRelayers);
              console.log(`Using ${numToUse} relayer wallets`);
              
              // Initialize wallets from file
              for (let i = 0; i < numToUse; i++) {
                const walletInfo = relayerWallets.wallets[i];
                const wallet = new ethers.Wallet(walletInfo.privateKey, this.provider);
                
                if (wallet.address.toLowerCase() !== walletInfo.address.toLowerCase()) {
                  console.warn(`Warning: Address mismatch for relayer ${i}. JSON: ${walletInfo.address}, Derived: ${wallet.address}`);
                }
                
                // Add to relayers array
                this.relayers.push(wallet);
                
                // Initialize stats for this relayer
                this.relayerStats[wallet.address] = {
                  index: i,
                  address: wallet.address,
                  currentNonce: await this.provider.getTransactionCount(wallet.address),
                  queueLength: 0,
                  totalTxSent: 0,
                  totalTxSuccess: 0,
                  totalTxFailed: 0,
                  tokensTransferred: 0,
                  lastSuccessTimestamp: 0,
                  lastErrorTimestamp: 0,
                  lastSuccessHash: null,
                  lastError: null,
                  active: true
                };
                
                // Initialize empty transaction queue for this relayer
                this.txQueues[wallet.address] = [];
                
                // Initialize processing flag for this relayer
                this.processingFlags[wallet.address] = false;
              }
              
              console.log(`Initialized ${this.relayers.length} relayer wallets from JSON file`);
            } else {
              console.error('No valid relayers could be initialized, and JSON fallback file not found.');
              console.log('As a final fallback, using owner wallet as the only relayer');
              // Use owner wallet as a last resort
              this.setupOwnerAsRelayer();
            }
          } catch (fileError) {
            console.error('Error loading relayer wallets from JSON file:', fileError);
            console.log('As a final fallback, using owner wallet as the only relayer');
            // Use owner wallet as a last resort
            this.setupOwnerAsRelayer();
          }
        }
        
        // Ensure token approvals for all relayers
        await this.ensureTokenApproval();
      } else {
        console.log('Multi-wallet relayer system disabled. Using only owner wallet for transactions.');
        // Use owner wallet as the only relayer
        this.setupOwnerAsRelayer();
        
        // Ensure owner has approval to spend treasury tokens
        await this.ensureOwnerApproval();
      }
      
      this.isInitialized = true;
      console.log('Relayer system initialized successfully');
      return true;
    } catch (error) {
      console.error('Failed to initialize relayer system:', error);
      return false;
    }
  }

  /**
   * Initialize relayers from environment variables
   */
  async initializeRelayersFromEnv() {
    console.log('Initializing relayers from environment variables');
    
    const privateKeys = [];
    
    // Populate relayer private keys from environment variables
    for (let i = 1; i <= this.maxRelayers; i++) {
      const key = process.env[`RELAYER_PRIVATE_KEY_${i}`];
      if (key) {
        privateKeys.push(key);
      }
    }
    
    console.log(`Found ${privateKeys.length} relayer private keys in environment variables`);
    
    if (privateKeys.length === 0) {
      console.log('No relayer private keys found in environment variables');
      return false;
    }
    
    // Clear existing relayers
    this.relayers = [];
    
    // Set up all relayers from private keys
    for (let i = 0; i < privateKeys.length; i++) {
      try {
        const wallet = new ethers.Wallet(privateKeys[i], this.provider);
        this.relayers.push(wallet);
        
        // Initialize stats for this relayer
        const nonce = await this.provider.getTransactionCount(wallet.address);
        this.relayerStats[wallet.address] = {
          index: i,
          address: wallet.address,
          active: true,
          currentNonce: nonce,
          totalTxSent: 0,
          totalTxSuccess: 0,
          totalTxFailed: 0,
          lastError: null,
          lastErrorTimestamp: null,
          lastSuccessTimestamp: null,
          lastSuccessHash: null,
          tokensTransferred: 0,
          queueLength: 0
        };
        
        // Initialize queue for this relayer
        this.txQueues[wallet.address] = [];
        this.processingFlags[wallet.address] = false;
        
        console.log(`Relayer ${i} initialized with address ${wallet.address}, nonce ${nonce}`);
      } catch (error) {
        console.error(`Failed to initialize relayer ${i}:`, error.message);
      }
    }
    
    console.log(`Initialized ${this.relayers.length} relayer wallets from environment variables`);
    return this.relayers.length > 0;
  }

  /**
   * Set up owner wallet as the only relayer (fallback)
   */
  async setupOwnerAsRelayer() {
    this.relayers = [this.ownerWallet];
    
    // Initialize stats for the owner wallet acting as relayer
    this.relayerStats[this.ownerWallet.address] = {
      index: 0,
      address: this.ownerWallet.address,
      active: true,
      currentNonce: await this.provider.getTransactionCount(this.ownerWallet.address),
      totalTxSent: 0,
      totalTxSuccess: 0,
      totalTxFailed: 0,
      lastError: null,
      lastErrorTimestamp: null,
      lastSuccessTimestamp: null,
      lastSuccessHash: null,
      tokensTransferred: 0,
      queueLength: 0
    };
    
    // Initialize queue for the owner wallet
    this.txQueues[this.ownerWallet.address] = [];
    this.processingFlags[this.ownerWallet.address] = false;
    
    console.log('Owner wallet set up as the only relayer');
  }

  /**
   * Ensure owner has approval to spend treasury tokens
   */
  async ensureOwnerApproval() {
    try {
      const currentAllowance = await this.tokenContract.allowance(
        this.treasuryWallet.address, 
        this.ownerWallet.address
      );
      
      console.log(`Owner wallet allowance: ${ethers.formatUnits(currentAllowance, 18)} tokens`);
      
      if (currentAllowance < ethers.parseUnits('100000', 18)) {
        const approvalAmount = ethers.parseUnits('1000000', 18);
        console.log(`Setting approval for owner wallet to spend ${ethers.formatUnits(approvalAmount, 18)} tokens from treasury`);
        
        // Get fee data for approval
        const approvalFeeData = await this.provider.getFeeData();
        
        // Calculate gas fees based on priority
        const approvalFees = this.calculateGasFeesByPriority(approvalFeeData);
        
        // Set new approval using the treasury wallet
        const tokenWithTreasurySigner = this.tokenContract.connect(this.treasuryWallet);
        const approvalTx = await tokenWithTreasurySigner.approve(
          this.ownerWallet.address,
          approvalAmount,
          // Set EIP-1559 fee parameters
          { 
            maxFeePerGas: approvalFees.maxFeePerGas,
            maxPriorityFeePerGas: approvalFees.maxPriorityFeePerGas
          }
        );
        
        await approvalTx.wait();
        console.log(`Approval transaction completed for owner wallet: ${approvalTx.hash}`);
      }
      
      return true;
    } catch (error) {
      console.error(`Failed to set owner approval: ${error.message}`);
      return false;
    }
  }

  /**
   * Ensure each relayer has permission to transfer from treasury
   * @returns {Promise<boolean>} True if approvals are successfully set
   */
  async ensureTokenApproval() {
    try {
      console.log(`Checking/setting approval for relayers to transfer tokens from treasury...`);
      
      // First ensure all relayers have necessary approvals
      for (const relayer of this.relayers) {
        const relayerAllowance = await this.tokenContract.allowance(
          this.treasuryWallet.address,
          relayer.address
        );
        
        console.log(`Relayer ${relayer.address} allowance: ${ethers.formatUnits(relayerAllowance, 18)} tokens`);
        
        // Using native BigInt comparison for v6
        if (relayerAllowance < ethers.parseUnits('100000', 18)) {
          const approvalAmount = ethers.parseUnits('1000000', 18);
          console.log(`Setting approval for relayer ${relayer.address} to spend ${ethers.formatUnits(approvalAmount, 18)} tokens from treasury`);
          
          // Get fee data for approval
          const approvalFeeData = await this.provider.getFeeData();
          
          // Calculate gas fees based on priority
          const approvalFees = this.calculateGasFeesByPriority(approvalFeeData);
          
          // Set new approval using the treasury wallet
          const tokenWithTreasurySigner = this.tokenContract.connect(this.treasuryWallet);
          const approvalTx = await tokenWithTreasurySigner.approve(
            relayer.address,
            approvalAmount,
            // Set EIP-1559 fee parameters
            { 
              maxFeePerGas: approvalFees.maxFeePerGas,
              maxPriorityFeePerGas: approvalFees.maxPriorityFeePerGas
            }
          );
          
          await approvalTx.wait();
          console.log(`Approval transaction completed for relayer ${relayer.address}: ${approvalTx.hash}`);
          
          // Add delay after approval to prevent rate limiting
          await delay(TX_DELAY_MS * 2);
        }
      }
      
      return true;
    } catch (error) {
      console.error(`Failed to set token approvals: ${error.message}`);
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
      activeRelayers: this.relayers.filter(r => this.relayerStats[r.address].active).length,
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
      // Always get the latest nonce from the blockchain
      const nonce = await this.provider.getTransactionCount(relayer.address, "pending");
      this.relayerStats[relayer.address].currentNonce = nonce;
      
      console.log(`Refreshed nonce for relayer ${relayerIndex} (${relayer.address}): ${nonce} (using pending state)`);
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
      this.relayerStats[r.address] && this.relayerStats[r.address].active
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
   * Set a callback function to be called when a transaction is completed
   * @param {Function} callback The callback function
   */
  setTransactionCompleteCallback(callback) {
    if (typeof callback !== 'function') {
      console.error('Invalid transaction complete callback - must be a function');
      return false;
    }
    
    this.onTransactionComplete = callback;
    console.log('Transaction complete callback set');
    return true;
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
        // First, always refresh the nonce before processing the next transaction
        try {
          // Get fresh nonce directly from the network
          const currentNonce = await this.provider.getTransactionCount(relayerAddress, "pending");
          console.log(`Current blockchain nonce for ${relayerAddress}: ${currentNonce} (pending state)`);
          this.relayerStats[relayerAddress].currentNonce = currentNonce;
        } catch (error) {
          console.error(`Error refreshing nonce for ${relayerAddress}:`, error.message);
          // Continue with existing nonce if refresh fails
        }
        
        // Too many consecutive failures, pause processing
        if (consecutiveFailures >= 3) {
          console.log(`Too many consecutive failures for relayer ${relayerAddress}, pausing queue processing for cooldown`);
          await new Promise(resolve => setTimeout(resolve, 15000)); // 15 second cooldown
          
          // Refresh nonce before continuing
          try {
            const nonce = await this.provider.getTransactionCount(relayerAddress, "latest");
            this.relayerStats[relayerAddress].currentNonce = nonce;
            console.log(`After cooldown, refreshed nonce for ${relayerAddress}: ${nonce} (latest state)`);
          } catch (nonceError) {
            console.error(`Failed to refresh nonce after cooldown:`, nonceError);
          }
          
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
          
          // Remove from queue
          this.txQueues[relayerAddress].shift();
          stats.queueLength = this.txQueues[relayerAddress].length;
          continue;
        }
        
        // Process the transaction
        try {
          // Add a small delay before starting to prevent rate limiting
          await delay(TX_DELAY_MS);
          
          // Prepare transaction data
          const playerWalletAddress = txData.walletAddress;
          const pointsToMint = txData.pointsToMint;
          const tokenAmount = ethers.parseUnits(pointsToMint.toString(), 18);
          
          console.log(`Relayer ${relayerAddress} processing transferFrom of ${pointsToMint} tokens from treasury to ${playerWalletAddress} - attempt #${retryCount + 1}`);
          
          // Check treasury balance first
          const treasuryBalance = await this.tokenContract.balanceOf(this.treasuryWallet.address);
          
          if (treasuryBalance < tokenAmount) {
            throw new Error(`Insufficient treasury balance. Have ${ethers.formatUnits(treasuryBalance, 18)}, need ${ethers.formatUnits(tokenAmount, 18)}`);
          }
          
          // Find the relayer object that matches this relayerAddress
          const relayerWallet = this.relayers.find(r => r.address === relayerAddress);
          if (!relayerWallet) {
            throw new Error(`Could not find relayer wallet for address ${relayerAddress}`);
          }
          
          // Get current fee data
          const feeData = await this.provider.getFeeData();
          
          // Calculate gas fees based on priority
          const fees = this.calculateGasFeesByPriority(feeData);
          
          // Using .target in v6 or .address in v5, check what's available
          const contractAddress = this.tokenContract.target || this.tokenContract.address;
          console.log(`Contract address: ${contractAddress}`);
          console.log(`Using method: transferFrom with ${process.env.GAS_PRIORITY || 'medium'} priority`);
          console.log(`Relayer ${relayerAddress} executing the transaction (not owner wallet)`);
          
          // Create a contract instance connected to the relayer's wallet
          const tokenWithRelayer = this.tokenContract.connect(relayerWallet);
          
          // Execute transaction with the relayer's wallet (this wallet will pay gas)
          const tx = await tokenWithRelayer.transferFrom(
            this.treasuryWallet.address,
            playerWalletAddress,
            tokenAmount,
            // Set EIP-1559 fee parameters with nonce to avoid conflicts
            { 
              maxFeePerGas: fees.maxFeePerGas,
              maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
              nonce: this.relayerStats[relayerAddress].currentNonce
            }
          );
          
          // Increment the stored nonce for next transaction
          this.relayerStats[relayerAddress].currentNonce++;
          
          // Wait for transaction confirmation with timeout
          console.log(`Waiting for transaction ${tx.hash} to be confirmed...`);
          const receipt = await Promise.race([
            tx.wait(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Transaction confirmation timeout')), 60000))
          ]);
          
          // Transaction successful - update stats for relayer
          stats.totalTxSent++;
          stats.totalTxSuccess++;
          stats.lastSuccessTimestamp = Date.now();
          stats.lastSuccessHash = receipt.hash;
          stats.tokensTransferred += Number(pointsToMint);
          
          console.log(`✅ Transfer successful: ${receipt.hash} for ${playerWalletAddress} (${pointsToMint} tokens)`);
          
          // Add to transaction history
          if (this.onTransactionComplete) {
            this.onTransactionComplete({
              hash: receipt.hash,
              walletAddress: playerWalletAddress,
              pointsToMint,
              success: true,
              relayerAddress,
              relayerIndex: stats.index,
              gasUsed: receipt.gasUsed?.toString() || '0'
            });
          }
          
          // Remove from queue and continue processing
          this.txQueues[relayerAddress].shift();
          stats.queueLength = this.txQueues[relayerAddress].length;
          consecutiveFailures = 0;
          
          // Add a delay after successful transaction to prevent rate limiting
          await delay(TX_DELAY_MS);
        } catch (error) {
          console.error(`❌ Transaction error for relayer ${relayerAddress}:`, error.message);
          
          // For nonce errors, always refresh the nonce
          if (error.message.includes('nonce') || error.message.includes('already been used')) {
            try {
              // Force nonce refresh using latest state
              const latestNonce = await this.provider.getTransactionCount(relayerAddress, "latest");
              stats.currentNonce = latestNonce;
              console.log(`After nonce error, refreshed nonce for ${relayerAddress}: ${latestNonce} (latest state)`);
            } catch (nonceRefreshError) {
              console.error(`Failed to refresh nonce after error:`, nonceRefreshError);
            }
          }
          
          // Track failure stats
          stats.totalTxSent++;
          stats.totalTxFailed++;
          stats.lastError = error.message || 'Unknown error';
          stats.lastErrorTimestamp = Date.now();
          
          // Increment retry count for this transaction
          this.txQueues[relayerAddress][0].retryCount = retryCount + 1;
          
          // If this is a permanent error, don't retry
          const isPermanentError = 
            error.message.includes('insufficient funds') || 
            error.message.includes('execution reverted') ||
            error.message.includes('cannot estimate gas') ||
            error.message.includes('invalid address');
          
          if (isPermanentError) {
            console.log(`Permanent error detected, removing transaction from queue`);
            
            // Record permanent failure
            if (this.onTransactionComplete) {
              this.onTransactionComplete({
                hash: null,
                walletAddress: txData.walletAddress,
                pointsToMint: txData.pointsToMint,
                success: false,
                relayerAddress,
                relayerIndex: stats.index,
                error: error.message || 'Unknown error'
              });
            }
            
            // Remove from queue
            this.txQueues[relayerAddress].shift();
            stats.queueLength = this.txQueues[relayerAddress].length;
          } else {
            // Backoff for temporary errors
            consecutiveFailures++;
            console.log(`Temporary error, consecutive failures: ${consecutiveFailures}`);
            
            // Add a delay before retrying to avoid rate limiting
            const backoffTime = Math.min(2000 * Math.pow(2, retryCount), 30000); // Exponential backoff with cap
            console.log(`Backing off for ${backoffTime}ms before retry`);
            await delay(backoffTime);
          }
        }
      }
    } catch (error) {
      console.error(`Error in queue processing for relayer ${relayerAddress}:`, error);
    } finally {
      // Mark queue as no longer processing
      this.processingFlags[relayerAddress] = false;
      
      // If there are still items in the queue, schedule processing again
      if (this.txQueues[relayerAddress].length > 0) {
        console.log(`Still ${this.txQueues[relayerAddress].length} transactions in queue for relayer ${relayerAddress}, continuing processing`);
        setTimeout(() => {
          this.processQueue(relayer);
        }, 100);
      }
    }
  }

  /**
   * Calculate gas price based on priority setting from environment variable
   * @param {BigInt} baseGasPrice The base gas price from network
   * @returns {BigInt} The calculated gas price based on priority
   */
  calculateGasPriceByPriority(baseGasPrice) {
    // Get priority from environment variable (default to medium)
    const priority = (process.env.GAS_PRIORITY || 'medium').toLowerCase();
    
    // Calculate gas price based on priority
    switch (priority) {
      case 'slow':
        // 50% of base gas price
        const slowPrice = baseGasPrice * BigInt(50) / BigInt(100);
        console.log(`Using slow priority gas price: ${ethers.formatUnits(slowPrice, 'gwei')} gwei (50% of base)`);
        return slowPrice;
        
      case 'fast':
        // 110% of base gas price
        const fastPrice = baseGasPrice * BigInt(110) / BigInt(100);
        console.log(`Using fast priority gas price: ${ethers.formatUnits(fastPrice, 'gwei')} gwei (110% of base)`);
        return fastPrice;
        
      case 'medium':
      default:
        // 75% of base gas price
        const mediumPrice = baseGasPrice * BigInt(75) / BigInt(100);
        console.log(`Using medium priority gas price: ${ethers.formatUnits(mediumPrice, 'gwei')} gwei (75% of base)`);
        return mediumPrice;
    }
  }

  /**
   * Calculate gas fees based on priority setting from environment variable
   * @param {Object} feeData The fee data from provider.getFeeData()
   * @returns {Object} The calculated gas fees based on priority
   */
  calculateGasFeesByPriority(feeData) {
    // Get priority from environment variable (default to medium)
    const priority = (process.env.GAS_PRIORITY || 'medium').toLowerCase();
    
    // Get the base fee from the network or use defaults compatible with ethers v6
    const baseFeePerGas = feeData.maxFeePerGas || ethers.parseUnits('50', 'gwei'); // 50 gwei default
    const priorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits('1.5', 'gwei'); // 1.5 gwei default
    
    // Minimum values to ensure transactions get included (for Monad network)
    const MIN_MAX_FEE_PER_GAS = ethers.parseUnits('60', 'gwei'); // 60 gwei
    const MIN_PRIORITY_FEE_PER_GAS = ethers.parseUnits('2', 'gwei'); // 2 gwei
    
    // Calculate fee parameters based on priority
    switch (priority) {
      case 'slow':
        // Slow: lower multipliers but still enough to get included
        let slowMaxFeePerGas = baseFeePerGas * BigInt(120) / BigInt(100); // 120% of base fee
        let slowPriorityFee = priorityFeePerGas;
        
        // Apply minimums
        if (slowMaxFeePerGas < MIN_MAX_FEE_PER_GAS) {
          slowMaxFeePerGas = MIN_MAX_FEE_PER_GAS;
        }
        if (slowPriorityFee < MIN_PRIORITY_FEE_PER_GAS) {
          slowPriorityFee = MIN_PRIORITY_FEE_PER_GAS;
        }
        
        console.log(`Using SLOW priority: maxFeePerGas=${ethers.formatUnits(slowMaxFeePerGas, 'gwei')} gwei, maxPriorityFeePerGas=${ethers.formatUnits(slowPriorityFee, 'gwei')} gwei`);
        return {
          maxFeePerGas: slowMaxFeePerGas,
          maxPriorityFeePerGas: slowPriorityFee
        };
        
      case 'fast':
        // Fast: higher multipliers for quick inclusion
        let fastMaxFeePerGas = baseFeePerGas * BigInt(250) / BigInt(100); // 250% of base fee
        let fastPriorityFee = priorityFeePerGas * BigInt(200) / BigInt(100); // Double the priority fee
        
        // Apply minimums
        if (fastMaxFeePerGas < MIN_MAX_FEE_PER_GAS * BigInt(2)) {
          fastMaxFeePerGas = MIN_MAX_FEE_PER_GAS * BigInt(2);
        }
        if (fastPriorityFee < MIN_PRIORITY_FEE_PER_GAS * BigInt(2)) {
          fastPriorityFee = MIN_PRIORITY_FEE_PER_GAS * BigInt(2);
        }
        
        console.log(`Using FAST priority: maxFeePerGas=${ethers.formatUnits(fastMaxFeePerGas, 'gwei')} gwei, maxPriorityFeePerGas=${ethers.formatUnits(fastPriorityFee, 'gwei')} gwei`);
        return {
          maxFeePerGas: fastMaxFeePerGas,
          maxPriorityFeePerGas: fastPriorityFee
        };
        
      case 'medium':
      default:
        // Medium: balanced multipliers
        let mediumMaxFeePerGas = baseFeePerGas * BigInt(150) / BigInt(100); // 150% of base fee
        let mediumPriorityFee = priorityFeePerGas * BigInt(150) / BigInt(100); // 150% of priority fee
        
        // Apply minimums
        if (mediumMaxFeePerGas < MIN_MAX_FEE_PER_GAS * BigInt(150) / BigInt(100)) {
          mediumMaxFeePerGas = MIN_MAX_FEE_PER_GAS * BigInt(150) / BigInt(100);
        }
        if (mediumPriorityFee < MIN_PRIORITY_FEE_PER_GAS * BigInt(150) / BigInt(100)) {
          mediumPriorityFee = MIN_PRIORITY_FEE_PER_GAS * BigInt(150) / BigInt(100);
        }
        
        console.log(`Using MEDIUM priority: maxFeePerGas=${ethers.formatUnits(mediumMaxFeePerGas, 'gwei')} gwei, maxPriorityFeePerGas=${ethers.formatUnits(mediumPriorityFee, 'gwei')} gwei`);
        return {
          maxFeePerGas: mediumMaxFeePerGas,
          maxPriorityFeePerGas: mediumPriorityFee
        };
    }
  }
}

// Export an instance of the relayer system, not the class
const relayerSystem = new RelayerSystem();
module.exports = relayerSystem;