import { Hono } from 'hono';
import { migrate, pool, testConnection, getDbSource, getDbSchema } from './db.js';
import {
  authenticate,
  requireAuth,
  getActingParticipant,
  generateKey,
  hashKey,
  validateParticipantId,
  checkThreadAccess,
  isViewerKey,
  viewerMayAccess,
  isReadAllPrincipal,
  publicReadEnabled,
  VIEWER_ID
} from './auth.js';
import {
  validateThread,
  validateMessage,
  createThread,
  createMessage,
  applyBudget,
  type Thread,
  type Message,
  type CreateThreadInput,
  type CreateMessageInput
} from './threads.js';
import { UI_HTML } from './ui.js';
import {
  getNext,
  getInbox,
  getDigest,
  formatDigestText,
  computeEtag
} from './next.js';

const app = new Hono();

// PUBLIC_URL is echoed into public responses (openapi servers, truncation hints),
// so only accept a real http(s) URL. Anything else (e.g. a connection string
// pasted into the wrong variable) is ignored rather than leaked.
function getPublicUrl(raw: string | undefined = process.env.PUBLIC_URL): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (u.username || u.password) return undefined;
    return raw.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

// Rate limiting map
const rateLimits = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const limit = rateLimits.get(key);
  
  if (!limit || limit.resetAt < now) {
    rateLimits.set(key, { count: 1, resetAt: now + 60000 });
    return true;
  }
  
  if (limit.count >= 60) {
    return false;
  }
  
  limit.count++;
  return true;
}

// Logging middleware
app.use('*', async (c, next) => {
  const start = Date.now();
  const auth = await authenticate(c.req.header('authorization'));
  
  await next();
  
  const ms = Date.now() - start;
  const log = {
    participant: auth?.id || 'anonymous',
    route: c.req.path,
    method: c.req.method,
    status: c.res.status,
    ms
  };
  console.log(JSON.stringify(log));
});

// Rate limit middleware
app.use('*', async (c, next) => {
  const authHeader = c.req.header('authorization');
  if (authHeader) {
    const key = authHeader.slice(7, 20);
    if (!checkRateLimit(key)) {
      c.header('retry-after', '60');
      return c.json({ error: 'rate_limit', message: 'Too many requests' }, 429);
    }
  }
  await next();
});

// Errors and unknown routes answer in the same JSON shape as everything else.
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal', message: 'Internal server error' }, 500);
});
app.notFound((c) => c.json({ error: 'not_found', message: 'No such route' }, 404));

// Viewer key guard: a viewer may only read the allow-listed routes.
app.use('*', async (c, next) => {
  const authHeader = c.req.header('authorization');
  if (authHeader?.startsWith('Bearer ') && isViewerKey(authHeader.slice(7))) {
    if (c.req.header('x-as')) {
      return c.json({ error: 'forbidden', message: 'Viewer key cannot act as a participant' }, 403);
    }
    if (!viewerMayAccess(c.req.method, c.req.path)) {
      return c.json({ error: 'forbidden', message: 'Viewer key is read-only' }, 403);
    }
  }
  await next();
});

// GET /
app.get('/', async (c) => {
  const base = {
    name: 'ThreadBus',
    version: '0.1.3',
    description: 'A tiny HTTP service for threaded turn-based conversations',
    docs: '/openapi.json',
    ui: '/ui'
  };
  
  // Counts are only for callers holding a key; anonymous gets the banner.
  const auth = await authenticate(c.req.header('authorization'));
  if (!auth) {
    return c.json(base);
  }
  
  const { rows: [stats] } = await pool.query(`
    SELECT 
      (SELECT COUNT(*) FROM participants) as participants,
      (SELECT COUNT(*) FROM threads WHERE status = 'open') as open_threads,
      (SELECT COUNT(*) FROM threads WHERE status = 'resolved') as resolved_threads,
      (SELECT COUNT(*) FROM messages) as messages
  `);
  
  return c.json({
    ...base,
    stats: {
      participants: parseInt(stats.participants),
      open_threads: parseInt(stats.open_threads),
      resolved_threads: parseInt(stats.resolved_threads),
      messages: parseInt(stats.messages)
    }
  });
});

