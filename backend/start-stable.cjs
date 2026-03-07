// Stable startup script without nodemon
const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting Iceflower FLO Backend (Stable Mode)...');

// Start the backend
const backend = spawn('node', ['src/index.js'], {
  stdio: 'inherit',
  cwd: path.resolve(__dirname),
  env: { ...process.env }
});

backend.on('error', (error) => {
  console.error('❌ Backend failed to start:', error);
  process.exit(1);
});

backend.on('close', (code) => {
  console.log(`📊 Backend exited with code ${code}`);
  process.exit(code);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  backend.kill('SIGINT');
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down gracefully...');
  backend.kill('SIGTERM');
});
