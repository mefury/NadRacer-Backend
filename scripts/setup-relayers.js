const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

/**
 * Generate relayer wallets and update configuration
 */
async function generateRelayerWallets() {
  const numRelayers = parseInt(process.env.NUM_RELAYERS || '20', 10);
  const wallets = [];
  const envContent = [];
  
  console.log(`Generating ${numRelayers} relayer wallets...`);
  
  // Read existing .env file if it exists
  let existingEnv = '';
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    existingEnv = fs.readFileSync(envPath, 'utf8');
  }
  
  // Keep existing non-relayer configuration
  const existingLines = existingEnv.split('\n');
  for (const line of existingLines) {
    if (!line.startsWith('RELAYER_WALLET_')) {
      envContent.push(line);
    }
  }
  
  // Generate new wallets
  for (let i = 0; i < numRelayers; i++) {
    const wallet = ethers.Wallet.createRandom();
    wallets.push({
      index: i,
      address: wallet.address,
      privateKey: wallet.privateKey
    });
    envContent.push(`RELAYER_WALLET_${i}=${wallet.privateKey}`);
  }
  
  // Save updated .env file
  fs.writeFileSync(envPath, envContent.join('\n'));
  
  // Save wallet info to a separate file (for backup)
  const walletInfo = {
    timestamp: new Date().toISOString(),
    numRelayers,
    wallets: wallets.map(w => ({
      index: w.index,
      address: w.address,
      privateKey: w.privateKey
    }))
  };
  
  const backupPath = path.join(__dirname, '..', 'important files', 'relayer-wallets.json');
  fs.writeFileSync(backupPath, JSON.stringify(walletInfo, null, 2));
  
  console.log('✅ Relayer wallets generated successfully!');
  console.log(`📝 Configuration saved to: ${envPath}`);
  console.log(`💾 Backup saved to: ${backupPath}`);
  console.log('\nRelayer Addresses:');
  wallets.forEach(w => {
    console.log(`Relayer ${w.index}: ${w.address}`);
  });
  
  console.log('\n⚠️ IMPORTANT: Make sure to fund these relayer wallets before using them!');
  console.log('You can use the fund-relayer-wallets.js script to fund them.');
}

// Run the script
generateRelayerWallets().catch(console.error); 