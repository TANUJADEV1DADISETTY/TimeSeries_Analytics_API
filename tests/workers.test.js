import { dbPool, redisClient, closeConnections } from '../src/config.js';
import { initDatabase } from '../src/db.js';
import {
  runHourlyAggregation,
  runDailyAggregation,
  runDataRetention,
  startScheduler,
  stopScheduler,
} from '../src/workers.js';

beforeAll(async () => {
  process.env.DISABLE_SCHEDULER = 'true';
  await initDatabase();
});

beforeEach(async () => {
  await dbPool.query('TRUNCATE raw_events, hourly_stats, daily_stats RESTART IDENTITY');
  await redisClient.flushall();
});

afterAll(async () => {
  await closeConnections();
});

describe('Hourly Aggregation Worker', () => {
  test('should aggregate completed hours and be idempotent', async () => {
    const now = new Date();
    // Use an hour that is completed (e.g. 2 hours ago)
    const testHour = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours() - 2,
      0, 0, 0
    ));

    // Insert raw events into the completed hour
    await dbPool.query(
      `INSERT INTO raw_events (event_type, timestamp, metadata) VALUES
       ('pageview', $1, '{}'),
       ('pageview', $1, '{}'),
       ('signup', $1, '{}')`,
      [testHour]
    );

    // Also insert raw event in the ongoing hour (should NOT be aggregated by the worker)
    const currentHour = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      0, 0, 0
    ));
    await dbPool.query(
      "INSERT INTO raw_events (event_type, timestamp, metadata) VALUES ('pageview', $1, '{}')",
      [new Date(currentHour.getTime() + 5 * 60 * 1000)]
    );

    // 1. Run the hourly worker first time
    const count1 = await runHourlyAggregation();
    // Expect 2 rows inserted/updated in hourly_stats (pageview and signup)
    expect(count1).toBe(2);

    const check1 = await dbPool.query('SELECT * FROM hourly_stats ORDER BY event_type');
    expect(check1.rows.length).toBe(2);
    expect(check1.rows[0].event_type).toBe('pageview');
    expect(check1.rows[0].event_count).toBe(2);
    expect(check1.rows[0].bucket_time.toISOString()).toBe(testHour.toISOString());
    expect(check1.rows[1].event_type).toBe('signup');
    expect(check1.rows[1].event_count).toBe(1);

    // 2. Run hourly worker a second time (idempotency check)
    const count2 = await runHourlyAggregation();
    // It should upsert the same data without error or duplication
    expect(count2).toBe(2);

    const check2 = await dbPool.query('SELECT * FROM hourly_stats ORDER BY event_type');
    expect(check2.rows.length).toBe(2);
    expect(check2.rows[0].event_count).toBe(2); // Still 2, not duplicated
    expect(check2.rows[1].event_count).toBe(1); // Still 1
  });
});

describe('Daily Aggregation Worker', () => {
  test('should aggregate hourly stats into daily stats for completed days', async () => {
    const now = new Date();
    // Completed day (e.g. yesterday)
    const testDay = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 1,
      0, 0, 0
    ));

    const hour1 = new Date(testDay.getTime() + 2 * 60 * 60 * 1000); // 02:00
    const hour2 = new Date(testDay.getTime() + 15 * 60 * 60 * 1000); // 15:00

    // Insert mock data into hourly_stats directly
    await dbPool.query(
      `INSERT INTO hourly_stats (bucket_time, event_type, event_count) VALUES
       ($1, 'pageview', 15),
       ($2, 'pageview', 20),
       ($1, 'click', 5)`,
      [hour1, hour2]
    );

    // Also insert data into hourly_stats for the ongoing day (today)
    const currentDay = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0, 0, 0
    ));
    await dbPool.query(
      "INSERT INTO hourly_stats (bucket_time, event_type, event_count) VALUES ($1, 'pageview', 100)",
      [new Date(currentDay.getTime() + 1 * 60 * 60 * 1000)]
    );

    // 1. Run the daily worker first time
    const count1 = await runDailyAggregation();
    // Expect 2 rows inserted/updated in daily_stats (pageview and click)
    expect(count1).toBe(2);

    const check1 = await dbPool.query('SELECT * FROM daily_stats ORDER BY event_type');
    expect(check1.rows.length).toBe(2);
    expect(check1.rows[0].event_type).toBe('click');
    expect(check1.rows[0].event_count).toBe(5);
    expect(check1.rows[0].bucket_date.toISOString()).toBe(testDay.toISOString());
    
    expect(check1.rows[1].event_type).toBe('pageview');
    expect(check1.rows[1].event_count).toBe(35); // 15 + 20
    expect(check1.rows[1].bucket_date.toISOString()).toBe(testDay.toISOString());

    // 2. Run daily worker again (idempotency check)
    const count2 = await runDailyAggregation();
    expect(count2).toBe(2);

    const check2 = await dbPool.query('SELECT * FROM daily_stats ORDER BY event_type');
    expect(check2.rows.length).toBe(2);
    expect(check2.rows[1].event_count).toBe(35); // Still 35, not duplicated
  });
});

