import request from 'supertest';
import app from '../src/app.js';
import { dbPool, redisClient, closeConnections } from '../src/config.js';
import { initDatabase } from '../src/db.js';

beforeAll(async () => {
  process.env.DISABLE_SCHEDULER = 'true'; // Disable background intervals in tests
  await initDatabase();
});

beforeEach(async () => {
  await dbPool.query('TRUNCATE raw_events, hourly_stats, daily_stats RESTART IDENTITY');
  await redisClient.flushall();
});

afterAll(async () => {
  await closeConnections();
});

describe('POST /events - Ingest Events & Rate Limiting', () => {
  test('should successfully ingest a valid event and return 201', async () => {
    const res = await request(app)
      .post('/events')
      .send({
        event_type: 'pageview',
        timestamp: '2026-07-22T08:00:00Z',
        metadata: { url: '/home', user_id: '123' },
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('created');
    expect(res.body.event).toBeDefined();
    expect(res.body.event.event_type).toBe('pageview');
    expect(res.body.event.timestamp).toBe('2026-07-22T08:00:00.000Z');
    expect(res.body.event.metadata).toEqual({ url: '/home', user_id: '123' });

    // Verify DB insertion
    const dbRes = await dbPool.query('SELECT * FROM raw_events');
    expect(dbRes.rows.length).toBe(1);
    expect(dbRes.rows[0].event_type).toBe('pageview');
  });

  test('should default to current server time if timestamp is missing', async () => {
    const res = await request(app)
      .post('/events')
      .send({
        event_type: 'click',
      });

    expect(res.status).toBe(201);
    expect(res.body.event.timestamp).toBeDefined();
    const date = new Date(res.body.event.timestamp);
    expect(isNaN(date.getTime())).toBe(false);
  });

  test('should return 400 Bad Request if event_type is missing', async () => {
    const res = await request(app)
      .post('/events')
      .send({
        timestamp: '2026-07-22T08:00:00Z',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('event_type is required');
  });

  test('should return 400 Bad Request if timestamp is invalid ISO 8601', async () => {
    const res = await request(app)
      .post('/events')
      .send({
        event_type: 'purchase',
        timestamp: 'invalid-date-format',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('timestamp must be a valid ISO 8601 string');
  });

  test('should trigger sliding-window rate limit after 200 requests', async () => {
    // Send 200 requests successfully from the same IP (default supertest IP)
    const promises = [];
    for (let i = 0; i < 200; i++) {
      promises.push(
        request(app)
          .post('/events')
          .send({ event_type: 'test_rate_limit' })
      );
    }
    const responses = await Promise.all(promises);
    responses.forEach(res => {
      expect(res.status).toBe(201);
    });

    // The 201st request must be rate limited (429)
    const rateLimitedRes = await request(app)
      .post('/events')
      .send({ event_type: 'test_rate_limit' });

    expect(rateLimitedRes.status).toBe(429);
    expect(rateLimitedRes.body.error).toBe('Too Many Requests');
  });
});

describe('GET /dashboard/summary - Dashboard Summary & Caching', () => {
  test('should query Postgres on cache miss, then serve from Redis on cache hit', async () => {
    // Insert some events in the last 24h
    await request(app).post('/events').send({ event_type: 'pageview' });
    await request(app).post('/events').send({ event_type: 'pageview' });
    await request(app).post('/events').send({ event_type: 'signup' });

    // First call: Cache Miss
    const res1 = await request(app).get('/dashboard/summary');
    expect(res1.status).toBe(200);
    expect(res1.headers['x-cache']).toBe('MISS');
    expect(res1.body.metrics).toEqual([
      { event_type: 'pageview', last_24h_count: 2 },
      { event_type: 'signup', last_24h_count: 1 },
    ]);

    // Insert another event (won't be visible in cached response)
    await request(app).post('/events').send({ event_type: 'signup' });

    // Second call: Cache Hit
    const res2 = await request(app).get('/dashboard/summary');
    expect(res2.status).toBe(200);
    expect(res2.headers['x-cache']).toBe('HIT');
    expect(res2.body.metrics).toEqual([
      { event_type: 'pageview', last_24h_count: 2 },
      { event_type: 'signup', last_24h_count: 1 },
    ]);
  });
});

describe('GET /analytics - Query Routing', () => {
  beforeEach(async () => {
    // Setup some historical and current hour data
    // Let's assume current hour is:
    const now = new Date();
    const currentHourStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      0, 0, 0
    ));

    // Historical hour: 2 hours ago
    const histHour = new Date(currentHourStart.getTime() - 2 * 60 * 60 * 1000);
    // 3 events in raw_events that we will roll up
    await dbPool.query(
      `INSERT INTO raw_events (event_type, timestamp, metadata) VALUES
       ('pageview', $1, '{}'),
       ('pageview', $1, '{}'),
       ('click', $1, '{}')`,
      [histHour]
    );

    // Roll up the completed historical hours
    await request(app).post('/jobs/rollup/hourly');

    // Current ongoing hour: insert 2 events
    await dbPool.query(
      `INSERT INTO raw_events (event_type, timestamp, metadata) VALUES
       ('pageview', $1, '{}'),
       ('click', $1, '{}')`,
      [new Date(currentHourStart.getTime() + 10 * 60 * 1000)] // 10 mins into current hour
    );
  });

  test('should return 400 if required parameters are missing or invalid', async () => {
    const res = await request(app).get('/analytics');
    expect(res.status).toBe(400);

    const res2 = await request(app).get('/analytics?start_date=2026-07-22T00:00:00Z&end_date=2026-07-22T10:00:00Z&interval=invalid');
    expect(res2.status).toBe(400);
  });

  test('should route query to hourly_stats for strictly historical hourly query', async () => {
    const now = new Date();
    const currentHourStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      0, 0, 0
    ));
    const start = new Date(currentHourStart.getTime() - 4 * 60 * 60 * 1000);
    const end = new Date(currentHourStart.getTime() - 1);

    const res = await request(app).get(
      `/analytics?start_date=${start.toISOString()}&end_date=${end.toISOString()}&interval=hour`
    );

    expect(res.status).toBe(200);
    // Should have rolled up data: pageview=2, click=1
    expect(res.body.length).toBe(2);
    expect(res.body[0].event_type).toBe('click');
    expect(res.body[0].count).toBe(1);
    expect(res.body[1].event_type).toBe('pageview');
    expect(res.body[1].count).toBe(2);
  });

  test('should route query to raw_events for strictly ongoing hourly query', async () => {
    const now = new Date();
    const currentHourStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      0, 0, 0
    ));
    const start = currentHourStart;
    const end = new Date(currentHourStart.getTime() + 50 * 60 * 1000);

    const res = await request(app).get(
      `/analytics?start_date=${start.toISOString()}&end_date=${end.toISOString()}&interval=hour`
    );

    expect(res.status).toBe(200);
    // Ongoing data: pageview=1, click=1
    expect(res.body.length).toBe(2);
    expect(res.body[0].event_type).toBe('click');
    expect(res.body[0].count).toBe(1);
    expect(res.body[1].event_type).toBe('pageview');
    expect(res.body[1].count).toBe(1);
  });

  test('should merge results from hourly_stats and raw_events when query spans both', async () => {
    const now = new Date();
    const currentHourStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      0, 0, 0
    ));
    const start = new Date(currentHourStart.getTime() - 4 * 60 * 60 * 1000);
    const end = new Date(currentHourStart.getTime() + 50 * 60 * 1000);

    const res = await request(app).get(
      `/analytics?start_date=${start.toISOString()}&end_date=${end.toISOString()}&interval=hour`
    );

    expect(res.status).toBe(200);
    // Spans both. Returns 4 records (click and pageview from historical hour, and click and pageview from ongoing hour).
    expect(res.body.length).toBe(4);
  });

  test('should filter by event_type if parameter is supplied', async () => {
    const now = new Date();
    const currentHourStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      0, 0, 0
    ));
    const start = new Date(currentHourStart.getTime() - 4 * 60 * 60 * 1000);
    const end = new Date(currentHourStart.getTime() + 50 * 60 * 1000);

    const res = await request(app).get(
      `/analytics?start_date=${start.toISOString()}&end_date=${end.toISOString()}&interval=hour&event_type=pageview`
    );

    expect(res.status).toBe(200);
    // Spans both, but filtered to pageview.
    expect(res.body.length).toBe(2);
    expect(res.body[0].event_type).toBe('pageview');
    expect(res.body[1].event_type).toBe('pageview');
  });

  test('should route query to daily_stats for strictly historical daily query', async () => {
    await dbPool.query('TRUNCATE raw_events, hourly_stats, daily_stats RESTART IDENTITY');
    const now = new Date();
    const currentDayStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0, 0, 0, 0
    ));
    const start = new Date(currentDayStart.getTime() - 4 * 24 * 60 * 60 * 1000);
    const end = new Date(currentDayStart.getTime() - 1);

    // Seed historical day data
    await dbPool.query(
      `INSERT INTO daily_stats (bucket_date, event_type, event_count) VALUES
       ($1, 'pageview', 10),
       ($1, 'click', 5)`,
      [new Date(currentDayStart.getTime() - 2 * 24 * 60 * 60 * 1000)]
    );

    const res = await request(app).get(
      `/analytics?start_date=${start.toISOString()}&end_date=${end.toISOString()}&interval=day`
    );

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    expect(res.body[0].event_type).toBe('click');
    expect(res.body[0].count).toBe(5);
    expect(res.body[1].event_type).toBe('pageview');
    expect(res.body[1].count).toBe(10);
  });

  test('should route query to raw_events for strictly ongoing daily query', async () => {
    await dbPool.query('TRUNCATE raw_events, hourly_stats, daily_stats RESTART IDENTITY');
    const now = new Date();
    const currentDayStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0, 0, 0, 0
    ));
    const start = currentDayStart;
    const end = new Date(currentDayStart.getTime() + 23 * 60 * 60 * 1000);

    // Seed active raw events
    await dbPool.query(
      `INSERT INTO raw_events (event_type, timestamp, metadata) VALUES
       ('pageview', $1, '{}'),
       ('click', $1, '{}')`,
      [new Date(currentDayStart.getTime() + 2 * 60 * 60 * 1000)]
    );

    const res = await request(app).get(
      `/analytics?start_date=${start.toISOString()}&end_date=${end.toISOString()}&interval=day`
    );

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    expect(res.body[0].event_type).toBe('click');
    expect(res.body[0].count).toBe(1);
  });

  test('should merge results from daily_stats and raw_events when daily query spans both', async () => {
    await dbPool.query('TRUNCATE raw_events, hourly_stats, daily_stats RESTART IDENTITY');
    const now = new Date();
    const currentDayStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0, 0, 0, 0
    ));
    const start = new Date(currentDayStart.getTime() - 2 * 24 * 60 * 60 * 1000);
    const end = new Date(currentDayStart.getTime() + 23 * 60 * 60 * 1000);

    // Seed historical daily_stats
    await dbPool.query(
      `INSERT INTO daily_stats (bucket_date, event_type, event_count) VALUES
       ($1, 'pageview', 50)`,
      [new Date(currentDayStart.getTime() - 24 * 60 * 60 * 1000)]
    );

    // Seed active raw events
    await dbPool.query(
      `INSERT INTO raw_events (event_type, timestamp, metadata) VALUES
       ('pageview', $1, '{}')`,
      [new Date(currentDayStart.getTime() + 2 * 60 * 60 * 1000)]
    );

    const res = await request(app).get(
      `/analytics?start_date=${start.toISOString()}&end_date=${end.toISOString()}&interval=day`
    );

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });

  test('should fail if start_date is after end_date', async () => {
    const res = await request(app).get(
      `/analytics?start_date=2026-07-22T10:00:00Z&end_date=2026-07-22T08:00:00Z&interval=hour`
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('start_date cannot be after end_date');
  });

  test('should return 400 Bad Request on invalid metadata for POST /events', async () => {
    const res = await request(app)
      .post('/events')
      .send({
        event_type: 'test_err',
        metadata: 'not-an-object-string'
      });
    expect(res.status).toBe(400);
  });
});

