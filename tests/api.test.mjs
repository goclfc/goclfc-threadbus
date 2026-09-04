import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3300';
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin_key_with_at_least_24_characters_here';
const PORT = process.env.PORT || '3300';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/threadbus';

let claudeKey, weeboKey, marioKey;
let testThreadId;
let serverProcess;

async function request(method, path, { headers = {}, body, expectStatus } = {}) {
  const url = BASE_URL + path;
  const options = {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers
    }
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const res = await fetch(url, options);
  
  if (expectStatus !== undefined && res.status !== expectStatus) {
    const text = await res.text();
    throw new Error(`Expected ${expectStatus}, got ${res.status}: ${text}`);
  }
  
  const contentType = res.headers.get('content-type');
  let data;
  if (contentType?.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  
  return { status: res.status, data, headers: res.headers };
}

async function waitForServer(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fetch(`${BASE_URL}/healthz`);
      return true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return false;
}

before(async () => {
  // Only start server if BASE_URL is not set
  if (!process.env.BASE_URL) {
    console.log('Starting server...');
    serverProcess = spawn('node', ['dist/server.js'], {
      env: {
        ...process.env,
        DATABASE_URL,
        ADMIN_KEY,
        PORT
      },
      stdio: 'pipe'
    });
    
    serverProcess.stdout.on('data', (data) => {
      console.log(`[server] ${data}`);
    });
    
    serverProcess.stderr.on('data', (data) => {
      console.error(`[server] ${data}`);
    });
    
    const ready = await waitForServer();
    if (!ready) {
      throw new Error('Server did not start in time');
    }
    console.log('Server ready');
  }
});

after(async () => {
  if (serverProcess) {
    console.log('Stopping server...');
    serverProcess.kill();
  }
});

describe('ThreadBus v0.1 Acceptance Tests', () => {
  
  test('Test 1: Admin creates participants', async () => {
    // Create claude (human)
    const claudeRes = await request('POST', '/participants', {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      body: { id: 'claude', name: 'Claude', kind: 'human' },
      expectStatus: 201
    });
    assert.strictEqual(claudeRes.data.id, 'claude');
    assert.ok(claudeRes.data.key.startsWith('tb_'));
    claudeKey = claudeRes.data.key;
    
    // Create weebo (agent)
    const weeboRes = await request('POST', '/participants', {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      body: { id: 'weebo', name: 'Weebo', kind: 'agent' },
      expectStatus: 201
    });
    assert.strictEqual(weeboRes.data.id, 'weebo');
    assert.ok(weeboRes.data.key.startsWith('tb_'));
    weeboKey = weeboRes.data.key;
    
    // Create mario for test 6
    const marioRes = await request('POST', '/participants', {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      body: { id: 'mario', name: 'Mario', kind: 'human' },
      expectStatus: 201
    });
    marioKey = marioRes.data.key;
    
    console.log('✓ Test 1: Admin created claude, weebo, and mario');
  });
  
  test('Test 2: Thread creation and /next with etag', async () => {
    // Claude opens a thread to weebo
    const threadRes = await request('POST', '/threads', {
      headers: { authorization: `Bearer ${claudeKey}` },
      body: {
        title: 'Test thread',
        kind: 'question',
        to: 'weebo',
        body: 'Can you help me?'
      },
      expectStatus: 201
    });
    testThreadId = threadRes.data.id;
    assert.strictEqual(threadRes.data.waiting_on, 'weebo');
    assert.strictEqual(threadRes.data.status, 'open');
    
    // Weebo /next → 200 with 1 unread
    const weeboNext1 = await request('GET', '/next', {
      headers: { authorization: `Bearer ${weeboKey}` },
      expectStatus: 200
    });
    assert.strictEqual(weeboNext1.data.threads.length, 1);
    assert.strictEqual(weeboNext1.data.threads[0].unread, 1);
    const etag = weeboNext1.headers.get('etag');
    assert.ok(etag);
    
    // Weebo /next again with etag → 304
    const weeboNext2 = await request('GET', '/next', {
      headers: {
        authorization: `Bearer ${weeboKey}`,
        'if-none-match': etag
      }
    });
    assert.strictEqual(weeboNext2.status, 304);
    
    // Claude /next → 204
    const claudeNext = await request('GET', '/next', {
      headers: { authorization: `Bearer ${claudeKey}` }
    });
    assert.strictEqual(claudeNext.status, 204);
    
    console.log('✓ Test 2: Thread creation, /next returns correct unread, etag 304 works, claude gets 204');
  });
  
  test('Test 3: Reply and cursor advancement', async () => {
    // Weebo replies (two participants, 'to' defaults to claude)
    await request('POST', `/threads/${testThreadId}/messages`, {
      headers: { authorization: `Bearer ${weeboKey}` },
      body: { body: 'Sure, what do you need?' },
      expectStatus: 201
    });
    
    // Weebo /next → 204
    const weeboNext = await request('GET', '/next', {
      headers: { authorization: `Bearer ${weeboKey}` }
    });
    assert.strictEqual(weeboNext.status, 204);
    
    // Claude /next → 200 with exactly one new message
    const claudeNext = await request('GET', '/next', {
      headers: { authorization: `Bearer ${claudeKey}` },
      expectStatus: 200
    });
    assert.strictEqual(claudeNext.data.threads.length, 1);
    assert.strictEqual(claudeNext.data.threads[0].unread, 1);
    assert.strictEqual(claudeNext.data.threads[0].messages.length, 1);
    assert.strictEqual(claudeNext.data.threads[0].messages[0].seq, 2);
    
    console.log('✓ Test 3: Reply advances cursor, only new message returned');
  });
  
  test('Test 4: Resolve thread and digest', async () => {
    // Claude replies with resolve
    await request('POST', `/threads/${testThreadId}/messages`, {
      headers: { authorization: `Bearer ${claudeKey}` },
      body: {
        body: 'Thanks!',
        resolve: true,
        outcome: 'Question answered successfully'
      },
      expectStatus: 201
    });
    
    // Both /next → 204
    const weeboNext = await request('GET', '/next', {
      headers: { authorization: `Bearer ${weeboKey}` }
    });
    assert.strictEqual(weeboNext.status, 204);
    
    const claudeNext = await request('GET', '/next', {
      headers: { authorization: `Bearer ${claudeKey}` }
    });
    assert.strictEqual(claudeNext.status, 204);
    
    // /inbox for both → empty (no open threads)
    const weeboInbox = await request('GET', '/inbox', {
      headers: { authorization: `Bearer ${weeboKey}` },
      expectStatus: 200
    });
    assert.strictEqual(weeboInbox.data.threads.length, 0);
    
    const claudeInbox = await request('GET', '/inbox', {
      headers: { authorization: `Bearer ${claudeKey}` },
      expectStatus: 200
    });
    assert.strictEqual(claudeInbox.data.threads.length, 0);
    
    // /inbox?status=resolved shows outcome
    const resolvedInbox = await request('GET', '/inbox?status=resolved', {
      headers: { authorization: `Bearer ${claudeKey}` },
      expectStatus: 200
    });
    assert.strictEqual(resolvedInbox.data.threads.length, 1);
    assert.strictEqual(resolvedInbox.data.threads[0].outcome, 'Question answered successfully');
    
    // /digest?format=text shows one line
    const digest = await request('GET', '/digest?format=text', {
      headers: { authorization: `Bearer ${claudeKey}` },
      expectStatus: 200
    });
    assert.ok(typeof digest.data === 'string');
    assert.ok(digest.data.includes('resolved'));
    
    console.log('✓ Test 4: Resolve works, /next returns 204, /inbox empty, /digest shows resolved thread');
  });
  
  test('Test 5: Reopen thread', async () => {
    // Try to post to resolved thread → 409
    const failRes = await request('POST', `/threads/${testThreadId}/messages`, {
      headers: { authorization: `Bearer ${claudeKey}` },
      body: { body: 'Wait, one more thing' }
    });
    assert.strictEqual(failRes.status, 409);
    
    // Post with reopen: true → 201
    await request('POST', `/threads/${testThreadId}/messages`, {
      headers: { authorization: `Bearer ${claudeKey}` },
      body: {
        body: 'Actually, one more question',
        reopen: true,
        to: 'weebo'
      },
      expectStatus: 201
    });
    
    // Weebo /next → 200
    const weeboNext = await request('GET', '/next', {
      headers: { authorization: `Bearer ${weeboKey}` },
      expectStatus: 200
    });
    assert.strictEqual(weeboNext.data.threads.length, 1);
    assert.strictEqual(weeboNext.data.threads[0].status, 'open');
    
    console.log('✓ Test 5: Posting to resolved thread fails, reopen works');
  });
  
  test('Test 6: Access control', async () => {
    // Mario (not a participant) tries to access thread → 403
    const marioRes = await request('GET', `/threads/${testThreadId}`, {
      headers: { authorization: `Bearer ${marioKey}` }
    });
    assert.strictEqual(marioRes.status, 403);
    
    console.log('✓ Test 6: Non-participant gets 403');
  });
  
  test('Test 7: Message truncation', async () => {
    // Create large message (20 KB)
    const largeBody = 'x'.repeat(20000);
    
    // Weebo replies with large body
    await request('POST', `/threads/${testThreadId}/messages`, {
      headers: { authorization: `Bearer ${weeboKey}` },
      body: { body: largeBody },
      expectStatus: 201
    });
    
    // Claude /next should return truncated message
    const claudeNext = await request('GET', '/next', {
      headers: { authorization: `Bearer ${claudeKey}` },
      expectStatus: 200
    });
    const msg = claudeNext.data.threads[0].messages[0];
    assert.ok(msg.body.length < largeBody.length);
    assert.strictEqual(msg.truncated, true);
    
    // Get full message via /threads/:id/messages/:seq
    const fullMsg = await request('GET', `/threads/${testThreadId}/messages/${msg.seq}`, {
      headers: { authorization: `Bearer ${claudeKey}` },
      expectStatus: 200
    });
    assert.strictEqual(fullMsg.data.body.length, 20000);
    
    console.log('✓ Test 7: Large message truncated in /next, full in /messages/:seq');
  });
  
  test('Test 8: Idempotency', async () => {
    const idempotencyKey = 'test-key-12345';
    
    // Post message with idempotency key
    const res1 = await request('POST', `/threads/${testThreadId}/messages`, {
      headers: {
        authorization: `Bearer ${claudeKey}`,
        'idempotency-key': idempotencyKey
      },
      body: { body: 'Idempotent message' },
      expectStatus: 201
    });
    const messageId1 = res1.data.id;
    const seq1 = res1.data.seq;
    
    // Post again with same key
    const res2 = await request('POST', `/threads/${testThreadId}/messages`, {
      headers: {
        authorization: `Bearer ${claudeKey}`,
        'idempotency-key': idempotencyKey
      },
      body: { body: 'Idempotent message' },
      expectStatus: 201
    });
    const messageId2 = res2.data.id;
    const seq2 = res2.data.seq;
    
    // Should return same message
    assert.strictEqual(messageId1, messageId2);
    assert.strictEqual(seq1, seq2);
    
    console.log('✓ Test 8: Idempotency key returns same message');
  });
  
  test('Test 9: Concurrent replies get different seq', async () => {
    // Create a new thread for this test
    const threadRes = await request('POST', '/threads', {
      headers: { authorization: `Bearer ${claudeKey}` },
      body: {
        title: 'Concurrency test',
        to: 'weebo',
        body: 'First message'
      },
      expectStatus: 201
    });
    const concurrentThreadId = threadRes.data.id;
    
    // Both reply at the same time
    const [res1, res2] = await Promise.all([
      request('POST', `/threads/${concurrentThreadId}/messages`, {
        headers: { authorization: `Bearer ${weeboKey}` },
        body: { body: 'Reply 1' },
        expectStatus: 201
      }),
      request('POST', `/threads/${concurrentThreadId}/messages`, {
        headers: { authorization: `Bearer ${claudeKey}` },
        body: { body: 'Reply 2', to: 'weebo' },
        expectStatus: 201
      })
    ]);
    
    const seq1 = res1.data.seq;
    const seq2 = res2.data.seq;
    
    // Seqs should be different
    assert.notStrictEqual(seq1, seq2);
    assert.ok(seq1 === 2 || seq1 === 3);
    assert.ok(seq2 === 2 || seq2 === 3);
    
    console.log(`✓ Test 9: Concurrent replies got seq ${seq1} and ${seq2}`);
  });
  
  test('Test 10: Healthcheck', async () => {
    const res = await request('GET', '/healthz', { expectStatus: 200 });
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.db, true);
    
    console.log('✓ Test 10: Healthcheck passes');
  });
  
  test('Test 11: Admin sees all threads in digest', async () => {
    // Create a thread between claude and weebo (admin is not a participant)
    const threadRes = await request('POST', '/threads', {
      headers: { authorization: `Bearer ${claudeKey}` },
      body: {
        title: 'Private thread',
        to: 'weebo',
        body: 'Admin should see this in digest'
      },
      expectStatus: 201
    });
    const privateThreadId = threadRes.data.id;
    
    // Admin polls digest (should see threads even though not a participant)
    const digest = await request('GET', '/digest?format=text', {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      expectStatus: 200
    });
    
    // Should see the private thread
    assert.ok(typeof digest.data === 'string');
    assert.ok(digest.data.includes(`#${privateThreadId}`), 
      `Admin digest should include thread #${privateThreadId}, got: ${digest.data}`);
    
    console.log('✓ Test 11: Admin sees all threads in digest');
  });
  
});
