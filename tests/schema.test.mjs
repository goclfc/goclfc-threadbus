import { test, describe } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';
import { spawn } from 'child_process';

const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/threadbus';
const ADMIN_KEY = 'admin_key_with_at_least_24_characters_here';
const PORT = '3301';
const BASE_URL = `http://localhost:${PORT}`;
const TEST_SCHEMA = 'tb_test';

let serverProcess;

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

async function querySchemaTable(schemaName) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  
  try {
    const result = await client.query(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = $1 AND table_name IN ('threads', 'messages', 'participants', 'cursors', '_migrations')
       ORDER BY table_name`,
      [schemaName]
    );
    return result.rows.map(r => r.table_name);
  } finally {
    await client.end();
  }
}

describe('ThreadBus v0.1.1 DB_SCHEMA Tests', () => {
  
  test('DB_SCHEMA creates schema and tables in that schema', async () => {
    console.log(`Starting server with DB_SCHEMA=${TEST_SCHEMA}...`);
    
    serverProcess = spawn('node', ['dist/server.js'], {
      env: {
        ...process.env,
        DATABASE_URL,
        ADMIN_KEY,
        PORT,
        DB_SCHEMA: TEST_SCHEMA
      },
      stdio: 'pipe'
    });
    
    let output = '';
    serverProcess.stdout.on('data', (data) => {
      output += data.toString();
      console.log(`[server] ${data}`);
    });
    
    serverProcess.stderr.on('data', (data) => {
      output += data.toString();
      console.error(`[server] ${data}`);
    });
    
    const ready = await waitForServer();
    if (!ready) {
      serverProcess.kill();
      throw new Error('Server did not start in time');
    }
    
    console.log('Server ready, checking schema...');
    
    // Check that server logged the schema name
    assert.ok(output.includes(`Using DB schema: ${TEST_SCHEMA}`), 
      `Expected output to include "Using DB schema: ${TEST_SCHEMA}"`);
    
    // Query information_schema to confirm tables are in the schema
    const tables = await querySchemaTable(TEST_SCHEMA);
    console.log(`Found tables in schema ${TEST_SCHEMA}:`, tables);
    
    assert.ok(tables.includes('_migrations'), 'Schema should contain _migrations table');
    assert.ok(tables.includes('participants'), 'Schema should contain participants table');
    assert.ok(tables.includes('threads'), 'Schema should contain threads table');
    assert.ok(tables.includes('messages'), 'Schema should contain messages table');
    assert.ok(tables.includes('cursors'), 'Schema should contain cursors table');
    
    // Test that the server actually works
    const res = await fetch(`${BASE_URL}/healthz`);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.db, true);
    
    console.log('✓ DB_SCHEMA test passed: schema created, tables in schema, server functional');
    
    // Cleanup
    serverProcess.kill();
    
    // Drop the test schema
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      console.log(`Dropped test schema ${TEST_SCHEMA}`);
    } finally {
      await client.end();
    }
  });
  
});
