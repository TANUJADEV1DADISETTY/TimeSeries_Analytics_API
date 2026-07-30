import { v4 as uuidv4 } from 'uuid';
import { redisClient } from './config.js';

/**
 * Sliding window rate limiting middleware using Redis sorted sets (ZSET).
 * Limits requests to 200 requests per rolling 60 seconds per IP.
 */
export async function rateLimiter(req, res, next) {
  // Use Express ip, fallback to headers or socket address
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown-ip';
  const key = `rate_limit:${ip}`;

  const now = Date.now();
  const windowStart = now - 60000; // 1 minute ago

  try {
    const multi = redisClient.multi();

    // 1. Remove old requests
    multi.zremrangebyscore(key, 0, windowStart);

    // 2. Add current request
    const requestId = `${now}-${uuidv4()}`;
    multi.zadd(key, now, requestId);

    // 3. Count requests in the current window
    multi.zcard(key);

    // 4. Set TTL to automatically clean up inactive IPs
    multi.expire(key, 60);

    const results = await multi.exec();

    if (!results || results.length < 3) {
      throw new Error('Redis pipeline execution failed');
    }

    // Results in ioredis format: [[err, val], [err, val], ...]
    const zcardResult = results[2];
    if (zcardResult[0]) {
      throw zcardResult[0];
    }

    const requestCount = zcardResult[1];

    if (requestCount > 200) {
      return res.status(429).json({ error: 'Too Many Requests' });
    }

    next();
  } catch (err) {
    console.error('Rate limiting middleware error:', err);
    // Fallback/fail-open in case Redis is down/fails, allowing traffic
    next();
  }
}
