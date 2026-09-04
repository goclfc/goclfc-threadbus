# threadbus spec v0.1

the smallest thing you can put between agents so they stop reading each other's whole history.

threadbus is a tiny http service. humans, coding agents, research bots and cron jobs open threads, reply in them, hand the turn to someone, and resolve them with one line. every participant polls one endpoint, `/next`, that returns only the threads where it is that participant's turn, and only the messages it has not seen. resolved threads disappear from everyone's view. an idle poll costs a header.

no sdk, no protocol, no framework. curl is a first-class client.

## why

every agent stack ends up with a chat log that every agent re-reads on every turn. tokens burn, context fills, and the "did anyone answer my question" check is the most expensive call in the system. threadbus turns that into a queue with memory: threads are separate, the turn is explicit, reads are cursor-based, and finished work is summarised once and never read again.

## concepts

**participant** – anyone with a key. `id` (slug, 2-32 chars, `[a-z0-9-]`), `name`, `kind` (`human` | `agent`). the admin creates participants and gets the key once. keys look like `tb_<40 hex>` and are stored hashed.

**thread** – one task or one conversation. fields: `id` (int), `title` (≤120 chars), `kind` (free tag, ≤32 chars, e.g. `research`, `publish`, `question`), `status` (`open` | `resolved` | `archived`), `waiting_on` (participant id, or null when resolved), `participants` (array of ids, 2-8), `created_by`, `outcome` (one line ≤280 chars, set at resolve), `seq` (number of messages so far), `created_at`, `updated_at`.

**message** – one entry in a thread. fields: `id`, `thread_id`, `seq` (1..n per thread), `author` (participant id), `body` (text or markdown, ≤32 kb), `attachments` (json object, ≤4 kb, optional; urls, not files), `to` (who the turn went to after this message, or null), `resolved` (bool), `created_at`.

**cursor** – per (thread, participant): `seen_seq`, the last message seq this participant has been shown. advanced automatically by every read that returns messages.

**the turn rule** – every message names who is next. `to` is required unless the thread has exactly two participants (then it defaults to the other one) or the message resolves the thread. `waiting_on` is always the last message's `to`. a thread appears in a participant's `/next` only while `waiting_on` equals that participant and `status` is `open`.

**the resolve rule** – whoever resolves writes `outcome`: one line that says what happened. after that the thread leaves every inbox and every `/next`. the outcome line is the only thing anyone should ever need from a resolved thread. a participant may reopen a thread by posting with `reopen: true`, which sets status back to `open` and requires `to`.

## auth

`authorization: Bearer <key>`. participant keys authenticate as that participant. the admin key (`ADMIN_KEY` env) authenticates as the special participant `admin`, which may act as any participant with the `x-as: <participant id>` header (for humans posting from a manager script). requests without a valid key get 401. participants get 403 for threads they are not in. every response carries `x-threadbus-participant: <id>`.

## endpoints

all bodies are json. all timestamps iso 8601 utc. errors are `{ "error": "<code>", "message": "<plain english>" }` with a proper status.

### GET /next

the endpoint every bot lives on.

query: `kind` (filter), `limit` (default 1, max 10), `full` (`1` to include all messages, not just unread).

headers in: `if-none-match` with the etag from the previous response.

behaviour:
1. compute `etag = sha1(participant + ':' + max(updated_at) over open threads where waiting_on = participant)`; if it equals `if-none-match`, return **304** with no body. this is the idle case and costs nothing.
2. otherwise return **200** with up to `limit` threads, oldest `updated_at` first, where `status = open` and `waiting_on = participant`. each thread carries only messages with `seq > seen_seq` (or all, with `full=1`), and `unread` = count of those. cursors advance to the thread's `seq`.
3. **204** when nothing is owed. also carries the etag.

response shape:

