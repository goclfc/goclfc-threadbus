import pg from 'pg';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});

export async function migrate() {
  const migrationsDir = join(process.cwd(), 'migrations');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Ensure migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    
    // Get applied migrations
    const { rows: applied } = await client.query(
      'SELECT name FROM _migrations ORDER BY name'
    );
    const appliedSet = new Set(applied.map(r => r.name));
    
    // Get all migration files
    const files = await readdir(migrationsDir);
    const sqlFiles = files
      .filter(f => f.endsWith('.sql'))
      .sort();
    
    // Apply pending migrations
    for (const file of sqlFiles) {
      if (appliedSet.has(file)) {
        console.log(`Migration ${file} already applied`);
        continue;
      }
      
      console.log(`Applying migration ${file}...`);
      const sql = await readFile(join(migrationsDir, file), 'utf-8');
      await client.query(sql);
      console.log(`Migration ${file} applied`);
    }
    
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function testConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
