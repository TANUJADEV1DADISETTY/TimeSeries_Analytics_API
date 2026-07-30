import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

const { Pool } = pg;

const API_URL = 'http://localhost:8000';

const dbPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'analytics_user',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_NAME || 'analytics_db',
});

function calculatePercentile(array, percentile) {
  if (array.length === 0) return 0;
  const sorted = [...array].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[index];
}

async function runBenchmark() {
  console.log('--- Starting Load Test & Performance Benchmark ---');

  try {
    // 1. Truncate tables to get clean metrics
    console.log('Cleaning database...');
    await dbPool.query('TRUNCATE raw_events, hourly_stats, daily_stats RESTART IDENTITY');

    // 2. Generate and Bulk Insert 10,000 events
    console.log('Generating 10,000 events spread over the last 10 days...');
    const now = Date.now();
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
    
    const eventTypes = ['pageview', 'click', 'signup', 'purchase', 'add_to_cart'];
    const rows = [];

    for (let i = 0; i < 10000; i++) {
      // Pick random timestamp in the last 10 days
      const eventTimestamp = new Date(tenDaysAgo + Math.random() * (now - tenDaysAgo));
      const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];
      const metadata = {
        user_id: `user_${Math.floor(Math.random() * 1000)}`,
        path: `/page-${Math.floor(Math.random() * 20)}`,
        value: Math.floor(Math.random() * 100),
      };
      rows.push({
        id: uuidv4(),
        event_type: eventType,
        timestamp: eventTimestamp,
        metadata: JSON.stringify(metadata)
      });
    }

    console.log('Bulk inserting events into PostgreSQL raw_events...');
    // We do this in chunks of 2,000 to keep the queries efficient
    const chunkSize = 2000;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      
      const values = [];
      const placeholders = [];
      chunk.forEach((row, idx) => {
        const base = idx * 4;
        placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
        values.push(row.id, row.event_type, row.timestamp, row.metadata);
      });

      const query = `
        INSERT INTO raw_events (id, event_type, timestamp, metadata)
        VALUES ${placeholders.join(', ')}
      `;
      await dbPool.query(query, values);
    }
    console.log('10,000 events successfully inserted.');

    // 3. Trigger Rollups via admin endpoints
    console.log('Triggering Hourly Rollup Workers...');
    const rollupHourlyRes = await fetch(`${API_URL}/jobs/rollup/hourly`, { method: 'POST' });
    const rollupHourlyBody = await rollupHourlyRes.json();
    console.log(`Hourly rollups created: ${rollupHourlyBody.rows_processed} rows.`);

    console.log('Triggering Daily Rollup Workers...');
    const rollupDailyRes = await fetch(`${API_URL}/jobs/rollup/daily`, { method: 'POST' });
    const rollupDailyBody = await rollupDailyRes.json();
    console.log(`Daily rollups created: ${rollupDailyBody.rows_processed} rows.`);

    // 4. Benchmark Query Timing against /analytics
    console.log('Running query timing benchmark...');
    const testCases = [
      {
        name: 'Historical Hourly Stats',
        url: `/analytics?start_date=${new Date(tenDaysAgo).toISOString()}&end_date=${new Date(now - 2 * 60 * 60 * 1000).toISOString()}&interval=hour`
      },
      {
        name: 'Ongoing Hour Stats',
        url: `/analytics?start_date=${new Date(now - 30 * 60 * 1000).toISOString()}&end_date=${new Date(now).toISOString()}&interval=hour`
      },
      {
        name: 'Spanning Range Hourly (Hist + Ongoing)',
        url: `/analytics?start_date=${new Date(now - 12 * 60 * 60 * 1000).toISOString()}&end_date=${new Date(now).toISOString()}&interval=hour`
      },
      {
        name: 'Historical Daily Stats',
        url: `/analytics?start_date=${new Date(tenDaysAgo).toISOString()}&end_date=${new Date(now - 24 * 60 * 60 * 1000).toISOString()}&interval=day`
      }
    ];

    const iterations = 50;

    for (const testCase of testCases) {
      console.log(`\nBenchmarking: ${testCase.name} (${iterations} requests)`);
      const latencies = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const response = await fetch(`${API_URL}${testCase.url}`);
        const data = await response.json();
        const end = performance.now();
        
        if (response.status !== 200) {
          throw new Error(`Benchmark request failed with status ${response.status}: ${JSON.stringify(data)}`);
        }
        latencies.push(end - start);
      }

      const p50 = calculatePercentile(latencies, 50).toFixed(2);
      const p90 = calculatePercentile(latencies, 90).toFixed(2);
      const p95 = calculatePercentile(latencies, 95).toFixed(2);
      const avg = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2);

      console.log(`  Average: ${avg}ms`);
      console.log(`  p50:     ${p50}ms`);
      console.log(`  p90:     ${p90}ms`);
      console.log(`  p95:     ${p95}ms`);

      if (parseFloat(p95) >= 500) {
        throw new Error(`Performance SLA violated! p95 latency is ${p95}ms, exceeding 500ms limit.`);
      } else {
        console.log(`  Result:  PASS (p95 latency < 500ms)`);
      }
    }

    console.log('\n--- Benchmark Completed Successfully ---');
    process.exit(0);

  } catch (err) {
    console.error('Benchmark script error:', err);
    process.exit(1);
  } finally {
    await dbPool.end();
  }
}

// Introduce a slight delay to allow API to boot up if started concurrently
setTimeout(runBenchmark, 1000);
