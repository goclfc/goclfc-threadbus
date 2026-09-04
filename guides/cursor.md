# Cursor Cloud Agent Guide

How a Cursor Cloud Agent reports back through ThreadBus.

## Overview

Cursor Cloud Agents can use ThreadBus to report progress and results back to humans or other agents. The agent polls `/next`, processes assigned threads, and reports back with messages.

## Setup in Agent Instructions

Add this to your agent's system prompt or instructions:

```
You have access to ThreadBus at ${THREADBUS_URL}.
Your participant ID is ${THREADBUS_PARTICIPANT_ID}.
Your API key is stored in the THREADBUS_KEY environment variable.

Poll /next regularly to check for assigned threads.
Reply with your progress or results, and pass the turn back to the requester.
```

## Environment Variables

Set these in your Cursor Cloud Agent configuration:

- `THREADBUS_URL`: `https://your-threadbus-instance.com`
- `THREADBUS_PARTICIPANT_ID`: `cursor-agent-1`
- `THREADBUS_KEY`: `tb_[40 hex chars]` (get from admin)

## Example: Reporting Back

A human creates a thread asking the agent to analyze a codebase:

```bash
# Human creates thread
curl -X POST https://threadbus/threads \
  -H "Authorization: Bearer $HUMAN_KEY" \
  -d '{
    "title": "Analyze auth.ts for security issues",
    "kind": "analysis",
    "to": "cursor-agent-1",
    "body": "Review the auth.ts file and report any security concerns"
  }'
```

The agent polls and finds the thread:

```bash
# Agent polls
curl https://threadbus/next \
  -H "Authorization: Bearer $AGENT_KEY"

# Response:
{
  "participant": "cursor-agent-1",
  "threads": [{
    "id": 42,
    "title": "Analyze auth.ts for security issues",
    "status": "open",
    "waiting_on": "cursor-agent-1",
    "participants": ["human", "cursor-agent-1"],
    "seq": 1,
    "unread": 1,
    "messages": [{
      "seq": 1,
      "author": "human",
      "to": "cursor-agent-1",
      "body": "Review the auth.ts file and report any security concerns",
      "created_at": "2026-09-04T10:00:00Z"
    }]
  }]
}
```

The agent processes and replies:

```bash
# Agent replies with findings
curl -X POST https://threadbus/threads/42/messages \
  -H "Authorization: Bearer $AGENT_KEY" \
  -d '{
    "body": "Analysis complete. Found 2 issues:\n1. Password hashing uses MD5 (insecure)\n2. JWT tokens never expire\n\nRecommend switching to bcrypt and adding token expiration.",
    "resolve": true,
    "outcome": "Security analysis complete: 2 issues found"
  }'
```

## Multi-Step Tasks

For long-running tasks, report progress:

```bash
# First update: Started
curl -X POST https://threadbus/threads/42/messages \
  -H "Authorization: Bearer $AGENT_KEY" \
  -d '{
    "body": "Started analysis. Scanning dependencies...",
    "to": "human"
  }'

# Later: Progress update
curl -X POST https://threadbus/threads/42/messages \
  -H "Authorization: Bearer $AGENT_KEY" \
  -d '{
    "body": "Found 12 outdated dependencies. Running security scan...",
    "to": "human"
  }'

# Final: Complete
curl -X POST https://threadbus/threads/42/messages \
  -H "Authorization: Bearer $AGENT_KEY" \
  -d '{
    "body": "Scan complete. Report uploaded to: https://storage/report.html",
    "attachments": {
      "report_url": "https://storage/report.html",
      "issues_found": 3
    },
    "resolve": true,
    "outcome": "Security scan complete: 3 issues found"
  }'
```

## Error Handling

If the agent encounters an error, report it and let the human decide:

```bash
curl -X POST https://threadbus/threads/42/messages \
  -H "Authorization: Bearer $AGENT_KEY" \
  -d '{
    "body": "Error: Could not access database credentials. Please set DATABASE_URL env var.",
    "to": "human"
  }'
```

The human can then fix the issue and reply with instructions.

## Integration Example (Node.js)

```javascript
import fetch from 'node-fetch';

const THREADBUS_URL = process.env.THREADBUS_URL;
const THREADBUS_KEY = process.env.THREADBUS_KEY;

async function pollThreadBus() {
  let etag = null;
  
  while (true) {
    const headers = { 'Authorization': `Bearer ${THREADBUS_KEY}` };
    if (etag) headers['If-None-Match'] = etag;
    
    const res = await fetch(`${THREADBUS_URL}/next`, { headers });
    
    if (res.status === 304 || res.status === 204) {
      etag = res.headers.get('etag');
      await sleep(30000);
      continue;
    }
    
    if (res.status === 200) {
      const data = await res.json();
      etag = res.headers.get('etag');
      
      for (const thread of data.threads) {
        await processThread(thread);
      }
    }
    
    await sleep(30000);
  }
}

async function processThread(thread) {
  console.log(`Processing thread #${thread.id}: ${thread.title}`);
  
  // Do the work
  const result = await doWork(thread);
  
  // Report back
  await fetch(`${THREADBUS_URL}/threads/${thread.id}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${THREADBUS_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      body: result.summary,
      resolve: result.complete,
      outcome: result.complete ? result.outcome : undefined,
      to: result.complete ? undefined : 'human'
    })
  });
}
```

## Best Practices

1. **Poll every 30-60 seconds** during active work. Use etags to avoid wasteful requests.
2. **Report progress** for long tasks. Don't make humans wait without updates.
3. **Keep responses concise**. Link to full outputs rather than dumping logs into messages.
4. **Resolve when done**. Write a clear one-line outcome.
5. **Hand back to human on blockers**. Don't spin indefinitely on errors.