```json
{
  "participant": "weebo",
  "threads": [
    {
      "id": 12, "title": "style research: builder community replies", "kind": "research",
      "status": "open", "waiting_on": "weebo", "participants": ["claude","weebo"],
      "seq": 3, "unread": 1,
      "messages": [
        { "seq": 3, "author": "claude", "to": "weebo", "created_at": "2026-09-04T09:12:00Z",
          "body": "40 items is enough, add 10 replies that started conversations and resolve." }
      ]
    }
  ],
  "budget": { "bytes": 612, "truncated": false }
}
```

budget: the whole response is capped at 16 kb by default (`limit` × 16 kb hard max). a message body longer than 8 kb is cut at 8 kb with `"truncated": true` and the client fetches `GET /threads/:id/messages/:seq` for the rest. attachments over 2 kb inline are replaced by `{ "truncated": true }`.

### POST /threads

create a thread and its first message.

body: `{ "title", "kind"?, "to", "body", "participants"?, "attachments"? }`. `participants` defaults to `[caller, to]`; `to` must be in it. returns **201** with the thread (no messages). the thread is now `waiting_on: to`.

### POST /threads/:id/messages

reply. caller must be a participant.

body: `{ "body", "to"?, "resolve"?, "outcome"?, "reopen"?, "attachments"? }`.

rules, checked before anything is written:
- thread `resolved` or `archived` → **409** unless `reopen: true` (participants only).
- `resolve: true` requires `outcome` (1-280 chars, one line) and forbids `to`.
- otherwise `to` is required unless the thread has two participants; `to` must be a participant and not the caller.
- `idempotency-key` header (≤64 chars) makes a retry return the original message instead of a duplicate.

returns **201** with the message and the thread's new `status`/`waiting_on`. the caller's cursor advances to the new seq.

### GET /threads/:id

the thread with messages after the caller's cursor (`?since=<seq>` overrides, `?all=1` returns everything). advances the cursor. resolved threads still readable by participants; use it when you lost context, not on every turn.

### GET /threads/:id/messages/:seq

one full message, no truncation.

### GET /inbox

for participants, a summary only, no bodies: open threads where the caller is a participant. per thread: `id, title, kind, status, waiting_on, unread, seq, updated_at, last_author`. `?status=resolved&since=<iso>` lists resolved ones with their `outcome` for a wrap-up. sorted by `updated_at` desc, `limit` default 20 max 100. etag/304 supported the same way as `/next`.

### GET /digest

for humans and managers. `?since=<iso>` (default 24h), `?format=text` for one line per thread:

```
#12 research  resolved  weebo→claude  "40 style items + 10 replies posted to research inbox"   09:41
#13 publish   open      waiting_on gocha  last: claude 09:50
```

json form returns the same fields. digest never includes bodies.

### POST /threads/:id/status

`{ "status": "archived" | "open" }`. participants or admin. archiving a resolved thread keeps it readable but out of `?status=resolved` listings.

### admin

- `POST /participants` `{ "id", "name", "kind" }` → **201** `{ "id", "key" }`, key shown once. **409** if exists.
- `POST /participants/:id/rotate` → new key.
- `GET /participants` → list without keys, with `last_seen_at` (updated by every authenticated request) and `open_threads` count.
- `GET /threads?status=&kind=&participant=&limit=&offset=` → admin listing, summaries only.
- `DELETE /threads/:id` → hard delete (admin only).

### public

- `GET /` → rendered README plus counts: participants, open threads, resolved threads, messages. never thread content.
- `GET /healthz` → `{ "ok": true, "db": true }`.
- `GET /openapi.json` → the api, generated from the route table.

## the rule sheet for bots (goes in the README, verbatim)

1. poll `GET /next` with `if-none-match` set to the last etag. on 304 or 204 do nothing. never poll faster than every 30 seconds.
2. for each thread returned, read only the messages in the response. do not fetch the whole thread unless you have lost context.
3. reply once per thread with `POST /threads/:id/messages`. always say who is next with `to`, or finish with `resolve: true` and an `outcome` line.
4. keep bodies short. put long output somewhere with a url and attach the url.
5. a resolved thread is gone. do not look for it, do not reply to it. its outcome line is the summary.
6. if you need something from a human, reply with `to: <human id>`. the thread waits for them and costs nobody anything until they answer.

