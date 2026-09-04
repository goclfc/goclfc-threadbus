# ThreadBus

**The smallest thing you can put between agents so they stop reading each other's whole history.**

ThreadBus is a tiny HTTP service for threaded turn-based conversations between humans, coding agents, research bots, and cron jobs. Threads are separate, the turn is explicit, reads are cursor-based, and finished work is summarized once and never read again.

**No SDK, no protocol, no framework. curl is a first-class client.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Why

Every agent stack ends up with a chat log that every agent re-reads on every turn. Tokens burn, context fills, and the "did anyone answer my question" check is the most expensive call in the system.

ThreadBus turns that into a **queue with memory**:
- Threads are separate
- The turn is explicit
- Reads are cursor-based
- Finished work is summarized once and never read again

## Quick Start

Get ThreadBus running in five minutes:

### 1. Start with Docker Compose

```bash
git clone https://github.com/goclfc/goclfc-threadbus.git
cd goclfc-threadbus
docker compose up
```

ThreadBus will start on `http://localhost:3000`.

### 2. Create Two Participants

```bash
export ADMIN_KEY="admin_key_with_at_least_24_characters_here"
export BASE="http://localhost:3000"

# Create Claude (human)
curl -X POST $BASE/participants \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"claude","name":"Claude","kind":"human"}'

# Save the returned key
export CLAUDE_KEY="tb_..."

# Create Weebo (agent)
curl -X POST $BASE/participants \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"weebo","name":"Weebo","kind":"agent"}'

# Save the returned key
export WEEBO_KEY="tb_..."
```

### 3. Three-Curl Demo

**Claude opens a thread:**

```bash
curl -X POST $BASE/threads \
  -H "Authorization: Bearer $CLAUDE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Research task",
    "kind": "research",
    "to": "weebo",
    "body": "Find pricing for top 3 competitors"
  }'
```

**Weebo polls and sees the thread:**

```bash
curl $BASE/next -H "Authorization: Bearer $WEEBO_KEY"
```

Response:

```json
{
  "participant": "weebo",
  "threads": [{
    "id": 1,
    "title": "Research task",
    "kind": "research",
    "status": "open",
    "waiting_on": "weebo",
    "participants": ["claude", "weebo"],
    "seq": 1,
    "unread": 1,
    "messages": [{
      "seq": 1,
      "author": "claude",
      "to": "weebo",
      "body": "Find pricing for top 3 competitors",
      "created_at": "2026-09-04T10:00:00Z"
    }]
  }],
  "budget": { "bytes": 312, "truncated": false }
}
```

**Weebo replies and resolves:**

```bash
curl -X POST $BASE/threads/1/messages \
  -H "Authorization: Bearer $WEEBO_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "body": "Found 3 competitors: Acme ($10/mo), Widget Co ($15/mo), Gizmo Inc ($20/mo)",
    "resolve": true,
    "outcome": "Research complete: 3 competitors found"
  }'
```

Now both participants poll `/next` and get **204 No Content**. The thread is resolved and gone from their inboxes. The one-line outcome is the only thing anyone needs from it.

## The Rule Sheet for Bots

This is what you tell your bots. Copy and paste it:

1. **Poll `GET /next` with `if-none-match` set to the last etag.** On 304 or 204 do nothing. Never poll faster than every 30 seconds.
2. **For each thread returned, read only the messages in the response.** Do not fetch the whole thread unless you have lost context.
3. **Reply once per thread with `POST /threads/:id/messages`.** Always say who is next with `to`, or finish with `resolve: true` and an `outcome` line.
4. **Keep bodies short.** Put long output somewhere with a url and attach the url.
5. **A resolved thread is gone.** Do not look for it, do not reply to it. Its outcome line is the summary.
6. **If you need something from a human, reply with `to: <human id>`.** The thread waits for them and costs nobody anything until they answer.

## Core Concepts

**Participant** – Anyone with a key. Has an `id` (slug, 2-32 chars, `[a-z0-9-]`), `name`, and `kind` (`human` or `agent`). Keys look like `tb_<40 hex>` and are stored hashed.

**Thread** – One task or conversation. Fields: `id`, `title`, `kind`, `status` (`open`/`resolved`/`archived`), `waiting_on`, `participants`, `created_by`, `outcome`, `seq`, timestamps.

**Message** – One entry in a thread. Fields: `seq`, `author`, `body`, `attachments`, `to`, `created_at`.

**Cursor** – Per (thread, participant): tracks `seen_seq`. Advanced automatically by reads.

**The Turn Rule** – Every message names who is next. `to` is required unless the thread has exactly two participants (then it defaults to the other one) or the message resolves the thread.

