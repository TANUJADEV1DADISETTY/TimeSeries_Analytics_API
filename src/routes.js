import express from 'express';
import { rateLimiter } from './rateLimiter.js';
import { redisClient } from './config.js';
import {
  insertRawEvent,
  queryHourlyStats,
  queryDailyStats,
  queryRawEventsAggregatedByHour,
  queryRawEventsAggregatedByDay,
  queryDashboardSummary,
} from './db.js';
import {
  runHourlyAggregation,
  runDailyAggregation,
  runDataRetention,
} from './workers.js';

const router = express.Router();

/**
 * Validates ISO 8601 Date format.
 */
function isValidISO8601(str) {
  if (typeof str !== 'string') return false;
  // Flexible regex to match YYYY-MM-DDTHH:mm:ss.sssZ or similar offsets
  const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
  if (!isoRegex.test(str)) return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

/**
 * POST /events
 * Ingests a new telemetry/user event.
 */
router.post('/events', rateLimiter, async (req, res) => {
  const { event_type, timestamp, metadata } = req.body;

  // Validate event_type
  if (!event_type || typeof event_type !== 'string' || event_type.trim() === '') {
    return res.status(400).json({ error: 'event_type is required and must be a non-empty string' });
  }

  // Validate timestamp if provided
  let eventTimestamp;
  if (timestamp !== undefined) {
    if (!isValidISO8601(timestamp)) {
      return res.status(400).json({ error: 'timestamp must be a valid ISO 8601 string' });
    }
    eventTimestamp = new Date(timestamp);
  } else {
    eventTimestamp = new Date(); // default to current UTC server time
  }

  // Validate metadata
  let eventMetadata = metadata;
  if (metadata !== undefined) {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      return res.status(400).json({ error: 'metadata must be a JSON object' });
    }
  } else {
    eventMetadata = {};
  }

  try {
    const createdEvent = await insertRawEvent(event_type, eventTimestamp, eventMetadata);
    return res.status(201).json({
      status: 'created',
      event: {
        id: createdEvent.id,
        event_type: createdEvent.event_type,
        timestamp: createdEvent.timestamp.toISOString(),
        metadata: createdEvent.metadata,
      },
    });
  } catch (err) {
    console.error('Error inserting raw event:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * GET /analytics
 * Returns aggregated stats for the specified time range.
 */
router.get('/analytics', async (req, res) => {
  const { start_date, end_date, interval, event_type } = req.query;

  // Validate inputs
  if (!start_date || !end_date || !interval) {
    return res.status(400).json({ error: 'start_date, end_date, and interval query parameters are required' });
  }

  if (!isValidISO8601(start_date) || !isValidISO8601(end_date)) {
    return res.status(400).json({ error: 'start_date and end_date must be valid ISO 8601 strings' });
  }

  if (interval !== 'hour' && interval !== 'day') {
    return res.status(400).json({ error: "interval must be either 'hour' or 'day'" });
  }

  try {
    const start = new Date(start_date);
    const end = new Date(end_date);
    const now = new Date();

    if (start > end) {
      return res.status(400).json({ error: 'start_date cannot be after end_date' });
    }

    let results = [];

    if (interval === 'hour') {
      // Current hour start in UTC
      const currentHourStart = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
        0, 0, 0
      ));

      if (start >= currentHourStart) {
        // Query active raw events only
        results = await queryRawEventsAggregatedByHour(start, end, event_type);
      } else if (end < currentHourStart) {
        // Query historical stats only
        results = await queryHourlyStats(start, end, event_type);
      } else {
        // Query both and merge
        const historicalEnd = new Date(currentHourStart.getTime() - 1);
        const [historicalData, activeData] = await Promise.all([
          queryHourlyStats(start, historicalEnd, event_type),
          queryRawEventsAggregatedByHour(currentHourStart, end, event_type),
        ]);

        results = [...historicalData, ...activeData];
      }
    } else {
      // interval === 'day'
      // Current day start in UTC
      const currentDayStart = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0, 0, 0, 0
      ));

      if (start >= currentDayStart) {
        // Query active raw events only (aggregated by day)
        results = await queryRawEventsAggregatedByDay(start, end, event_type);
      } else if (end < currentDayStart) {
        // Query historical daily stats only
        results = await queryDailyStats(start, end, event_type);
      } else {
        // Query both and merge
        const historicalEnd = new Date(currentDayStart.getTime() - 1);
        const [historicalData, activeData] = await Promise.all([
          queryDailyStats(start, historicalEnd, event_type),
          queryRawEventsAggregatedByDay(currentDayStart, end, event_type),
        ]);

        results = [...historicalData, ...activeData];
      }
    }

    // Sort results by bucket ASC, then by event_type ASC
    results.sort((a, b) => {
      const timeDiff = new Date(a.bucket).getTime() - new Date(b.bucket).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.event_type.localeCompare(b.event_type);
    });

    return res.status(200).json(results);
  } catch (err) {
    console.error('Error fetching analytics:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * GET /dashboard/summary
 * Returns last 24h event counts broken down by event_type.
 * Uses 60-second Redis cache.
 */
router.get('/dashboard/summary', async (req, res) => {
  const cacheKey = 'cache:dashboard:summary';

  try {
    // 1. Check Redis Cache
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(JSON.parse(cachedData));
    }

    // 2. Cache Miss - Query Postgres
    const last24HoursStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const metrics = await queryDashboardSummary(last24HoursStart);
    const responseBody = { metrics };

    // 3. Write to Redis with 60s TTL
    await redisClient.set(cacheKey, JSON.stringify(responseBody), 'EX', 60);

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(responseBody);
  } catch (err) {
    console.error('Error fetching dashboard summary:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * POST /jobs/rollup/hourly
 * Admin/Test route to trigger hourly rollup aggregation on demand.
 */
router.post('/jobs/rollup/hourly', async (req, res) => {
  try {
    const rows = await runHourlyAggregation();
    return res.status(200).json({ status: 'success', rows_processed: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /jobs/rollup/daily
 * Admin/Test route to trigger daily rollup aggregation on demand.
 */
router.post('/jobs/rollup/daily', async (req, res) => {
  try {
    const rows = await runDailyAggregation();
    return res.status(200).json({ status: 'success', rows_processed: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /jobs/retention
 * Admin/Test route to trigger raw events data retention purge on demand.
 */
router.post('/jobs/retention', async (req, res) => {
  try {
    const rows = await runDataRetention();
    return res.status(200).json({ status: 'success', rows_purged: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
