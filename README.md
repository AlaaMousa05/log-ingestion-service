# Log Ingestion and Query Service

A high-performance structured log ingestion, querying, and aggregation service built with **TypeScript**, **Fastify**, **PostgreSQL**, **Drizzle ORM**, and **Docker**.

The service accepts structured logs, stores them in PostgreSQL, supports flexible filtering and cursor-based pagination, and provides time-based aggregation for observability and analytics use cases.

---

## Features

* Structured log ingestion
* Batch log insertion
* Log validation and partial rejection
* PostgreSQL persistence
* Drizzle ORM
* Filtering by:

  * Service
  * Log level
  * Message
  * Timestamp range
  * JSON attributes
* Cursor-based pagination
* Case-insensitive message search
* Time-based log aggregation
* Aggregation by service or level
* Configurable log retention
* Health check endpoint
* Dockerized PostgreSQL and application
* Automated database migrations
* Unit and integration tests

---

## Tech Stack

* **TypeScript**
* **Node.js**
* **Fastify**
* **PostgreSQL**
* **Drizzle ORM**
* **Vitest**
* **Docker / Docker Compose**

---

## Project Structure

```text
src/
├── config/
│   └── env.ts
│
├── controllers/
│   └── logs.controller.ts
│
├── db/
│   ├── index.ts
│   ├── schema.ts
│   └── migrations/
│
├── repositories/
│   └── logs.repository.ts
│
├── routes/
│   ├── health.route.ts
│   └── logs.route.ts
│
├── server/
│   ├── app.ts
│   └── routes.ts
│
├── services/
│   ├── logs.service.ts
│   ├── retention.job.ts
│   └── retention.service.ts
│
├── types/
│   └── log.types.ts
│
├── utils/
│   └── cursor.ts
│
├── validators/
│   └── log.validator.ts
│
└── index.ts

tests/
├── logs.repository.test.ts
├── logs.service.test.ts
└── log.validator.test.ts
```

---

## Getting Started

### Prerequisites

Make sure you have:

* Node.js 22+
* Docker
* Docker Compose
* npm

---

## Environment Variables

Create a `.env` file:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/log_ingestion
PORT=8080
RETENTION_DAYS=30
```

When the application runs inside Docker Compose, PostgreSQL is accessed using the Docker service name:

```env
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/log_ingestion
```

---

## Running with Docker

Start the application and PostgreSQL:

```bash
docker compose up -d
```

Check the running services:

```bash
docker compose ps
```

The application will be available at:

```text
http://localhost:8080
```

Database migrations are automatically applied when the application container starts.

---

## Health Check

Check whether the application is running:

```bash
curl http://localhost:8080/health
```

Response:

```json
{
  "status": "ok"
}
```

---

# API

## POST `/logs`

Ingest a batch of structured logs.

### Request

```bash
curl -X POST http://localhost:8080/logs \
  -H "Content-Type: application/json" \
  -d '{
    "logs": [
      {
        "timestamp": "2026-08-09T20:00:00.000Z",
        "level": "info",
        "service": "auth",
        "message": "login successful",
        "attributes": {
          "user_id": "42",
          "region": "eu-west"
        }
      }
    ]
  }'
