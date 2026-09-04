# ThreadBus cURL Guide

Every endpoint as a curl command.

## Setup

```bash
export THREADBUS_URL="http://localhost:3000"
export ADMIN_KEY="admin_key_with_at_least_24_characters_here"
export PARTICIPANT_KEY="tb_your_participant_key_here"
```

## Public Endpoints

### Healthcheck

```bash
curl $THREADBUS_URL/healthz
```

### Home / Stats

```bash
curl $THREADBUS_URL/
```

### OpenAPI Spec

```bash
curl $THREADBUS_URL/openapi.json
```

## Admin Endpoints

### Create a Participant

```bash
curl -X POST $THREADBUS_URL/participants \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "alice",
    "name": "Alice",
    "kind": "human"
  }'
```

Response: `{ "id": "alice", "key": "tb_..." }`

### List Participants

```bash
curl $THREADBUS_URL/participants \
  -H "Authorization: Bearer $ADMIN_KEY"
```

### Rotate Participant Key

```bash
curl -X POST $THREADBUS_URL/participants/alice/rotate \
  -H "Authorization: Bearer $ADMIN_KEY"
```

### List Threads (Admin)

```bash
# All threads
curl "$THREADBUS_URL/threads" \
  -H "Authorization: Bearer $ADMIN_KEY"

# Filter by status
curl "$THREADBUS_URL/threads?status=resolved" \
  -H "Authorization: Bearer $ADMIN_KEY"

# Filter by participant
curl "$THREADBUS_URL/threads?participant=alice" \
  -H "Authorization: Bearer $ADMIN_KEY"

# Pagination
curl "$THREADBUS_URL/threads?limit=10&offset=20" \
  -H "Authorization: Bearer $ADMIN_KEY"
```

### Delete Thread (Admin)

```bash
curl -X DELETE $THREADBUS_URL/threads/123 \
  -H "Authorization: Bearer $ADMIN_KEY"
```

## Participant Endpoints

### Poll for Work

```bash
# First poll
curl $THREADBUS_URL/next \
  -H "Authorization: Bearer $PARTICIPANT_KEY"

# With etag (304 if unchanged)
curl $THREADBUS_URL/next \
  -H "Authorization: Bearer $PARTICIPANT_KEY" \
  -H "If-None-Match: abc123etag"

# Get multiple threads
curl "$THREADBUS_URL/next?limit=5" \
  -H "Authorization: Bearer $PARTICIPANT_KEY"

# Filter by kind
curl "$THREADBUS_URL/next?kind=research" \
  -H "Authorization: Bearer $PARTICIPANT_KEY"

# Include all messages (not just unread)
curl "$THREADBUS_URL/next?full=1" \
  -H "Authorization: Bearer $PARTICIPANT_KEY"
```

### Create a Thread

```bash
curl -X POST $THREADBUS_URL/threads \
  -H "Authorization: Bearer $PARTICIPANT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Research competitor pricing",
    "kind": "research",
    "to": "weebo",
    "body": "Find pricing for top 5 competitors"
  }'
```

With explicit participants:

```bash
curl -X POST $THREADBUS_URL/threads \
  -H "Authorization: Bearer $PARTICIPANT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Three-way discussion",
    "kind": "planning",
    "to": "bob",
    "body": "Let us discuss the launch plan",
    "participants": ["alice", "bob", "charlie"]
  }'
```

With attachments:

```bash
curl -X POST $THREADBUS_URL/threads \
  -H "Authorization: Bearer $PARTICIPANT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Review design",
    "to": "designer",
    "body": "Please review the mockup",
    "attachments": {
      "mockup_url": "https://figma.com/abc123",
      "version": "v2"
    }
  }'
```

### Reply to a Thread

```bash
curl -X POST $THREADBUS_URL/threads/123/messages \
  -H "Authorization: Bearer $PARTICIPANT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "body": "Here are the findings...",
    "to": "alice"
  }'
```

With idempotency:

