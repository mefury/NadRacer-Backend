const { ethers } = require('ethers');
const logger = require('../config/logger');
const config = require('../config/config');

class GasOptimizer {
  constructor() {
    this.provider = null;
    this.tokenContract = null;
    this.wallet = null;
    this.isRunning = false;
    this.lastUpdate = null;
    this.optimizedGasLimits = {
      mintTokens: BigInt(100000),    // Default values as BigInt
      rewardPlayer: BigInt(80000),
      quickReward: BigInt(60000)
    };
    this.updateInterval = 5 * 60 * 1000; // 5 minutes
  }

  async initialize(provider, tokenContract, wallet) {
    this.provider = provider;
    this.tokenContract = tokenContract;
    this.wallet = wallet;
    this.isRunning = true;
    
    // Start the optimization loop
    this.startOptimizationLoop();
    
    logger.info('Gas optimizer initialized', {
      wallet: this.wallet.address,
      contract: this.tokenContract.target
    });
  }

  async startOptimizationLoop() {
    while (this.isRunning) {
      try {
        await this.updateGasOptimizations();
        await new Promise(resolve => setTimeout(resolve, this.updateInterval));
      } catch (error) {
        logger.error('Error in gas optimization loop:', {
          error: error.message,
          stack: error.stack
        });
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
  }

  async updateGasOptimizations() {
    try {
      logger.info('Updating gas optimizations...');

      // Get current gas price
      const feeData = await this.provider.getFeeData();
      const currentGasPrice = feeData.gasPrice || BigInt(0);

      // Create a test wallet for estimations
      const testWallet = ethers.Wallet.createRandom();
      const testAmount = ethers.parseUnits('1', 18);

      // Test and update gas limits for each method
      const gasEstimates = await this.estimateGasLimits(testWallet.address, testAmount);

      // Update optimized gas limits with some buffer (20%)
      this.optimizedGasLimits = {
        mintTokens: gasEstimates.mintTokens ? 
          (gasEstimates.mintTokens * BigInt(120) / BigInt(100)) : 
          BigInt(config.gas.limits.mintTokens),
        rewardPlayer: gasEstimates.rewardPlayer ? 
          (gasEstimates.rewardPlayer * BigInt(120) / BigInt(100)) : 
          BigInt(config.gas.limits.rewardPlayer),
        quickReward: gasEstimates.quickReward ? 
          (gasEstimates.quickReward * BigInt(120) / BigInt(100)) : 
          BigInt(config.gas.limits.quickReward)
      };

      this.lastUpdate = Date.now();

      logger.info('Gas optimizations updated', {
        gasPrice: ethers.formatUnits(currentGasPrice, 'gwei') + ' gwei',
        optimizedLimits: {
          mintTokens: this.optimizedGasLimits.mintTokens.toString(),
          rewardPlayer: this.optimizedGasLimits.rewardPlayer.toString(),
          quickReward: this.optimizedGasLimits.quickReward.toString()
        },
        timestamp: new Date().toISOString()
      });

      return {
        mintTokens: this.optimizedGasLimits.mintTokens.toString(),
        rewardPlayer: this.optimizedGasLimits.rewardPlayer.toString(),
        quickReward: this.optimizedGasLimits.quickReward.toString()
      };
    } catch (error) {
      logger.error('Failed to update gas optimizations:', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  async estimateGasLimits(testAddress, amount) {
    const estimates = {
      mintTokens: BigInt(0),
      rewardPlayer: BigInt(0),
      quickReward: BigInt(0)
    };

    try {
      // Estimate mintTokens gas
      estimates.mintTokens = await this.tokenContract.mintTokens.estimateGas(
        testAddress,
        amount
      );
    } catch (error) {
      logger.warn('Failed to estimate mintTokens gas:', { error });
      estimates.mintTokens = BigInt(config.gas.limits.mintTokens);
    }

    try {
      // Estimate rewardPlayer gas
      estimates.rewardPlayer = await this.tokenContract.rewardPlayer.estimateGas(
        testAddress,
        amount
      );
    } catch (error) {
      logger.warn('Failed to estimate rewardPlayer gas:', { error });
      estimates.rewardPlayer = BigInt(config.gas.limits.rewardPlayer);
    }

    try {
      // Check if quickReward exists and estimate its gas
      if (this.tokenContract.quickReward) {
        estimates.quickReward = await this.tokenContract.quickReward.estimateGas(
          testAddress,
          amount
        );
      }
    } catch (error) {
      logger.warn('Failed to estimate quickReward gas:', { error });
      estimates.quickReward = BigInt(config.gas.limits.quickReward);
    }

    return estimates;
  }

  getOptimizedGasLimit(method) {
    const limit = this.optimizedGasLimits[method];
    return limit ? limit.toString() : null;
  }

  getLastUpdate() {
    return this.lastUpdate;
  }

  stop() {
    this.isRunning = false;
    logger.info('Gas optimizer stopped');
  }
}

module.exports = new GasOptimizer(); 