const mongoose = require('mongoose');

const leaderboardSchema = new mongoose.Schema({
  walletAddress: { type: String, required: true, unique: true, lowercase: true },
  username: { type: String, required: true },
  highestScore: { type: Number, default: 0 },
  totalGames: { type: Number, default: 0 },
  lastGameDate: { type: Date },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Leaderboard', leaderboardSchema);