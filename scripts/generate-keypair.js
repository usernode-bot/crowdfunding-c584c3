#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function generateRandomHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes; i++) {
    hex += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  }
  return hex;
}

function generateKeypair() {
  // Generate a signing public key in Usernode format: utpk1 followed by hex chars
  // NOTE: This is a cryptographic public key for signing, NOT a wallet address!
  // Wallet addresses start with "ut1", not "utpk1".
  const pubkey = 'utpk1' + generateRandomHex(27);

  // Generate a secret key: 32 bytes (64 hex chars) for the signing key
  const secretKey = generateRandomHex(32);

  return { pubkey, secretKey };
}

function writeEnv(pubkey, secretKey) {
  const envPath = path.join(__dirname, '..', '.env');
  let envContent = '';

  // Read existing .env if it exists
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf-8');
  }

  // Update or add APP_PUBKEY
  if (envContent.includes('APP_PUBKEY=')) {
    envContent = envContent.replace(/^APP_PUBKEY=.*/m, `APP_PUBKEY=${pubkey}`);
  } else {
    envContent += `\nAPP_PUBKEY=${pubkey}`;
  }

  // Update or add APP_SECRET_KEY
  if (envContent.includes('APP_SECRET_KEY=')) {
    envContent = envContent.replace(/^APP_SECRET_KEY=.*/m, `APP_SECRET_KEY=${secretKey}`);
  } else {
    envContent += `\nAPP_SECRET_KEY=${secretKey}`;
  }

  // Also add SENDER_APP_PUBKEY and SENDER_APP_SECRET_KEY for backwards compatibility
  if (!envContent.includes('SENDER_APP_PUBKEY=')) {
    envContent += `\nSENDER_APP_PUBKEY=${pubkey}`;
  }

  if (!envContent.includes('SENDER_APP_SECRET_KEY=')) {
    envContent += `\nSENDER_APP_SECRET_KEY=${secretKey}`;
  }

  fs.writeFileSync(envPath, envContent.trim() + '\n');
  return envPath;
}

// Check if --env flag is passed
const args = process.argv.slice(2);
const writeToEnv = args.includes('--env');

const { pubkey, secretKey } = generateKeypair();

console.log('Generated keypair:');
console.log('─'.repeat(70));
console.log(`Public Key (for signing):   ${pubkey}`);
console.log(`⚠️  This is a cryptographic key, NOT a wallet address!`);
console.log(`Secret Key (for signing):   ${secretKey}`);
console.log('─'.repeat(70));

if (writeToEnv) {
  const envPath = writeEnv(pubkey, secretKey);
  console.log(`\n✓ Keypair written to ${envPath}`);
  console.log('\nNext steps:');
  console.log('1. Obtain or import a WALLET ADDRESS (starting with "ut1") for APP_PUBKEY');
  console.log('   - Do NOT use the public key above (it starts with "utpk1")');
  console.log('   - A wallet address is different from a signing public key');
  console.log('   - See platform docs for how to obtain a wallet address');
  console.log('2. Set APP_PUBKEY and SENDER_APP_PUBKEY to the wallet address in Secrets UI');
  console.log('3. Set SENDER_APP_SECRET_KEY to the secret key above in the platform Secrets UI');
  console.log('4. These signing keys are now available in your .env for local development');
} else {
  console.log('\nUsage:');
  console.log('  node scripts/generate-keypair.js --env    Write to .env file');
  console.log('  node scripts/generate-keypair.js          Display keys only');
  console.log('\nℹ️  To use this keypair:');
  console.log('   - The public key above is for signing transactions (utpk1...)');
  console.log('   - APP_PUBKEY requires a wallet address (ut1...), not a signing public key');
  console.log('   - See platform docs for obtaining a wallet address');
}
