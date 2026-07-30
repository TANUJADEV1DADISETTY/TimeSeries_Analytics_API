# High-Performance Time-Series Analytics API

## Overview

The High-Performance Time-Series Analytics API is a production-ready backend service designed for ingesting, storing, aggregating, and analyzing high-volume time-series event data. The system is built using **Node.js**, **Express.js**, **PostgreSQL**, and **Redis**, following modern backend engineering practices such as asynchronous processing, caching, background jobs, idempotent rollups, and sliding-window rate limiting.

The application supports high-throughput event ingestion while providing low-latency analytical queries through precomputed aggregations and intelligent query routing.

---

# Table of Contents

- Features
- Technology Stack
- System Architecture
- Project Structure
- Prerequisites
- Installation
- Environment Variables
- Running the Application
- Docker Setup
- Database Schema
- API Documentation
- Background Workers
- Rate Limiting
- Redis Caching
- Query Routing Strategy
- Data Retention Policy
- Running Tests
- Benchmark
- Architecture Decisions
- Future Improvements

---

# Features

## Event Ingestion

- Accepts event data through REST API
- Validates incoming payload
- Automatically assigns current UTC timestamp if missing
- Stores metadata as JSONB
- Supports arbitrary event types

---

## Time-Series Storage

- Optimized PostgreSQL schema
- Indexed timestamp column
- JSONB metadata support
- Fast range queries
- High insertion performance

---

## Background Aggregation

Automatically generates

- Hourly summaries
- Daily summaries

using background workers.

The workers are completely idempotent and safely use PostgreSQL UPSERT operations.

---

## Sliding Window Rate Limiting

Redis Sorted Sets (ZSET) are used to implement

- 200 requests
- per IP
- per rolling 60 seconds

Unlike fixed windows, sliding windows eliminate burst traffic at window boundaries.

---

## Redis Caching

Dashboard responses are cached for

- 60 seconds

to reduce PostgreSQL load and improve response time.

---

## Intelligent Query Routing

The analytics service automatically decides whether data should come from

- raw_events
- hourly_stats
- daily_stats

or a combination of multiple tables.

---

## Data Retention

Old raw events

> older than 30 days

are automatically removed while aggregated data remains permanently stored.

---

# Technology Stack

| Component        | Technology       |
| ---------------- | ---------------- |
| Language         | Node.js          |
| Framework        | Express.js       |
| Database         | PostgreSQL       |
| Cache            | Redis            |
| Background Jobs  | node-cron        |
| Testing          | Jest + Supertest |
| Containerization | Docker           |
| Orchestration    | Docker Compose   |

---

# System Architecture

```
                     Clients
                        │
      ┌─────────────────┼─────────────────┐
      │                 │                 │
 POST /events     GET /analytics   GET /dashboard
      │                 │                 │
      └────────────── Express API ───────────────┐
                                                 │
                                ┌────────────────┴──────────────┐
                                │                               │
                           PostgreSQL                      Redis
                                │                               │
                                │                               │
                       raw_events table                  Rate Limiter
                                │                        Dashboard Cache
                                │
                     Hourly Aggregation Worker
                                │
                          hourly_stats
                                │
                     Daily Aggregation Worker
                                │
                           daily_stats
                                │
                    Retention Cleanup Worker
```

---

# Project Structure

```
timeseries-analytics-api/

│
├── src/
│   ├── api/
│   ├── config/
│   ├── db/
│   ├── middleware/
│   ├── models/
│   ├── routes/
│   ├── services/
│   ├── workers/
│   ├── cache/
│   ├── utils/
│   └── app.js
│
├── tests/
│
├── scripts/
│   └── load_test.js
│
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── package.json
├── submission.json
└── README.md
```

---

# Prerequisites

Install the following software before running the project.

- Node.js 18+
- Docker
- Docker Compose
- Git

---

# Installation

Clone repository

```
git clone https://github.com/your-username/time-series-analytics-api.git

cd time-series-analytics-api
```

Install dependencies

```
npm install
```

---

# Environment Variables

Create a .env file.

Example

```
PORT=8000

POSTGRES_USER=analytics_user

POSTGRES_PASSWORD=password

POSTGRES_DB=analytics_db

POSTGRES_HOST=db

POSTGRES_PORT=5432

REDIS_HOST=redis

REDIS_PORT=6379
```

---

# Running the Application

Development

```
npm run dev
```

Production

```
npm start
```

---

# Docker Setup

Build containers

```
docker-compose build
```

Start services

```
docker-compose up -d
```

Check containers

```
docker ps
```

Stop services

```
docker-compose down
```

Remove containers and volumes

```
docker-compose down -v
```

---

# Database Schema

## raw_events

Stores every incoming event.

| Column     | Type        |
| ---------- | ----------- |
| id         | UUID        |
| event_type | VARCHAR     |
| timestamp  | TIMESTAMPTZ |
| metadata   | JSONB       |

Indexes

```
timestamp DESC

event_type
```

---

## hourly_stats

Stores hourly rollups.

| Column      | Type        |
| ----------- | ----------- |
| id          | SERIAL      |
| bucket_time | TIMESTAMPTZ |
| event_type  | VARCHAR     |
| event_count | INTEGER     |

Unique Constraint

```
(bucket_time,event_type)
```

---