describe('Data Retention Worker', () => {
  test('should purge raw events older than 30 days and preserve rollup stats', async () => {
    const now = new Date();

    // 40 days ago (older than 30 days)
    const oldTimestamp = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
    // 5 days ago (newer than 30 days)
    const recentTimestamp = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

    // Insert raw events
    const r1 = await dbPool.query(
      "INSERT INTO raw_events (event_type, timestamp, metadata) VALUES ('pageview', $1, '{}') RETURNING id",
      [oldTimestamp]
    );
    const r2 = await dbPool.query(
      "INSERT INTO raw_events (event_type, timestamp, metadata) VALUES ('pageview', $1, '{}') RETURNING id",
      [recentTimestamp]
    );

    // Insert dummy values in hourly and daily stats dated 40 days ago
    await dbPool.query(
      "INSERT INTO hourly_stats (bucket_time, event_type, event_count) VALUES ($1, 'pageview', 10)",
      [oldTimestamp]
    );
    await dbPool.query(
      "INSERT INTO daily_stats (bucket_date, event_type, event_count) VALUES ($1, 'pageview', 100)",
      [oldTimestamp]
    );

    // Run data retention worker
    const purged = await runDataRetention();
    expect(purged).toBe(1); // 1 raw event (older than 30 days) should be deleted

    // Verify recent event still exists, old is deleted
    const dbEvents = await dbPool.query('SELECT id FROM raw_events');
    expect(dbEvents.rows.length).toBe(1);
    expect(dbEvents.rows[0].id).toBe(r2.rows[0].id);

    // Verify hourly_stats and daily_stats are NOT touched
    const hourlyCount = await dbPool.query('SELECT COUNT(*) FROM hourly_stats');
    expect(parseInt(hourlyCount.rows[0].count, 10)).toBe(1);

    const dailyCount = await dbPool.query('SELECT COUNT(*) FROM daily_stats');
    expect(parseInt(dailyCount.rows[0].count, 10)).toBe(1);
  });
});

describe('Scheduler lifecycle', () => {
  test('should register and clear scheduler intervals correctly', () => {
    delete process.env.DISABLE_SCHEDULER;
    const originalLog = console.log;
    const logs = [];
    console.log = (...args) => {
      logs.push(args.join(' '));
    };
    
    startScheduler();
    expect(logs.some(l => l.includes('Initializing background jobs...'))).toBe(true);

    stopScheduler();
    expect(logs.some(l => l.includes('Stopping scheduled background jobs...'))).toBe(true);
    
    process.env.DISABLE_SCHEDULER = 'true';
    console.log = originalLog;
  });

  test('should handle disabled scheduler gracefully', () => {
    process.env.DISABLE_SCHEDULER = 'true';
    const originalLog = console.log;
    const logs = [];
    console.log = (...args) => {
      logs.push(args.join(' '));
    };
    
    startScheduler();
    expect(logs.some(l => l.includes('Background jobs scheduler is disabled.'))).toBe(true);
    
    console.log = originalLog;
  });
});

describe('Worker error handling', () => {
  test('should propagate errors and rollback transaction if hourly worker fails', async () => {
    const originalConnect = dbPool.connect;
    dbPool.connect = async () => { throw new Error('DB Connection Failed'); };

    await expect(runHourlyAggregation()).rejects.toThrow('DB Connection Failed');

    dbPool.connect = originalConnect;
  });

  test('should propagate errors and rollback transaction if daily worker fails', async () => {
    const originalConnect = dbPool.connect;
    dbPool.connect = async () => { throw new Error('DB Connection Failed'); };

    await expect(runDailyAggregation()).rejects.toThrow('DB Connection Failed');

    dbPool.connect = originalConnect;
  });

  test('should propagate errors if retention worker fails', async () => {
    const originalQuery = dbPool.query;
    dbPool.query = async () => { throw new Error('DB Query Failed'); };

    await expect(runDataRetention()).rejects.toThrow('DB Query Failed');

    dbPool.query = originalQuery;
  });
});
