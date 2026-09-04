import { createHash } from 'crypto';
import { pool } from './db.js';
import type { Thread, Message } from './threads.js';
import { applyBudget } from './threads.js';

export function computeEtag(participantId: string, maxUpdatedAt: Date | null): string {
  const value = `${participantId}:${maxUpdatedAt?.toISOString() || 'none'}`;
  return createHash('sha1').update(value).digest('hex');
}

export interface NextThread extends Thread {
  unread: number;
  messages: Message[];
}

export async function getNext(
  participantId: string,
  kind?: string,
  limit: number = 1,
  full: boolean = false
): Promise<{ threads: NextThread[]; etag: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Get threads where waiting_on = participant
    let query = `
      SELECT t.*, c.seen_seq
      FROM threads t
      LEFT JOIN cursors c ON c.thread_id = t.id AND c.participant = $1
      WHERE t.status = 'open' AND t.waiting_on = $1
    `;
    const params: any[] = [participantId];
    
    if (kind) {
      query += ` AND t.kind = $2`;
      params.push(kind);
    }
    
    query += ` ORDER BY t.updated_at ASC LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const { rows: threadRows } = await client.query(query, params);
    
    // Compute etag from all open threads (not just the limited ones)
    const { rows: [{ max: maxUpdated }] } = await client.query(
      `SELECT MAX(updated_at) as max FROM threads 
       WHERE status = 'open' AND waiting_on = $1`,
      [participantId]
    );
    const etag = computeEtag(participantId, maxUpdated);
    
    const threads: NextThread[] = [];
    
    for (const row of threadRows) {
      const seenSeq = row.seen_seq || 0;
      const sinceSeq = full ? 0 : seenSeq;
      
      // Get messages
      const { rows: messages } = await client.query<Message>(
        `SELECT id, thread_id, seq, author, body, attachments, "to", resolved, created_at
         FROM messages 
         WHERE thread_id = $1 AND seq > $2
         ORDER BY seq ASC`,
        [row.id, sinceSeq]
      );
      
      // Advance cursor
      await client.query(
        `INSERT INTO cursors (thread_id, participant, seen_seq)
         VALUES ($1, $2, $3)
         ON CONFLICT (thread_id, participant) 
         DO UPDATE SET seen_seq = $3`,
        [row.id, participantId, row.seq]
      );
      
      threads.push({
        id: row.id,
        title: row.title,
        kind: row.kind,
        status: row.status,
        waiting_on: row.waiting_on,
        participants: row.participants,
        created_by: row.created_by,
        outcome: row.outcome,
        seq: row.seq,
        created_at: row.created_at,
        updated_at: row.updated_at,
        unread: messages.length,
        messages
      });
    }
    
    await client.query('COMMIT');
    return { threads, etag };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface InboxThread {
  id: number;
  title: string;
  kind: string | null;
  status: string;
  waiting_on: string | null;
  unread: number;
  seq: number;
  updated_at: string;
  last_author: string;
  outcome?: string | null;
}

export async function getInbox(
  participantId: string,
  status?: string,
  since?: string,
  limit: number = 20
): Promise<{ threads: InboxThread[]; etag: string }> {
  let query = `
    SELECT 
      t.id, t.title, t.kind, t.status, t.waiting_on, t.seq, t.updated_at, t.outcome,
      COALESCE(c.seen_seq, 0) as seen_seq,
      (SELECT author FROM messages WHERE thread_id = t.id ORDER BY seq DESC LIMIT 1) as last_author
    FROM threads t
    LEFT JOIN cursors c ON c.thread_id = t.id AND c.participant = $1
    WHERE $1 = ANY(t.participants)
  `;
  const params: any[] = [participantId];
  
  if (status) {
    query += ` AND t.status = $${params.length + 1}`;
    params.push(status);
  } else {
    query += ` AND t.status = 'open'`;
  }
  
  if (since) {
    query += ` AND t.updated_at >= $${params.length + 1}`;
    params.push(since);
  }
  
  query += ` ORDER BY t.updated_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  
  const { rows } = await pool.query(query, params);
  
  // Compute etag
  const { rows: [{ max: maxUpdated }] } = await pool.query(
    `SELECT MAX(updated_at) as max FROM threads WHERE $1 = ANY(participants)`,
    [participantId]
  );
  const etag = computeEtag(participantId, maxUpdated);
  
  const threads: InboxThread[] = rows.map(row => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    waiting_on: row.waiting_on,
    unread: Math.max(0, row.seq - row.seen_seq),
    seq: row.seq,
    updated_at: row.updated_at,
    last_author: row.last_author,
    ...(row.outcome && { outcome: row.outcome })
  }));
  
  return { threads, etag };
}

export interface DigestThread {
  id: number;
  kind: string | null;
  status: string;
  from: string;
  to: string | null;
  waiting_on?: string | null;
  title?: string;
  outcome?: string | null;
  time: string;
  last_author?: string;
}

export async function getDigest(
  participantId: string,
  since?: string,
  format: 'json' | 'text' = 'json'
): Promise<{ threads: DigestThread[] }> {
  const sinceDate = since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  
  const { rows } = await pool.query(
    `SELECT 
       t.id, t.kind, t.status, t.created_by, t.waiting_on, t.title, t.outcome, t.updated_at,
       (SELECT author FROM messages WHERE thread_id = t.id ORDER BY seq DESC LIMIT 1) as last_author
     FROM threads t
     WHERE $1 = ANY(t.participants) AND t.updated_at >= $2
     ORDER BY t.updated_at DESC`,
    [participantId, sinceDate]
  );
  
  const threads: DigestThread[] = rows.map(row => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    from: row.created_by,
    to: row.waiting_on,
    waiting_on: row.waiting_on,
    title: row.title,
    outcome: row.outcome,
    time: new Date(row.updated_at).toISOString(),
    last_author: row.last_author
  }));
  
  return { threads };
}

export function formatDigestText(threads: DigestThread[]): string {
  return threads.map(t => {
    const time = new Date(t.time).toISOString().substring(11, 16);
    const kindStr = (t.kind || 'thread').padEnd(10);
    const statusStr = t.status.padEnd(9);
    
    let action: string;
    if (t.status === 'resolved') {
      action = `${t.from}→${t.to || 'resolved'}`;
    } else if (t.status === 'open') {
      action = `waiting_on ${t.waiting_on}`;
    } else {
      action = t.status;
    }
    
    const detail = t.status === 'resolved' && t.outcome 
      ? `"${t.outcome}"`
      : t.last_author ? `last: ${t.last_author}` : '';
    
    return `#${t.id} ${kindStr} ${statusStr} ${action.padEnd(25)} ${detail.padEnd(50)} ${time}`;
  }).join('\n');
}
