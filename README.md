# NadRacer Backend

Backend service for the Nad Racer game, a cosmic racing game built on the Monad blockchain.

## Overview

This backend service handles:
- Player registration and authentication
- Token minting and transactions
- Leaderboard management
- Game state persistence

## Technologies Used

- Node.js
- Express.js
- MongoDB (via Mongoose)
- Ethers.js for Monad blockchain integration

## Setup Instructions

1. Clone the repository:
   ```
   git clone https://github.com/mefury/NadRacer-Backend.git
   cd NadRacer-Backend
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create a `.env` file based on the example below:
   ```
   PORT=3001
   MONGO_URI=your_mongodb_connection_string
   MONAD_RPC_URL=https://testnet-rpc.monad.xyz
   TOKEN_CONTRACT_ADDRESS=your_token_contract_address
   NUM_RELAYERS=20
   PRIVATE_KEY=your_contract_owner_private_key
   # Add relayer wallet private keys as needed
   RELAYER_WALLET_0=private_key_1
   RELAYER_WALLET_1=private_key_2
   # etc.
   ```

4. Start the server:
   ```
   npm start
   ```

## API Endpoints

- `POST /api/register` - Register a new player
- `GET /api/player/:walletAddress` - Get player data
- `POST /api/mint` - Mint tokens
- `POST /api/score` - Save a player's score
- `GET /api/leaderboard` - Get the global leaderboard

## Relayer System

The backend uses a multi-wallet relayer system to handle high transaction volumes efficiently. It queues and processes token minting operations using multiple wallets to avoid transaction bottlenecks.

## License

© 2024 MEFURY 