import { dbPool } from './config.js';

/**
 * Worker: Hourly Aggregation
 * Identifies completed UTC hours, queries raw_events, and upserts into hourly_stats.
 */
export async function runHourlyAggregation() {
  console.log('[Worker] Starting Hourly Aggregation Job...');
  const query = `
    INSERT INTO hourly_stats (bucket_time, event_type, event_count)
    SELECT 
      date_trunc('hour', timestamp) AS bucket_time,
      event_type,
      COUNT(*) AS event_count
    FROM raw_events
    WHERE timestamp < date_trunc('hour', NOW() AT TIME ZONE 'UTC')
    GROUP BY 1, 2
    ON CONFLICT (bucket_time, event_type)
    DO UPDATE SET event_count = EXCLUDED.event_count;
  `;
  let client;
  try {
    client = await dbPool.connect();
    await client.query('BEGIN');
    const result = await client.query(query);
    await client.query('COMMIT');
    console.log(`[Worker] Hourly Aggregation complete. Processed rows: ${result.rowCount}`);
    return result.rowCount;
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Hourly rollback failed:', rollbackErr);
      }
    }
    console.error('[Worker] Hourly Aggregation Job failed:', err);
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Worker: Daily Aggregation
 * Identifies completed UTC days, queries hourly_stats, and upserts into daily_stats.
 */
export async function runDailyAggregation() {
  console.log('[Worker] Starting Daily Aggregation Job...');
  const query = `
    INSERT INTO daily_stats (bucket_date, event_type, event_count)
    SELECT 
      date_trunc('day', bucket_time) AS bucket_date,
      event_type,
      SUM(event_count) AS event_count
    FROM hourly_stats
    WHERE bucket_time < date_trunc('day', NOW() AT TIME ZONE 'UTC')
    GROUP BY 1, 2
    ON CONFLICT (bucket_date, event_type)
    DO UPDATE SET event_count = EXCLUDED.event_count;
  `;
  let client;
  try {
    client = await dbPool.connect();
    await client.query('BEGIN');
    const result = await client.query(query);
    await client.query('COMMIT');
    console.log(`[Worker] Daily Aggregation complete. Processed rows: ${result.rowCount}`);
    return result.rowCount;
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Daily rollback failed:', rollbackErr);
      }
    }
    console.error('[Worker] Daily Aggregation Job failed:', err);
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Worker: Data Retention (Housekeeping)
 * Purges raw events older than 30 days.
 */
export async function runDataRetention() {
  console.log('[Worker] Starting Data Retention (Purge) Job...');
  const query = `
    DELETE FROM raw_events
    WHERE timestamp < NOW() - INTERVAL '30 days';
  `;
  try {
    const result = await dbPool.query(query);
    console.log(`[Worker] Data Retention complete. Purged raw event rows: ${result.rowCount}`);
    return result.rowCount;
  } catch (err) {
    console.error('[Worker] Data Retention Job failed:', err);
    throw err;
  }
}

// Track active intervals to allow clean shutdown in tests
const activeIntervals = [];
let startupTimeout = null;

/**
 * Starts the background worker intervals.
 */
export function startScheduler() {
  if (process.env.DISABLE_SCHEDULER === 'true') {
    console.log('[Scheduler] Background jobs scheduler is disabled.');
    return;
  }

  console.log('[Scheduler] Initializing background jobs...');

  // Run hourly aggregation every 5 minutes
  const hourlyInterval = setInterval(async () => {
    try {
      await runHourlyAggregation();
    } catch (err) {
      // already logged in function
    }
  }, 5 * 60 * 1000);
  activeIntervals.push(hourlyInterval);

  // Run daily aggregation every 1 hour
  const dailyInterval = setInterval(async () => {
    try {
      await runDailyAggregation();
    } catch (err) {
      // already logged in function
    }
  }, 60 * 60 * 1000);
  activeIntervals.push(dailyInterval);

  // Run data retention once every 12 hours
  const retentionInterval = setInterval(async () => {
    try {
      await runDataRetention();
    } catch (err) {
      // already logged in function
    }
  }, 12 * 60 * 60 * 1000);
  activeIntervals.push(retentionInterval);

  // Also run workers once on startup after database initializes
  startupTimeout = setTimeout(async () => {
    try {
      await runHourlyAggregation();
      await runDailyAggregation();
      await runDataRetention();
    } catch (err) {
      console.error('[Scheduler] Initial startup run failed:', err);
    }
  }, 5000);
}

/**
 * Stops all scheduled interval jobs (for clean teardowns during testing).
 */
export function stopScheduler() {
  console.log('[Scheduler] Stopping scheduled background jobs...');
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  while (activeIntervals.length > 0) {
    clearInterval(activeIntervals.pop());
  }
}