**The Resolve Rule** – Whoever resolves writes `outcome`: one line that says what happened. After that the thread leaves every inbox and every `/next`. The outcome line is the only thing anyone should ever need from a resolved thread.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/next` | Poll for threads where you're waiting. Returns only unread messages. Supports etag/304. |
| `POST` | `/threads` | Create a thread and its first message. |
| `POST` | `/threads/:id/messages` | Reply to a thread. Pass the turn with `to`, or finish with `resolve` and `outcome`. |
| `GET` | `/threads/:id` | Get a thread with messages (cursor-based or all). |
| `GET` | `/threads/:id/messages/:seq` | Get one full message (no truncation). |
| `GET` | `/inbox` | List threads you're in (summaries only, no bodies). |
| `GET` | `/digest` | Recent activity summary (text or JSON). |
| `POST` | `/threads/:id/status` | Archive or reopen a thread. |
| `GET` | `/healthz` | Health check. |

### Admin Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/participants` | Create a participant. Returns the key once. |
| `POST` | `/participants/:id/rotate` | Rotate a participant's key. |
| `GET` | `/participants` | List all participants. |
| `GET` | `/threads` | Admin thread listing with filters. |
| `DELETE` | `/threads/:id` | Hard delete a thread. |

See [guides/curl.md](guides/curl.md) for every endpoint as a curl command.

## Authentication

Use `Authorization: Bearer <key>`.

- **Participant keys** authenticate as that participant.
- **Admin key** (`ADMIN_KEY` env var) authenticates as `admin`, which may impersonate any participant with the `X-As: <participant id>` header.

Every response includes `X-ThreadBus-Participant: <id>`.

## Response Budgets

The `/next` endpoint caps responses at 16 KB by default (configurable with `MAX_RESPONSE_BYTES`). Message bodies longer than 8 KB are truncated at 8 KB with `"truncated": true`, and the client fetches the full message with `GET /threads/:id/messages/:seq`.

Attachments over 2 KB are replaced with `{ "truncated": true }`.

## Installation

### Docker Compose (Recommended)

```bash
docker compose up
```

### Manual (Node 22+)

```bash
npm install
npm run build
export DATABASE_URL="postgres://user:pass@localhost:5432/threadbus"
export ADMIN_KEY="your_secure_admin_key_here"
npm start
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | - | Postgres connection string |
| `ADMIN_KEY` | Yes | - | Admin key (≥24 chars) |
| `PORT` | No | 3000 | HTTP server port |
| `PUBLIC_URL` | No | - | Public URL for truncation hints |
| `MAX_RESPONSE_BYTES` | No | 16384 | Max response size in bytes |

## Testing

Run the test suite against a real Postgres database:

```bash
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/threadbus"
export ADMIN_KEY="admin_key_with_at_least_24_characters_here"
npm test
```

All 10 acceptance tests must pass before v0.1 ships.

## Guides

- **[guides/grok-bot.md](guides/grok-bot.md)** – Paste-ready instructions for a Grok bot (poll loop, reply shape, the six rules).
- **[guides/cursor.md](guides/cursor.md)** – How a Cursor Cloud Agent reports back through a thread.
- **[guides/curl.md](guides/curl.md)** – Every endpoint as a curl command.
- **[guides/usectl.md](guides/usectl.md)** – Deploy on Usectl in three commands (Postgres addon, env, custom domain).

## Stack

- **Node 22**, TypeScript, one process
- **Hono** for routing, **pg** for database, no ORM
- **Postgres** for storage
- **Dockerfile** (multi-stage, Alpine, non-root user)
- **docker-compose.yml** with Postgres for local use
- Migrations applied automatically on boot
- Rate limiting: 60 requests/minute per key
- Logging: one JSON line per request (no bodies)

## Repository Layout

```
README.md          This file
SPEC.md            Full specification
LICENSE            MIT
Dockerfile         Multi-stage production build
docker-compose.yml Postgres + ThreadBus for local dev
package.json       Node dependencies
tsconfig.json      TypeScript config
src/
  server.ts        Boot, migrations, routing
  auth.ts          Keys, admin, x-as
  threads.ts       Thread + message logic, turn rules, budgets
  next.ts          /next, /inbox, /digest, etags
  db.ts            Pool, migrations
migrations/
  001_init.sql     Initial schema
tests/
  api.test.mjs     Acceptance tests (node --test)
guides/
  grok-bot.md      Instructions for Grok bots
  cursor.md        Cursor Cloud Agent integration
  curl.md          Every endpoint as curl
  usectl.md        Deploy on Usectl
```

## Roadmap (v0.2 candidates)

- Webhooks per participant (push instead of poll)
- SQLite backend
- File attachments
- Minimal web UI for humans
- Thread templates
- Per-kind response budgets
- Signed URLs for public read-only threads

## Contributing

ThreadBus v0.1 is feature-complete for the spec. Bug reports and documentation improvements are welcome. For new features, please discuss in an issue first.

## License

MIT © goclfc

---

**ThreadBus v0.1** – The smallest thing you can put between agents.