## daily_stats

Stores daily rollups.

| Column      | Type    |
| ----------- | ------- |
| id          | SERIAL  |
| bucket_date | DATE    |
| event_type  | VARCHAR |
| event_count | INTEGER |

Unique Constraint

```
(bucket_date,event_type)
```

---

# API Documentation

---

## POST /events

Stores an event.

### Request

```
POST /events
```

Body

```json
{
  "event_type": "pageview",
  "timestamp": "2023-10-01T14:30:00Z",
  "metadata": {
    "url": "/home",
    "user_id": "123"
  }
}
```

timestamp is optional.

If omitted

```
current UTC timestamp
```

will be generated.

---

### Success Response

```
201 Created
```

```json
{
  "message": "Event stored successfully"
}
```

---

### Error Response

```
400 Bad Request
```

```json
{
  "error": "Invalid timestamp"
}
```

---

```
429 Too Many Requests
```

```json
{
  "error": "Rate limit exceeded"
}
```

---

# GET /analytics

Returns aggregated analytics.

### Query Parameters

```
start_date

end_date

interval

event_type(optional)
```

Example

```
GET /analytics?
start_date=2023-10-01T00:00:00Z&
end_date=2023-10-02T00:00:00Z&
interval=hour
```

---

Response

```json
[
  {
    "bucket": "2023-10-01T14:00:00Z",
    "event_type": "pageview",
    "count": 1540
  }
]
```

---

# GET /dashboard/summary

Returns dashboard metrics.

Response

```json
{
  "metrics": [
    {
      "event_type": "pageview",
      "last_24h_count": 45000
    },
    {
      "event_type": "signup",
      "last_24h_count": 120
    }
  ]
}
```

---

# Background Workers

Three cron jobs run automatically.

---

## Hourly Worker

Runs every

```
5 minutes
```

Responsibilities

- Reads completed hours
- Aggregates raw events
- Writes hourly summaries
- Uses UPSERT
- Fully idempotent

---

## Daily Worker

Runs every day.

Responsibilities

- Reads hourly_stats
- Creates daily summaries
- Never scans raw_events

---

## Retention Worker

Runs daily.

Deletes

```
raw_events
older than
30 days
```

Keeps

- hourly_stats
- daily_stats

permanently.

---

# Sliding Window Rate Limiting

The ingestion endpoint is protected using Redis Sorted Sets.

Algorithm

```
Receive Request

↓

Remove entries older than 60 seconds

↓

Insert current request

↓

Count requests

↓

More than 200?

↓

Yes → 429

↓

No → Continue
```

Advantages

- Accurate rolling window
- Prevents burst attacks
- Automatic cleanup using Redis TTL

---

# Redis Caching

The dashboard endpoint uses Redis.

Workflow

```
Client

↓

Redis Cache

↓

Cache Hit

↓

Return Response

↓

Cache Miss

↓

Query PostgreSQL

↓

Store in Redis

↓

Return Response
```

TTL

```
60 seconds
```

Benefits

- Faster dashboard
- Lower database load
- Better scalability

---

# Query Routing Strategy

The analytics endpoint dynamically selects the data source.

Historical data

```
hourly_stats
```

Current hour

```
raw_events
```

Mixed range

```
hourly_stats

+

raw_events

↓

Merged Response
```

This minimizes expensive raw table scans.

---

# Data Retention Policy

To reduce storage usage

```
DELETE

raw_events

WHERE timestamp < NOW()-30 DAYS
```

Aggregated tables

```
hourly_stats

daily_stats
```

are never deleted.

---

# Running Tests

Run

```
npm test
```

Coverage

```
npm run test:coverage
```

Tests include

- API validation
- Rate limiter
- Aggregation workers
- Cache
- Database operations
- Background jobs

Coverage target

```
80%
```

---

# Benchmark

Run

```
node scripts/load_test.js
```

Benchmark performs

- Bulk event insertion
- Analytics query execution
- Measures latency

Target

```
Analytics response

<500 ms
```

---

# Architecture Decisions

### PostgreSQL

Chosen because

- ACID compliance
- JSONB support
- Excellent indexing
- Strong aggregation capabilities

---

### Redis

Chosen because

- In-memory performance
- Native Sorted Sets
- Built-in expiration
- Ideal for caching

---

### JSONB Metadata

Allows flexible event payloads.

Different event types may store completely different metadata without schema changes.

---

### Background Rollups

Instead of querying millions of raw rows every request

```
Raw Events

↓

Hourly Rollups

↓

Daily Rollups
```

This dramatically improves performance.

---

### UPSERT

```
INSERT

ON CONFLICT

DO UPDATE
```

Makes aggregation workers

- idempotent
- restart-safe
- fault tolerant

---

### UTC Timestamps

All timestamps are stored in UTC.

Benefits

- No timezone ambiguity
- Easier aggregation
- Consistent querying

---

# Future Improvements

- PostgreSQL table partitioning
- TimescaleDB integration
- Kafka event streaming
- Prometheus metrics
- Grafana dashboards
- Distributed worker queues
- Horizontal API scaling
- JWT Authentication
- OpenAPI (Swagger) documentation
- Kubernetes deployment
- Multi-region replication
- Event deduplication
- WebSocket live analytics
- Incremental rollups
- Materialized views

---
