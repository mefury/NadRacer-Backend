const mongoose = require('mongoose');

const leaderboardSchema = new mongoose.Schema({
  walletAddress: { type: String, required: true, lowercase: true }, // Keep for reference
  username: { type: String, required: true }, // Added for display
  highestScore: { type: Number, required: true },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Leaderboard', leaderboardSchema);