// GET /healthz
app.get('/healthz', async (c) => {
  const db = await testConnection();
  return c.json({ ok: db, db });
});

// GET /openapi.json
app.get('/openapi.json', (c) => {
  return c.json({
    openapi: '3.0.0',
    info: {
      title: 'ThreadBus API',
      version: '0.1.3',
      description: 'A tiny HTTP service for threaded turn-based conversations'
    },
    servers: [{ url: getPublicUrl() || 'http://localhost:3000' }],
    paths: {}
  });
});

// GET /ui - admin feed page. The page itself holds no data; it asks for the
// admin key and calls /feed and /threads/:id from the browser.
app.get('/ui', (c) => {
  c.header('cache-control', 'no-store');
  return c.html(UI_HTML);
});

// GET /next
app.get('/next', async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return;
  
  const participantId = getActingParticipant(c, auth);
  const kind = c.req.query('kind');
  const limit = Math.min(parseInt(c.req.query('limit') || '1'), 10);
  const full = c.req.query('full') === '1';
  const ifNoneMatch = c.req.header('if-none-match');
  
  const { threads, etag } = await getNext(participantId, kind, limit, full);
  
  c.header('etag', etag);
  
  if (ifNoneMatch === etag) {
    return c.body(null, 304);
  }
  
  if (threads.length === 0) {
    return c.body(null, 204);
  }
  
  // Apply budget
  const maxResponseBytes = parseInt(process.env.MAX_RESPONSE_BYTES || '16384');
  const publicUrl = getPublicUrl();
  
  const result = {
    participant: participantId,
    threads: threads.map(t => {
      const budget = applyBudget(t.messages, maxResponseBytes / limit, publicUrl);
      return {
        id: t.id,
        title: t.title,
        kind: t.kind,
        status: t.status,
        waiting_on: t.waiting_on,
        participants: t.participants,
        seq: t.seq,
        unread: t.unread,
        messages: budget.messages
      };
    }),
    budget: {
      bytes: JSON.stringify(threads).length,
      truncated: false
    }
  };
  
  return c.json(result);
});

// POST /threads
app.post('/threads', async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return;
  
  const participantId = getActingParticipant(c, auth);
  const body = await c.req.json<CreateThreadInput>();
  
  const error = validateThread(body);
  if (error) {
    return c.json({ error: 'validation_error', message: error }, 400);
  }
  
  try {
    const thread = await createThread(body, participantId);
    return c.json(thread, 201);
  } catch (err: any) {
    return c.json({ error: 'create_failed', message: err.message }, 400);
  }
});

// POST /threads/:id/messages
app.post('/threads/:id/messages', async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return;
  
  const participantId = getActingParticipant(c, auth);
  const threadId = parseInt(c.req.param('id'));
  const body = await c.req.json<CreateMessageInput>();
  const idempotencyKey = c.req.header('idempotency-key');
  
  // Check access
  const hasAccess = await checkThreadAccess(threadId, participantId);
  if (!hasAccess) {
    return c.json({ error: 'forbidden', message: 'Not a thread participant' }, 403);
  }
  
  // Get thread for validation
  const { rows: [thread] } = await pool.query<Thread>(
    'SELECT * FROM threads WHERE id = $1',
    [threadId]
  );
  
  if (!thread) {
    return c.json({ error: 'not_found', message: 'Thread not found' }, 404);
  }
  
  const error = validateMessage(body, thread, participantId);
  if (error) {
    const is409 = error.includes('resolved') || error.includes('archived') || error.includes('already open');
    return c.json({ 
      error: error.includes('already open') ? 'not_resolved' : 'validation_error', 
      message: error 
    }, is409 ? 409 : 400);
  }
  
  try {
    const result = await createMessage(threadId, body, participantId, idempotencyKey);
    return c.json({ 
      ...result.message,
      thread_status: result.thread.status,
      thread_waiting_on: result.thread.waiting_on
    }, 201);
  } catch (err: any) {
    return c.json({ error: 'create_failed', message: err.message }, 400);
  }
});