## storage

postgres. tables: `participants (id, name, kind, key_hash, created_at, last_seen_at)`, `threads (id, title, kind, status, waiting_on, participants text[], created_by, outcome, seq, created_at, updated_at)`, `messages (id, thread_id, seq, author, body, attachments jsonb, "to", resolved bool, idempotency_key, created_at, unique(thread_id, seq), unique(thread_id, author, idempotency_key))`, `cursors (thread_id, participant, seen_seq, primary key(thread_id, participant))`, `_migrations (name, applied_at)`. plain sql migrations under `migrations/`, applied on boot by filename order. indexes on `threads (waiting_on, status, updated_at)` and `messages (thread_id, seq)`.

`/next` and message posting run inside a transaction; the seq is taken from `UPDATE threads SET seq = seq + 1 ... RETURNING seq` so two replies never collide.

## stack

- node 22, typescript, one process. hono (or plain `node:http`) for routing, `pg` for the database, no orm.
- config from env: `DATABASE_URL` (required), `ADMIN_KEY` (required, ≥24 chars), `PORT` (default 3000), `PUBLIC_URL` (for links in truncation hints), `MAX_RESPONSE_BYTES` (default 16384).
- `Dockerfile` (multi-stage, distroless or alpine, runs as non-root), `docker-compose.yml` with postgres for local use, `npm test` running `node --test` against a real postgres.
- logging: one json line per request with participant, route, status, bytes, ms. no bodies in logs.
- rate limit: 60 requests per minute per key, 429 with `retry-after`.

## repo layout

```
README.md          what it is, quick start (docker run … then three curls), the rule sheet, endpoint table
SPEC.md            this file
LICENSE            mit
Dockerfile
docker-compose.yml
package.json
src/server.ts      boot, migrations, routing
src/auth.ts        keys, admin, x-as
src/threads.ts     thread + message logic, turn and resolve rules, budgets
src/next.ts        /next, /inbox, /digest, etags
src/db.ts          pool, migrate
migrations/001_init.sql
tests/api.test.mjs
guides/grok-bot.md     the exact instructions to paste into a grok bot (poll loop, reply shape)
guides/cursor.md       how a cursor cloud agent reports back through a thread
guides/curl.md         every endpoint as a curl line
guides/usectl.md       deploy on usectl in three commands (postgres addon, env, custom domain)
```

## out of scope for v0.1 (v0.2 candidates)

webhooks per participant (push instead of poll), sqlite backend, file attachments, a minimal web ui for humans, thread templates, per-kind response budgets, signed urls for public read-only threads.

## acceptance test (must pass before v0.1 ships)

1. admin creates `claude` (human) and `weebo` (agent).
2. `claude` opens a thread to `weebo`. `weebo` `/next` → 200 with 1 unread. `weebo` `/next` again with the etag → 304. `claude` `/next` → 204.
3. `weebo` replies (two participants, `to` defaults to `claude`). `weebo` `/next` → 204. `claude` `/next` → 200 with exactly the one new message, not the first one.
4. `claude` replies with `resolve: true, outcome: "..."`. both `/next` → 204. `/inbox` for both → empty. `/inbox?status=resolved` shows the outcome. `/digest?format=text` shows one line.
5. post to the resolved thread → 409. post with `reopen: true, to: "weebo"` → 201, `weebo` `/next` → 200.
6. a third participant `mario` hits `/threads/:id` → 403.
7. a 20 kb body comes back from `/next` truncated with the seq link, and whole from `/threads/:id/messages/:seq`.
8. same `idempotency-key` twice → same message id, seq unchanged.
9. two concurrent replies to one thread get seq n+1 and n+2, never the same.
10. `docker compose up` on a clean machine passes 1-9 with the curl guide alone.
