const requiredEnvVars = [
  'NODE_ENV',
  'PORT',
  'MONGO_URI',
  'MONAD_RPC_URL',
  'TOKEN_CONTRACT_ADDRESS',
  'PRIVATE_KEY',
  'NUM_RELAYERS',
  'LOG_LEVEL',
  'GAS_UPDATE_INTERVAL',
  'GAS_BUFFER_PERCENT',
  'GAS_LIMIT_TRANSFER',
  'MAX_GAS_PRICE',
  'MIN_GAS_PRICE',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX'
];

function validateEnv() {
  const missing = requiredEnvVars.filter(env => !process.env[env]);
  if (missing.length) {
    console.error('Missing required environment variables:', missing);
    process.exit(1);
  }

  // Validate numeric values
  const numericVars = [
    'PORT',
    'NUM_RELAYERS',
    'GAS_UPDATE_INTERVAL',
    'GAS_BUFFER_PERCENT',
    'GAS_LIMIT_TRANSFER',
    'MAX_GAS_PRICE',
    'MIN_GAS_PRICE',
    'RATE_LIMIT_WINDOW_MS',
    'RATE_LIMIT_MAX'
  ];

  numericVars.forEach(varName => {
    const value = Number(process.env[varName]);
    if (isNaN(value)) {
      console.error(`Environment variable ${varName} must be a number`);
      process.exit(1);
    }
  });

  // Validate addresses
  const addressVars = ['TOKEN_CONTRACT_ADDRESS'];
  const addressRegex = /^0x[a-fA-F0-9]{40}$/;
  
  addressVars.forEach(varName => {
    if (!addressRegex.test(process.env[varName])) {
      console.error(`Environment variable ${varName} must be a valid Ethereum address`);
      process.exit(1);
    }
  });

  // Validate private keys
  if (!process.env.PRIVATE_KEY.startsWith('0x')) {
    console.error('PRIVATE_KEY must start with 0x');
    process.exit(1);
  }

  console.log('✅ Environment variables validated successfully');
}

module.exports = validateEnv; 