// GET /threads/:id
app.get('/threads/:id', async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return;
  
  const participantId = getActingParticipant(c, auth);
  const threadId = parseInt(c.req.param('id'));
  const since = c.req.query('since');
  const all = c.req.query('all') === '1';
  
  // Admin (not acting as anyone) and viewer see all threads
  const isAdmin = isReadAllPrincipal(c, auth);
  if (!isAdmin) {
    const hasAccess = await checkThreadAccess(threadId, participantId);
    if (!hasAccess) {
      return c.json({ error: 'forbidden', message: 'Not a thread participant' }, 403);
    }
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Get thread
    const { rows: [thread] } = await client.query<Thread>(
      'SELECT * FROM threads WHERE id = $1',
      [threadId]
    );
    
    if (!thread) {
      await client.query('ROLLBACK');
      return c.json({ error: 'not_found', message: 'Thread not found' }, 404);
    }
    
    // Get cursor. Admin (without x-as) is not a participants row, so it has no
    // cursor: it reads everything and advances nothing.
    let sinceSeq = 0;
    if (!all && !isAdmin) {
      const { rows: [cursor] } = await client.query(
        'SELECT seen_seq FROM cursors WHERE thread_id = $1 AND participant = $2',
        [threadId, participantId]
      );
      sinceSeq = cursor?.seen_seq || 0;
    }
    
    if (since) {
      sinceSeq = parseInt(since);
    }
    
    // Get messages
    const { rows: messages } = await client.query<Message>(
      `SELECT id, thread_id, seq, author, body, attachments, "to", resolved, created_at
       FROM messages WHERE thread_id = $1 AND seq > $2 ORDER BY seq ASC`,
      [threadId, sinceSeq]
    );
    
    // Advance cursor
    if (!isAdmin) {
      await client.query(
        `INSERT INTO cursors (thread_id, participant, seen_seq)
         VALUES ($1, $2, $3)
         ON CONFLICT (thread_id, participant) DO UPDATE SET seen_seq = $3`,
        [threadId, participantId, thread.seq]
      );
    }
    
    await client.query('COMMIT');
    
    return c.json({ ...thread, messages });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// GET /threads/:id/messages/:seq
app.get('/threads/:id/messages/:seq', async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return;
  
  const participantId = getActingParticipant(c, auth);
  const threadId = parseInt(c.req.param('id'));
  const seq = parseInt(c.req.param('seq'));
  
  // Check access
  if (!isReadAllPrincipal(c, auth)) {
    const hasAccess = await checkThreadAccess(threadId, participantId);
    if (!hasAccess) {
      return c.json({ error: 'forbidden', message: 'Not a thread participant' }, 403);
    }
  }
  
  const { rows: [message] } = await pool.query<Message>(
    `SELECT id, thread_id, seq, author, body, attachments, "to", resolved, created_at
     FROM messages WHERE thread_id = $1 AND seq = $2`,
    [threadId, seq]
  );
  
  if (!message) {
    return c.json({ error: 'not_found', message: 'Message not found' }, 404);
  }
  
  return c.json(message);
});

// GET /inbox
app.get('/inbox', async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return;
  
  const participantId = getActingParticipant(c, auth);
  const status = c.req.query('status');
  const since = c.req.query('since');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const ifNoneMatch = c.req.header('if-none-match');
  
  const { threads, etag } = await getInbox(participantId, status, since, limit);
  
  c.header('etag', etag);
  
  if (ifNoneMatch === etag) {
    return c.body(null, 304);
  }
  
  return c.json({ threads });
});

// GET /digest
app.get('/digest', async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return;
  
  const participantId = getActingParticipant(c, auth);
  const since = c.req.query('since');
  const format = c.req.query('format') as 'json' | 'text' || 'json';
  
  const { threads } = await getDigest(participantId, since, format);
  
  if (format === 'text') {
    return c.text(formatDigestText(threads));
  }
  
  return c.json({ threads });
});

// POST /threads/:id/status
app.post('/threads/:id/status', async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return;
  
  const participantId = getActingParticipant(c, auth);
  const threadId = parseInt(c.req.param('id'));
  const body = await c.req.json<{ status: 'archived' | 'open' }>();
  
  // Check access (participants or admin)
  if (auth.id !== 'admin') {
    const hasAccess = await checkThreadAccess(threadId, participantId);
    if (!hasAccess) {
      return c.json({ error: 'forbidden', message: 'Not a thread participant' }, 403);
    }
  }
  
  if (!['archived', 'open'].includes(body.status)) {
    return c.json({ error: 'validation_error', message: 'Status must be "archived" or "open"' }, 400);
  }
  
  await pool.query(
    'UPDATE threads SET status = $1, updated_at = NOW() WHERE id = $2',
    [body.status, threadId]
  );
  
  return c.json({ status: body.status });
});

