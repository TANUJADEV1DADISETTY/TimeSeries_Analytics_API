import { dbPool } from './config.js';

/**
 * Initializes the PostgreSQL schema and indexes if they do not exist.
 */
export async function initDatabase() {
  const schemaQuery = `
    CREATE TABLE IF NOT EXISTS raw_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type VARCHAR(50) NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      metadata JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_raw_events_timestamp ON raw_events (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_raw_events_type ON raw_events (event_type);

    CREATE TABLE IF NOT EXISTS hourly_stats (
      id SERIAL PRIMARY KEY,
      bucket_time TIMESTAMPTZ NOT NULL,
      event_type VARCHAR(50) NOT NULL,
      event_count INTEGER NOT NULL,
      CONSTRAINT uq_hourly_stats UNIQUE (bucket_time, event_type)
    );

    CREATE TABLE IF NOT EXISTS daily_stats (
      id SERIAL PRIMARY KEY,
      bucket_date TIMESTAMPTZ NOT NULL,
      event_type VARCHAR(50) NOT NULL,
      event_count INTEGER NOT NULL,
      CONSTRAINT uq_daily_stats UNIQUE (bucket_date, event_type)
    );
  `;

  try {
    await dbPool.query(schemaQuery);
    console.log('Database schema initialized successfully.');
  } catch (err) {
    console.error('Failed to initialize database schema:', err);
    throw err;
  }
}

/**
 * Inserts a single raw event.
 */
export async function insertRawEvent(eventType, timestamp, metadata = {}) {
  const query = `
    INSERT INTO raw_events (event_type, timestamp, metadata)
    VALUES ($1, $2, $3)
    RETURNING id, event_type, timestamp, metadata;
  `;
  const res = await dbPool.query(query, [
    eventType,
    timestamp,
    JSON.stringify(metadata),
  ]);
  return res.rows[0];
}

/**
 * Queries completed hours from hourly_stats.
 */
export async function queryHourlyStats(startDate, endDate, eventType) {
  let query = `
    SELECT bucket_time AS bucket, event_type, event_count AS count
    FROM hourly_stats
    WHERE bucket_time >= $1 AND bucket_time <= $2
  `;
  const params = [startDate, endDate];
  if (eventType) {
    query += ' AND event_type = $3';
    params.push(eventType);
  }
  query += ' ORDER BY bucket_time ASC, event_type ASC';

  const res = await dbPool.query(query, params);
  return res.rows.map(r => ({
    bucket: r.bucket.toISOString(),
    event_type: r.event_type,
    count: parseInt(r.count, 10),
  }));
}

/**
 * Queries completed days from daily_stats.
 */
export async function queryDailyStats(startDate, endDate, eventType) {
  let query = `
    SELECT bucket_date AS bucket, event_type, event_count AS count
    FROM daily_stats
    WHERE bucket_date >= $1 AND bucket_date <= $2
  `;
  const params = [startDate, endDate];
  if (eventType) {
    query += ' AND event_type = $3';
    params.push(eventType);
  }
  query += ' ORDER BY bucket_date ASC, event_type ASC';

  const res = await dbPool.query(query, params);
  return res.rows.map(r => ({
    bucket: r.bucket.toISOString(),
    event_type: r.event_type,
    count: parseInt(r.count, 10),
  }));
}

/**
 * Aggregates raw events by hour on the fly (for ongoing hours).
 */
export async function queryRawEventsAggregatedByHour(startDate, endDate, eventType) {
  let query = `
    SELECT date_trunc('hour', timestamp) AS bucket, event_type, COUNT(*) AS count
    FROM raw_events
    WHERE timestamp >= $1 AND timestamp <= $2
  `;
  const params = [startDate, endDate];
  if (eventType) {
    query += ' AND event_type = $3';
    params.push(eventType);
  }
  query += `
    GROUP BY 1, 2
    ORDER BY bucket ASC, event_type ASC
  `;

  const res = await dbPool.query(query, params);
  return res.rows.map(r => ({
    bucket: r.bucket.toISOString(),
    event_type: r.event_type,
    count: parseInt(r.count, 10),
  }));
}

/**
 * Aggregates raw events by day on the fly (for ongoing days).
 */
export async function queryRawEventsAggregatedByDay(startDate, endDate, eventType) {
  let query = `
    SELECT date_trunc('day', timestamp) AS bucket, event_type, COUNT(*) AS count
    FROM raw_events
    WHERE timestamp >= $1 AND timestamp <= $2
  `;
  const params = [startDate, endDate];
  if (eventType) {
    query += ' AND event_type = $3';
    params.push(eventType);
  }
  query += `
    GROUP BY 1, 2
    ORDER BY bucket ASC, event_type ASC
  `;

  const res = await dbPool.query(query, params);
  return res.rows.map(r => ({
    bucket: r.bucket.toISOString(),
    event_type: r.event_type,
    count: parseInt(r.count, 10),
  }));
}

/**
 * Retrieves event counts in the last 24 hours, grouped by event_type.
 */
export async function queryDashboardSummary(last24HoursStart) {
  const query = `
    SELECT event_type, COUNT(*) AS count
    FROM raw_events
    WHERE timestamp >= $1
    GROUP BY event_type
    ORDER BY event_type ASC
  `;
  const res = await dbPool.query(query, [last24HoursStart]);
  return res.rows.map(r => ({
    event_type: r.event_type,
    last_24h_count: parseInt(r.count, 10),
  }));
}
