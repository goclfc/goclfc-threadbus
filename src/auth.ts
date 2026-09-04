import { createHash, randomBytes } from 'crypto';
import { pool } from './db.js';
import type { Context } from 'hono';

export interface Participant {
  id: string;
  name: string;
  kind: 'human' | 'agent';
}

export function generateKey(): string {
  return 'tb_' + randomBytes(20).toString('hex');
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export async function authenticate(authHeader: string | undefined): Promise<Participant | null> {
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  
  const key = authHeader.slice(7);
  
  // Check admin key
  if (key === process.env.ADMIN_KEY) {
    return { id: 'admin', name: 'Admin', kind: 'human' };
  }
  
  // Check participant key
  const keyHash = hashKey(key);
  const { rows } = await pool.query(
    'SELECT id, name, kind FROM participants WHERE key_hash = $1',
    [keyHash]
  );
  
  if (rows.length === 0) {
    return null;
  }
  
  // Update last_seen_at
  await pool.query(
    'UPDATE participants SET last_seen_at = NOW() WHERE id = $1',
    [rows[0].id]
  );
  
  return rows[0] as Participant;
}

export function getActingParticipant(c: Context, auth: Participant): string {
  if (auth.id === 'admin') {
    const xAs = c.req.header('x-as');
    if (xAs) {
      return xAs;
    }
  }
  return auth.id;
}

export async function requireAuth(c: Context): Promise<Participant | null> {
  const auth = await authenticate(c.req.header('authorization'));
  if (!auth) {
    c.status(401);
    c.json({ error: 'unauthorized', message: 'Invalid or missing authorization token' });
    return null;
  }
  
  c.header('x-threadbus-participant', auth.id);
  return auth;
}

export async function checkThreadAccess(
  threadId: number, 
  participantId: string
): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM threads WHERE id = $1 AND $2 = ANY(participants)',
    [threadId, participantId]
  );
  return rows.length > 0;
}

export function validateParticipantId(id: string): boolean {
  return /^[a-z0-9-]{2,32}$/.test(id);
}
