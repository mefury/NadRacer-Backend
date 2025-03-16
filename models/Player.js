const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  walletAddress: { type: String, required: true, unique: true, lowercase: true },
  username: { type: String, required: true, unique: true },
  totalPoints: { type: Number, default: 0 },
  highestScore: { type: Number, default: 0 },
  gamesPlayed: { type: Number, default: 0 },
  lastPlayed: { type: Date },
  tokensTx: { type: Number, default: 0 }, // Total tokens transferred
  registeredAt: { type: Date, default: Date.now },
  lastLogin: { type: Date },
  banned: { type: Boolean, default: false }
});

module.exports = mongoose.model('Player', playerSchema);