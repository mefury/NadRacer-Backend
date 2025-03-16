const mongoose = require('mongoose');

const gameStatsSchema = new mongoose.Schema({
  totalGamesPlayed: { type: Number, default: 0 },
  totalPointsCollected: { type: Number, default: 0 },
  totalTokensTransferred: { type: Number, default: 0 },
  totalUniqueWallets: { type: Number, default: 0 },
  totalSessionTime: { type: Number, default: 0 }, // In seconds
  dailyStats: {
    date: { type: Date, default: Date.now },
    gamesPlayed: { type: Number, default: 0 },
    pointsCollected: { type: Number, default: 0 },
    tokensTransferred: { type: Number, default: 0 },
    uniqueWallets: { type: Number, default: 0 },
    sessionTime: { type: Number, default: 0 } // In seconds
  },
  weeklyStats: [{
    week: { type: String },
    gamesPlayed: { type: Number, default: 0 },
    pointsCollected: { type: Number, default: 0 },
    tokensTransferred: { type: Number, default: 0 },
    uniqueWallets: { type: Number, default: 0 },
    sessionTime: { type: Number, default: 0 } // In seconds
  }],
  lastUpdated: { type: Date, default: Date.now }
});

// Index for quick access to the most recent stats
gameStatsSchema.index({ lastUpdated: -1 });

// Create or update daily stats
gameStatsSchema.statics.updateDailyStats = async function(statsData) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const stats = await this.findOne() || new this();
  
  // Update total stats
  if (statsData.gamesPlayed) stats.totalGamesPlayed += statsData.gamesPlayed;
  if (statsData.pointsCollected) stats.totalPointsCollected += statsData.pointsCollected;
  if (statsData.tokensTransferred) stats.totalTokensTransferred += statsData.tokensTransferred;
  if (statsData.uniqueWallets) stats.totalUniqueWallets = statsData.uniqueWallets;
  if (statsData.sessionTime) stats.totalSessionTime += statsData.sessionTime;
  
  // Update daily stats
  if (stats.dailyStats.date.toDateString() !== today.toDateString()) {
    // Reset daily stats for a new day
    stats.dailyStats = {
      date: today,
      gamesPlayed: 0,
      pointsCollected: 0,
      tokensTransferred: 0,
      uniqueWallets: 0,
      sessionTime: 0
    };
  }
  
  // Update daily stats
  if (statsData.gamesPlayed) stats.dailyStats.gamesPlayed += statsData.gamesPlayed;
  if (statsData.pointsCollected) stats.dailyStats.pointsCollected += statsData.pointsCollected;
  if (statsData.tokensTransferred) stats.dailyStats.tokensTransferred += statsData.tokensTransferred;
  if (statsData.uniqueWallets) stats.dailyStats.uniqueWallets = statsData.uniqueWallets;
  if (statsData.sessionTime) stats.dailyStats.sessionTime += statsData.sessionTime;
  
  stats.lastUpdated = new Date();
  return await stats.save();
};

module.exports = mongoose.model('GameStats', gameStatsSchema); 