const { ethers } = require('ethers');
const TokenABI = require('../TokenABI.json');

/**
 * GasOptimizer class to estimate optimal gas limits for various token operations
 */
class GasOptimizer {
  constructor(config) {
    // Initialize optimized gas limits with default values
    this.optimizedGasLimits = {
      transfer: BigInt(80000)
    };
    
    // Store configuration
    this.config = config;
    this.provider = null;
    this.tokenContract = null;
    this.isRunning = false;
    this.lastUpdate = null;
    this.updateInterval = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    this.initialized = false;
    
    // Stats tracking
    this.stats = {
      estimationCount: 0,
      lastEstimation: null,
      averageGasUsed: {
        transfer: BigInt(0)
      },
      gasEstimationHistory: {
        transfer: []
      }
    };
    
    // Custom gas limits set manually
    this.customGasLimits = {};
  }
  
  /**
   * Initialize the optimizer with provider and contract
   */
  async initialize(provider, tokenContractAddress) {
    try {
      this.provider = provider;
      this.tokenContract = new ethers.Contract(
        tokenContractAddress,
        TokenABI,
        provider
      );
      
      // Start optimization process
      await this.updateGasOptimizations();
      
      // Set up periodic updates
      this.setupPeriodicUpdates();
      
      this.initialized = true;
      console.log('Gas optimizer initialized successfully');
      return true;
    } catch (error) {
      console.error('Failed to initialize gas optimizer:', error);
      return false;
    }
  }
  
  /**
   * Setup periodic gas optimization updates
   */
  setupPeriodicUpdates() {
    // Clear any existing intervals
    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId);
    }
    
    // Setup new interval
    this.updateIntervalId = setInterval(async () => {
      try {
        await this.updateGasOptimizations();
      } catch (error) {
        console.error('Error during periodic gas optimization update:', error);
      }
    }, this.updateInterval);
    
    console.log(`Gas optimizer will update every ${this.updateInterval / (60 * 60 * 1000)} hours`);
  }
  
  /**
   * Update gas optimizations by estimating gas limits
   */
  async updateGasOptimizations() {
    // Prevent multiple simultaneous runs
    if (this.isRunning) {
      console.log('Gas optimization already running, skipping this request');
      return this.optimizedGasLimits;
    }
    
    this.isRunning = true;
    
    try {
      console.log('Updating gas optimizations...');
      
      // Estimate gas limits for transfer function
      const estimatedLimits = await this.estimateGasLimits();
      
      // Update optimized gas limits with estimations
      this.optimizedGasLimits = {
        ...this.optimizedGasLimits,
        ...estimatedLimits
      };
      
      // Apply any custom gas limits
      for (const [operation, limit] of Object.entries(this.customGasLimits)) {
        this.optimizedGasLimits[operation] = limit;
      }
      
      // Update last update timestamp
      this.lastUpdate = Date.now();
      this.stats.lastEstimation = new Date().toISOString();
      this.stats.estimationCount++;
      
      console.log('Gas optimizations updated successfully:', {
        transfer: this.optimizedGasLimits.transfer.toString()
      });
      
      return this.optimizedGasLimits;
    } catch (error) {
      console.error('Error updating gas optimizations:', error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }
  
  /**
   * Estimate gas limits for token operations
   */
  async estimateGasLimits() {
    if (!this.provider || !this.tokenContract) {
      throw new Error('Gas optimizer not properly initialized');
    }
    
    try {
      // Sample addresses for testing
      const testWallet = ethers.Wallet.createRandom();
      const treasuryAddress = process.env.TREASURY_ADDRESS;
      
      if (!treasuryAddress) {
        throw new Error('Treasury address is not configured');
      }
      
      // Estimate gas for token transfer 
      let transferGasLimit;
      try {
        const tx = await this.tokenContract.transfer.estimateGas(
          testWallet.address,
          ethers.parseUnits('1', 18),
          { from: treasuryAddress }
        );
        
        // Add 20% buffer for safety
        transferGasLimit = BigInt(Math.ceil(Number(tx) * 1.2));
        
        // Update average gas used
        this.updateGasHistory('transfer', tx);
        
        console.log(`Estimated gas for transfer: ${transferGasLimit}`);
      } catch (error) {
        console.warn('Error estimating gas for transfer:', error);
        transferGasLimit = this.optimizedGasLimits.transfer; // Keep existing value
      }
      
      return {
        transfer: transferGasLimit
      };
    } catch (error) {
      console.error('Error estimating gas limits:', error);
      // Return existing values on error
      return {
        transfer: this.optimizedGasLimits.transfer
      };
    }
  }
  
  /**
   * Get the optimized gas limit for a specific operation
   */
  getOptimizedGasLimit(operation) {
    // For legacy compatibility
    if (operation === 'GAS_LIMIT_TRANSFER' || operation === 'transfer') {
      return this.optimizedGasLimits.transfer;
    }
    
    // Fallback to default if not found
    return this.optimizedGasLimits[operation] || BigInt(80000);
  }
  
  /**
   * Get all optimized gas limits
   */
  getOptimizedGasLimits() {
    return { ...this.optimizedGasLimits };
  }
  
  /**
   * Get last update timestamp
   */
  getLastUpdate() {
    return this.lastUpdate;
  }
  
  /**
   * Update the gas history for a specific operation
   */
  updateGasHistory(operation, gasUsed) {
    // Initialize history array if it doesn't exist
    if (!this.stats.gasEstimationHistory[operation]) {
      this.stats.gasEstimationHistory[operation] = [];
    }
    
    // Add to history (keep up to 10 entries)
    this.stats.gasEstimationHistory[operation].push({
      timestamp: new Date().toISOString(),
      gasUsed: gasUsed.toString()
    });
    
    // Trim history to last 10 entries
    if (this.stats.gasEstimationHistory[operation].length > 10) {
      this.stats.gasEstimationHistory[operation].shift();
    }
    
    // Calculate new average
    const sum = this.stats.gasEstimationHistory[operation].reduce(
      (acc, entry) => acc + BigInt(entry.gasUsed), 
      BigInt(0)
    );
    
    const count = this.stats.gasEstimationHistory[operation].length;
    this.stats.averageGasUsed[operation] = count > 0 ? 
      sum / BigInt(count) : 
      BigInt(0);
  }
  
  /**
   * Reset the provider connection
   */
  resetProvider(newProvider, tokenContractAddress) {
    this.provider = newProvider;
    this.tokenContract = new ethers.Contract(
      tokenContractAddress,
      TokenABI,
      newProvider
    );
    console.log('Gas optimizer provider and contract reset');
  }
  
  /**
   * Get statistics about gas estimations
   */
  getStats() {
    return { ...this.stats };
  }
  
  /**
   * Set a custom gas limit for an operation
   */
  setCustomGasLimit(operation, limit) {
    if (!operation || !limit || typeof limit !== 'bigint') {
      return false;
    }
    
    // Store custom limit
    this.customGasLimits[operation] = limit;
    
    // Apply to optimized limits
    this.optimizedGasLimits[operation] = limit;
    
    console.log(`Custom gas limit set for ${operation}: ${limit.toString()}`);
    return true;
  }
}

module.exports = GasOptimizer; 