// Admin endpoints

// POST /participants
app.post('/participants', async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return;
  
  if (auth.id !== 'admin') {
    return c.json({ error: 'forbidden', message: 'Admin only' }, 403);
  }
  
  const body = await c.req.json<{ id: string; name: string; kind: 'human' | 'agent' }>();
  
  if (!validateParticipantId(body.id)) {
    return c.json({ error: 'validation_error', message: 'Invalid participant ID format' }, 400);
  }
  
  if (!body.name || !body.kind || !['human', 'agent'].includes(body.kind)) {
    return c.json({ error: 'validation_error', message: 'Fields "name" and "kind" are required' }, 400);
  }
  
  const key = generateKey();
  const keyHash = hashKey(key);
  
  try {
    await pool.query(
      'INSERT INTO participants (id, name, kind, key_hash) VALUES ($1, $2, $3, $4)',
      [body.id, body.name, body.kind, keyHash]
    );
    
    return c.json({ id: body.id, key }, 201);
  } catch (err: any) {
    if (err.code === '23505') {
      return c.json({ error: 'conflict', message: 'Participant already exists' }, 409);
    }
    throw err;
  }
});

// POST /participants/:id/rotate
app.post('/participants/:id/rotate', async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return;
  
  if (auth.id !== 'admin') {
    return c.json({ error: 'forbidden', message: 'Admin only' }, 403);
  }
  
  const id = c.req.param('id');
  const key = generateKey();
  const keyHash = hashKey(key);
  
  const { rowCount } = await pool.query(
    'UPDATE participants SET key_hash = $1 WHERE id = $2',
    [keyHash, id]
  );
  
  if (rowCount === 0) {
    return c.json({ error: 'not_found', message: 'Participant not found' }, 404);
  }
  
  return c.json({ id, key });
});

// GET /participants
app.get('/participants', async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return;
  
  if (auth.id !== 'admin') {
    return c.json({ error: 'forbidden', message: 'Admin only' }, 403);
  }
  
  const { rows } = await pool.query(`
    SELECT 
      p.id, p.name, p.kind, p.last_seen_at,
      (SELECT COUNT(*) FROM threads WHERE status = 'open' AND p.id = ANY(participants)) as open_threads
    FROM participants p
    ORDER BY p.created_at DESC
  `);
  
  return c.json({ participants: rows });
});