```

### Response

```json
{
  "accepted": 1,
  "rejected": []
}
```

Invalid entries are rejected individually while valid entries can still be accepted.

Example:

```json
{
  "accepted": 1,
  "rejected": [
    {
      "index": 1,
      "reason": "invalid log level"
    }
  ]
}
```

---

## GET `/logs`

Query stored logs.

### Query Parameters

| Parameter    | Description                                   |
| ------------ | --------------------------------------------- |
| `service`    | Filter by service                             |
| `level`      | Filter by `debug`, `info`, `warn`, or `error` |
| `q`          | Case-insensitive message search               |
| `since`      | Return logs after this timestamp              |
| `until`      | Return logs before this timestamp             |
| `attr.<key>` | Filter by JSON attribute                      |
| `limit`      | Number of logs to return, from 1 to 1000      |
| `cursor`     | Cursor for pagination                         |

### Example

```bash
curl "http://localhost:8080/logs?service=auth&level=error&limit=20"
```

### Attribute filtering

```bash
curl "http://localhost:8080/logs?attr.user_id=42"
```

### Message search

```bash
curl "http://localhost:8080/logs?q=payment"
```

### Time range

```bash
curl "http://localhost:8080/logs?since=2026-08-09T20:00:00.000Z&until=2026-08-09T21:00:00.000Z"
```

### Response

```json
{
  "logs": [
    {
      "id": "uuid",
      "timestamp": "2026-08-09T20:02:00.000Z",
      "level": "error",
      "service": "payments",
      "message": "payment timeout",
      "attributes": {
        "user_id": "42",
        "region": "us-east"
      }
    }
  ],
  "next_cursor": "..."
}
```

When there are no more results:

```json
{
  "logs": [],
  "next_cursor": null
}
```

---

## Cursor Pagination

The `/logs` endpoint uses cursor-based pagination.

When `next_cursor` is returned, send it with the next request:

```bash
curl "http://localhost:8080/logs?limit=20&cursor=<NEXT_CURSOR>"
```

The cursor is based on the log timestamp and ID, providing stable pagination even when multiple logs have the same timestamp.

---

# GET `/logs/aggregate`

Aggregate logs over a time range.

### Required Parameters

* `since`
* `until`
* `bucket`

### Supported Buckets

* `1m`
* `5m`
* `1h`
* `1d`

### Optional Parameters

* `service`
* `level`
* `q`
* `attr.<key>`
* `group_by`

`group_by` supports:

* `service`
* `level`

### Example

```bash
curl "http://localhost:8080/logs/aggregate?since=2026-08-09T20:00:00.000Z&until=2026-08-09T21:00:00.000Z&bucket=1h"
```

### Response

```json
{
  "buckets": [
    {
      "start": "2026-08-09T20:00:00.000Z",
      "group": null,
      "count": 3
    }
  ]
}
```

### Group by service

```bash
curl "http://localhost:8080/logs/aggregate?since=2026-08-09T20:00:00.000Z&until=2026-08-09T21:00:00.000Z&bucket=1h&group_by=service"
```

Example response:

```json
{
  "buckets": [
    {
      "start": "2026-08-09T20:00:00.000Z",
      "group": "auth",
      "count": 1
    },
    {
      "start": "2026-08-09T20:00:00.000Z",
      "group": "checkout",
      "count": 2
    }
  ]
}
```

---

# Database

The application uses PostgreSQL with Drizzle ORM.

The `logs` table contains:

| Column       | Type        | Description                    |
| ------------ | ----------- | ------------------------------ |
| `id`         | UUID        | Primary key                    |
| `timestamp`  | timestamptz | Log timestamp                  |
| `level`      | varchar     | Log level                      |
| `service`    | varchar     | Service name                   |
| `message`    | text        | Log message                    |
| `attributes` | jsonb       | Additional structured metadata |
| `created_at` | timestamptz | Record creation time           |

### Indexes

The database includes indexes for:

* Timestamp queries
* Cursor pagination
* Log level filtering
* Service filtering
* Case-insensitive message search

---

# Database Migrations

Generate a migration after schema changes:

```bash
npx drizzle-kit generate
```

Apply migrations:

```bash
npx drizzle-kit migrate
```

When using Docker Compose, migrations are automatically applied when the application container starts.

---

# Testing

The project uses **Vitest**.

Run the tests locally:

```bash
npm test
```

Because repository tests require PostgreSQL, the recommended approach is to run them inside the Docker Compose network:

```bash
docker compose run --rm test
```

The integration test container connects to PostgreSQL through:

```text
postgres:5432
```

### Current test coverage

```text
Test Files  3 passed
Tests       26 passed
```

The test suite covers:

* Log validation
* Log service behavior
* Log insertion
* Log querying
* Ordering
* Service filtering
* Level filtering
* Message search
* JSON attribute filtering
* Time-range filtering
* Pagination limits
* Hourly aggregation
* Grouping by service
* Grouping by level
* Aggregation filters

---

# Docker Services

Docker Compose runs two main services:

### PostgreSQL

```text
postgres:18
```

Database:

```text
log_ingestion
```

### Application

The application runs on:

```text
localhost:8080
```

PostgreSQL is exposed on:

```text
localhost:5432
```

---

# Useful Commands

Start the project:

```bash
docker compose up -d
```

Stop the project:

```bash
docker compose down
```

View containers:

```bash
docker compose ps
```

View application logs:

```bash
docker compose logs app
```

View PostgreSQL logs:

```bash
docker compose logs postgres
```

Open PostgreSQL:

```bash
docker compose exec postgres psql -U postgres -d log_ingestion
```

Run tests:

```bash
docker compose run --rm test
```

Run migrations:

```bash
docker compose exec app npx drizzle-kit migrate
```

---

# Architecture

The application follows a layered architecture:

```text
HTTP Request
     │
     ▼
   Routes
     │
     ▼
 Controllers
     │
     ▼
  Services
     │
     ▼
Repositories
     │
     ▼
 Drizzle ORM
     │
     ▼
 PostgreSQL
```

Responsibilities are separated between:

* **Routes** — define HTTP endpoints
* **Controllers** — handle HTTP requests and responses
* **Services** — contain application/business logic
* **Repositories** — handle database operations
* **Validators** — validate incoming logs
* **Database layer** — PostgreSQL and Drizzle configuration
* **Utilities** — cursor encoding/decoding
* **Retention service** — removes logs according to the configured retention period

---

# Error Handling

The API validates incoming query parameters and request data.

Examples of validation errors include:

```json
{
  "error": "invalid level: 'trace'"
}
```

```json
{
  "error": "invalid limit"
}
```

```json
{
  "error": "until must be after since"
}
```

```json
{
  "error": "invalid cursor"
}
```

---

# License

This project is developed as a backend engineering project for learning and demonstration purposes.

```
```
