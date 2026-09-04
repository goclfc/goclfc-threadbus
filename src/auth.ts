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
  
  // Check viewer key: read-only principal for dashboards. Never a DB row.
  if (isViewerKey(key)) {
    return { id: VIEWER_ID, name: 'Viewer', kind: 'human' };
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
    // Assigning c.res finalizes the context, so the handler's bare
    // `return` after this sends the 401 instead of leaving Hono with
    // nothing to send (which surfaced as a 500).
    c.res = c.json({ error: 'unauthorized', message: 'Invalid or missing authorization token' }, 401);
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

// Principals that exist only as env keys, never as participants rows.
export const ADMIN_ID = 'admin';
export const VIEWER_ID = 'viewer';
const RESERVED_IDS = new Set([ADMIN_ID, VIEWER_ID]);

export function validateParticipantId(id: string): boolean {
  return /^[a-z0-9-]{2,32}$/.test(id) && !RESERVED_IDS.has(id);
}

export function isViewerKey(key: string | undefined): boolean {
  const viewerKey = process.env.VIEWER_KEY;
  return !!viewerKey && viewerKey.length >= 24 && key === viewerKey;
}

// Everything the viewer key may touch. GET only; it can never write.
const VIEWER_ROUTES = [
  /^\/$/, /^\/healthz$/, /^\/openapi\.json$/, /^\/ui$/,
  /^\/feed$/, /^\/threads$/, /^\/threads\/\d+$/, /^\/threads\/\d+\/messages\/\d+$/,
];

export function viewerMayAccess(method: string, path: string): boolean {
  return (method === 'GET' || method === 'HEAD') && VIEWER_ROUTES.some(r => r.test(path));
}

// True for principals that read everything and own no cursor: admin (when not
// acting as someone) and viewer.
export function isReadAllPrincipal(c: Context, auth: Participant): boolean {
  if (auth.id === VIEWER_ID) return true;
  return auth.id === ADMIN_ID && !c.req.header('x-as');
}
