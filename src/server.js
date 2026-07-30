import app from './app.js';
import { config, closeConnections } from './config.js';
import { initDatabase } from './db.js';
import { startScheduler, stopScheduler } from './workers.js';

async function startServer() {
  console.log('Starting Timeseries Analytics API service...');

  try {
    // 1. Initialize Postgres Schema and Indexes
    await initDatabase();

    // 2. Start Express app
    const server = app.listen(config.port, () => {
      console.log(`Server listening on port ${config.port} (env: ${config.nodeEnv})`);
    });

    // 3. Start Background Schedulers
    startScheduler();

    // 4. Graceful Shutdown handlers
    async function gracefulShutdown(signal) {
      console.log(`\nReceived ${signal}. Starting graceful shutdown...`);
      
      // Stop background schedules
      stopScheduler();

      // Close Express server
      server.close(() => {
        console.log('HTTP server closed.');
      });

      // Close pg pool and redis client
      await closeConnections();
      console.log('Database and Redis client connections closed cleanly.');
      
      process.exit(0);
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (err) {
    console.error('Server failed to start:', err);
    await closeConnections();
    process.exit(1);
  }
}

startServer();