// GET /threads (admin listing)
app.get('/threads', async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return;
  
  if (auth.id !== 'admin' && auth.id !== VIEWER_ID) {
    return c.json({ error: 'forbidden', message: 'Admin or viewer only' }, 403);
  }
  
  const status = c.req.query('status');
  const kind = c.req.query('kind');
  const participant = c.req.query('participant');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');
  
  let query = 'SELECT id, title, kind, status, waiting_on, participants, created_by, outcome, seq, created_at, updated_at FROM threads WHERE 1=1';
  const params: any[] = [];
  
  if (status) {
    params.push(status);
    query += ` AND status = $${params.length}`;
  }
  if (kind) {
    params.push(kind);
    query += ` AND kind = $${params.length}`;
  }
  if (participant) {
    params.push(participant);
    query += ` AND $${params.length} = ANY(participants)`;
  }
  
  params.push(limit, offset);
  query += ` ORDER BY updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
  
  const { rows } = await pool.query(query, params);
  return c.json({ threads: rows });
});

// GET /feed - admin only. Threads newest-activity first, each with its opening
// message (the "post") and a preview of the latest message. Resolved and
// archived threads are included: nothing is ever hidden from the feed.
app.get('/feed', async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return;
  
  if (auth.id !== 'admin' && auth.id !== VIEWER_ID) {
    return c.json({ error: 'forbidden', message: 'Admin or viewer only' }, 403);
  }
  
  const status = c.req.query('status');
  const kind = c.req.query('kind');
  const participant = c.req.query('participant');
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50') || 50, 1), 100);
  const offset = Math.max(parseInt(c.req.query('offset') || '0') || 0, 0);
  
  let where = 'WHERE 1=1';
  const params: any[] = [];
  
  if (status) {
    params.push(status);
    where += ` AND t.status = $${params.length}`;
  }
  if (kind) {
    params.push(kind);
    where += ` AND t.kind = $${params.length}`;
  }
  if (participant) {
    params.push(participant);
    where += ` AND $${params.length} = ANY(t.participants)`;
  }
  
  const { rows: [{ total }] } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM threads t ${where}`,
    params
  );
  
  params.push(limit, offset);
  const { rows: threads } = await pool.query(
    `SELECT t.id, t.title, t.kind, t.status, t.waiting_on, t.participants, t.created_by,
            t.outcome, t.seq, t.created_at, t.updated_at,
            (SELECT json_build_object('seq', m.seq, 'author', m.author, 'to', m."to",
                    'body', m.body, 'attachments', m.attachments, 'created_at', m.created_at)
               FROM messages m WHERE m.thread_id = t.id ORDER BY m.seq ASC LIMIT 1) AS first_message,
            (SELECT json_build_object('seq', m.seq, 'author', m.author, 'to', m."to",
                    'body', left(m.body, 280), 'resolved', m.resolved, 'created_at', m.created_at)
               FROM messages m WHERE m.thread_id = t.id ORDER BY m.seq DESC LIMIT 1) AS last_message
     FROM threads t ${where}
     ORDER BY t.updated_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  
  return c.json({ threads, total, limit, offset });
});

// DELETE /threads/:id
app.delete('/threads/:id', async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return;
  
  if (auth.id !== 'admin') {
    return c.json({ error: 'forbidden', message: 'Admin only' }, 403);
  }
  
  const threadId = parseInt(c.req.param('id'));
  const { rowCount } = await pool.query('DELETE FROM threads WHERE id = $1', [threadId]);
  
  if (rowCount === 0) {
    return c.json({ error: 'not_found', message: 'Thread not found' }, 404);
  }
  
  return c.body(null, 204);
});

// Start server
const port = parseInt(process.env.PORT || '3000');

async function start() {
  console.log('ThreadBus v0.1.3 starting...');
  
  try {
    const dbSource = getDbSource();
    console.log(`Database URL from: ${dbSource}`);
    
    const dbSchema = getDbSchema();
    if (dbSchema) {
      console.log(`Using DB schema: ${dbSchema}`);
    }
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
  
  if (process.env.PUBLIC_URL && !getPublicUrl()) {
    console.warn('PUBLIC_URL is not a plain http(s) URL; ignoring it');
  }
  
  if (!process.env.ADMIN_KEY || process.env.ADMIN_KEY.length < 24) {
    console.error('ADMIN_KEY is required and must be at least 24 characters');
    process.exit(1);
  }
  
  if (process.env.VIEWER_KEY) {
    if (process.env.VIEWER_KEY.length < 24) {
      console.error('VIEWER_KEY must be at least 24 characters');
      process.exit(1);
    }
    if (process.env.VIEWER_KEY === process.env.ADMIN_KEY) {
      console.error('VIEWER_KEY must differ from ADMIN_KEY');
      process.exit(1);
    }
    console.log('Viewer key enabled (read-only)');
  }
  
  if (publicReadEnabled()) {
    console.log('PUBLIC_READ is on: anyone can read threads without a key');
  }
  
  console.log('Running migrations...');
  await migrate();
  console.log('Migrations complete');
}

start().then(() => {
  console.log(`Server listening on port ${port}`);
  import('node:http').then(({ createServer }) => {
    createServer(async (req, res) => {
      const response = await app.fetch(new Request(`http://localhost:${port}${req.url}`, {
        method: req.method,
        headers: req.headers as any,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? await new Promise((resolve) => {
          const chunks: Buffer[] = [];
          req.on('data', chunk => chunks.push(chunk));
          req.on('end', () => resolve(Buffer.concat(chunks)));
        }) : undefined
      }));
      
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      
      const body = await response.arrayBuffer();
      res.end(Buffer.from(body));
    }).listen(port);
  });
}).catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});

export default {
  port,
  fetch: app.fetch
};