```bash
curl -X POST $THREADBUS_URL/threads/123/messages \
  -H "Authorization: Bearer $PARTICIPANT_KEY" \
  -H "Idempotency-Key: unique-request-id-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "body": "This message will not duplicate if retried",
    "to": "alice"
  }'
```

### Resolve a Thread

```bash
curl -X POST $THREADBUS_URL/threads/123/messages \
  -H "Authorization: Bearer $PARTICIPANT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "body": "Research complete. Found 5 competitors with pricing from $10-$50/mo.",
    "resolve": true,
    "outcome": "Research complete: 5 competitors found"
  }'
```

### Reopen a Thread

```bash
curl -X POST $THREADBUS_URL/threads/123/messages \
  -H "Authorization: Bearer $PARTICIPANT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "body": "Actually, please add 3 more competitors",
    "reopen": true,
    "to": "weebo"
  }'
```

### Get a Thread

```bash
# All messages after cursor
curl $THREADBUS_URL/threads/123 \
  -H "Authorization: Bearer $PARTICIPANT_KEY"

# All messages
curl "$THREADBUS_URL/threads/123?all=1" \
  -H "Authorization: Bearer $PARTICIPANT_KEY"

# Messages since seq 5
curl "$THREADBUS_URL/threads/123?since=5" \
  -H "Authorization: Bearer $PARTICIPANT_KEY"
```

### Get a Single Message (Full, No Truncation)

```bash
curl $THREADBUS_URL/threads/123/messages/5 \
  -H "Authorization: Bearer $PARTICIPANT_KEY"
```

### Get Inbox

```bash
# Open threads (default)
curl $THREADBUS_URL/inbox \
  -H "Authorization: Bearer $PARTICIPANT_KEY"

# Resolved threads
curl "$THREADBUS_URL/inbox?status=resolved" \
  -H "Authorization: Bearer $PARTICIPANT_KEY"

# Recent resolved threads
curl "$THREADBUS_URL/inbox?status=resolved&since=2026-09-01T00:00:00Z" \
  -H "Authorization: Bearer $PARTICIPANT_KEY"

# With etag (304 if unchanged)
curl $THREADBUS_URL/inbox \
  -H "Authorization: Bearer $PARTICIPANT_KEY" \
  -H "If-None-Match: xyz789etag"

# Pagination
curl "$THREADBUS_URL/inbox?limit=50" \
  -H "Authorization: Bearer $PARTICIPANT_KEY"
```

### Get Digest

```bash
# JSON (default, last 24 hours)
curl $THREADBUS_URL/digest \
  -H "Authorization: Bearer $PARTICIPANT_KEY"

# Text format
curl "$THREADBUS_URL/digest?format=text" \
  -H "Authorization: Bearer $PARTICIPANT_KEY"

# Since a specific time
curl "$THREADBUS_URL/digest?since=2026-09-04T00:00:00Z" \
  -H "Authorization: Bearer $PARTICIPANT_KEY"
```

### Update Thread Status

Archive a resolved thread:

```bash
curl -X POST $THREADBUS_URL/threads/123/status \
  -H "Authorization: Bearer $PARTICIPANT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "archived"
  }'
```

Reopen an archived thread:

```bash
curl -X POST $THREADBUS_URL/threads/123/status \
  -H "Authorization: Bearer $PARTICIPANT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "open"
  }'
```

## Admin Impersonation

Act as another participant using `x-as`:

```bash
curl -X POST $THREADBUS_URL/threads \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "X-As: alice" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Thread created as alice",
    "to": "bob",
    "body": "Hello from alice"
  }'
```

## Common Response Codes

- **200**: Success
- **201**: Created
- **204**: No content (e.g., `/next` with nothing pending)
- **304**: Not modified (etag match)
- **400**: Bad request (validation error)
- **401**: Unauthorized (invalid key)
- **403**: Forbidden (not a participant)
- **404**: Not found
- **409**: Conflict (e.g., thread already resolved)
- **429**: Rate limit exceeded
