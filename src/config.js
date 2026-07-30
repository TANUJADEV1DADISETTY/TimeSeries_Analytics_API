import dotenv from 'dotenv';
import pg from 'pg';
import Redis from 'ioredis';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '8000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'analytics_user',
    password: process.env.DB_PASSWORD || 'password',
    database: process.env.DB_NAME || 'analytics_db',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  }
};

// Create PostgreSQL Connection Pool
export const dbPool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Create Redis Client
export const redisClient = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
});

// Shutdown helper for clean test teardowns
export async function closeConnections() {
  try {
    await dbPool.end();
  } catch (err) {
    console.error('Error closing Postgres pool:', err);
  }
  try {
    await redisClient.quit();
  } catch (err) {
    console.error('Error closing Redis client:', err);
  }
}
export default config;
