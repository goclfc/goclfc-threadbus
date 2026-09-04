import pg from 'pg';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

const { Pool } = pg;

// Get DATABASE_URL with fallback to *_DATABASE_URL
function getDatabaseUrl(): { url: string; source: string } {
  if (process.env.DATABASE_URL) {
    return { url: process.env.DATABASE_URL, source: 'DATABASE_URL' };
  }
  
  // Find first env var ending with _DATABASE_URL
  for (const key of Object.keys(process.env)) {
    if (key.endsWith('_DATABASE_URL')) {
      return { url: process.env[key]!, source: key };
    }
  }
  
  throw new Error('DATABASE_URL not found');
}

// Validate DB_SCHEMA name
function validateSchemaName(schema: string): boolean {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(schema);
}

const dbConfig = getDatabaseUrl();
const dbSchema = process.env.DB_SCHEMA;

if (dbSchema && !validateSchemaName(dbSchema)) {
  throw new Error(`Invalid DB_SCHEMA: must match ^[a-z_][a-z0-9_]{0,62}$`);
}

const poolOptions: any = {
  connectionString: dbConfig.url,
  max: 20,
};

// Set search_path if DB_SCHEMA is specified
if (dbSchema) {
  poolOptions.options = `-c search_path=${dbSchema}`;
}

export const pool = new Pool(poolOptions);

export function getDbSource(): string {
  return dbConfig.source;
}

export function getDbSchema(): string | undefined {
  return dbSchema;
}

export async function migrate() {
  const migrationsDir = join(process.cwd(), 'migrations');
  
  const client = await pool.connect();
  try {
    // Create schema if DB_SCHEMA is set
    if (dbSchema) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${dbSchema}`);
    }
    
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
