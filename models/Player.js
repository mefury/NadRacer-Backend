const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  walletAddress: { type: String, required: true, unique: true, lowercase: true },
  username: { type: String, required: true, unique: true }, // Added username
  totalPoints: { type: Number, default: 0 },
  highestScore: { type: Number, default: 0 },
  gamesPlayed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Player', playerSchema);