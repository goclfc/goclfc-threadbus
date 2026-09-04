import { pool } from './db.js';

export interface Thread {
  id: number;
  title: string;
  kind?: string;
  status: 'open' | 'resolved' | 'archived';
  waiting_on: string | null;
  participants: string[];
  created_by: string;
  outcome?: string | null;
  seq: number;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id?: number;
  thread_id?: number;
  seq: number;
  author: string;
  body: string;
  attachments?: Record<string, any> | null;
  to: string | null;
  resolved?: boolean;
  created_at: string;
  truncated?: boolean;
}

export interface CreateThreadInput {
  title: string;
  kind?: string;
  to: string;
  body: string;
  participants?: string[];
  attachments?: Record<string, any>;
}

export interface CreateMessageInput {
  body: string;
  to?: string;
  resolve?: boolean;
  outcome?: string;
  reopen?: boolean;
  attachments?: Record<string, any>;
}

const MAX_BODY_SIZE = 32768;
const MAX_ATTACHMENTS_SIZE = 4096;
const MAX_TITLE_SIZE = 120;
const MAX_KIND_SIZE = 32;
const MAX_OUTCOME_SIZE = 280;

export function validateThread(input: CreateThreadInput): string | null {
  if (!input.title || input.title.length > MAX_TITLE_SIZE) {
    return `Title is required and must be ≤${MAX_TITLE_SIZE} characters`;
  }
  if (input.kind && input.kind.length > MAX_KIND_SIZE) {
    return `Kind must be ≤${MAX_KIND_SIZE} characters`;
  }
  if (!input.to) {
    return 'Field "to" is required';
  }
  if (!input.body || input.body.length > MAX_BODY_SIZE) {
    return `Body is required and must be ≤${MAX_BODY_SIZE} characters`;
  }
  if (input.attachments && JSON.stringify(input.attachments).length > MAX_ATTACHMENTS_SIZE) {
    return `Attachments must be ≤${MAX_ATTACHMENTS_SIZE} bytes`;
  }
  if (input.participants) {
    if (input.participants.length < 2 || input.participants.length > 8) {
      return 'Participants must contain 2-8 members';
    }
    if (!input.participants.includes(input.to)) {
      return 'Field "to" must be in participants list';
    }
  }
  return null;
}

export function validateMessage(
  input: CreateMessageInput,
  thread: Thread,
  authorId: string
): string | null {
  if (!input.body || input.body.length > MAX_BODY_SIZE) {
    return `Body is required and must be ≤${MAX_BODY_SIZE} characters`;
  }
  if (input.attachments && JSON.stringify(input.attachments).length > MAX_ATTACHMENTS_SIZE) {
    return `Attachments must be ≤${MAX_ATTACHMENTS_SIZE} bytes`;
  }
  
  // Check thread status
  if (!input.reopen && (thread.status === 'resolved' || thread.status === 'archived')) {
    return `Thread is ${thread.status}`;
  }
  
  // Resolve validation
  if (input.resolve) {
    if (!input.outcome) {
      return 'Field "outcome" is required when resolving';
    }
    if (input.outcome.length > MAX_OUTCOME_SIZE || input.outcome.includes('\n')) {
      return `Outcome must be a single line ≤${MAX_OUTCOME_SIZE} characters`;
    }
    if (input.to) {
      return 'Field "to" is forbidden when resolving';
    }
  } else {
    // Turn validation (not resolving)
    const twoParticipants = thread.participants.length === 2;
    if (!input.to && !twoParticipants) {
      return 'Field "to" is required (thread has more than 2 participants)';
    }
    if (input.to) {
      if (!thread.participants.includes(input.to)) {
        return 'Field "to" must be a thread participant';
      }
      if (input.to === authorId) {
        return 'Cannot pass turn to yourself';
      }
    }
  }
  
  // Reopen validation
  if (input.reopen) {
    if (!input.to) {
      return 'Field "to" is required when reopening';
    }
  }
  
  return null;
}

export async function createThread(
  input: CreateThreadInput,
  createdBy: string
): Promise<Thread> {
  const participants = input.participants || [createdBy, input.to];
  
  // Verify all participants exist
  const { rows: participantRows } = await pool.query(
    'SELECT id FROM participants WHERE id = ANY($1)',
    [participants]
  );
  if (participantRows.length !== participants.length) {
    throw new Error('One or more participants do not exist');
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Create thread
    const { rows: [thread] } = await client.query<Thread>(
      `INSERT INTO threads (title, kind, status, waiting_on, participants, created_by, seq)
       VALUES ($1, $2, 'open', $3, $4, $5, 1)
       RETURNING id, title, kind, status, waiting_on, participants, created_by, outcome, seq, 
                 created_at, updated_at`,
      [input.title, input.kind || null, input.to, participants, createdBy]
    );
    
    // Create first message
    await client.query(
      `INSERT INTO messages (thread_id, seq, author, body, attachments, "to", resolved)
       VALUES ($1, 1, $2, $3, $4, $5, false)`,
      [thread.id, createdBy, input.body, JSON.stringify(input.attachments || null), input.to]
    );
    
    // Initialize cursors for all participants
    for (const p of participants) {
      await client.query(
        'INSERT INTO cursors (thread_id, participant, seen_seq) VALUES ($1, $2, 0)',
        [thread.id, p]
      );
    }
    
    // Advance creator's cursor
    await client.query(
      'UPDATE cursors SET seen_seq = 1 WHERE thread_id = $1 AND participant = $2',
      [thread.id, createdBy]
    );
    
    await client.query('COMMIT');
    return thread;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function createMessage(
  threadId: number,
  input: CreateMessageInput,
  authorId: string,
  idempotencyKey?: string
): Promise<{ message: Message; thread: Partial<Thread> }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Lock and get thread
    const { rows: [thread] } = await client.query<Thread>(
      'SELECT * FROM threads WHERE id = $1 FOR UPDATE',
      [threadId]
    );
    
    if (!thread) {
      throw new Error('Thread not found');
    }
    
    // Check idempotency
    if (idempotencyKey) {
      const { rows: existing } = await client.query<Message>(
        `SELECT id, thread_id, seq, author, body, attachments, "to", resolved, created_at
         FROM messages WHERE thread_id = $1 AND author = $2 AND idempotency_key = $3`,
        [threadId, authorId, idempotencyKey]
      );
      if (existing.length > 0) {
        await client.query('COMMIT');
        return {
          message: existing[0],
          thread: { status: thread.status, waiting_on: thread.waiting_on }
        };
      }
    }
    
    // Determine 'to' field (default to other participant in 2-person threads)
    let to = input.to || null;
    if (!to && !input.resolve && thread.participants.length === 2) {
      to = thread.participants.find(p => p !== authorId) || null;
    }
    
    // Get next seq
    const { rows: [{ seq: newSeq }] } = await client.query<{ seq: number }>(
      'UPDATE threads SET seq = seq + 1, updated_at = NOW() WHERE id = $1 RETURNING seq',
      [threadId]
    );
    
    // Create message
    const { rows: [message] } = await client.query<Message>(
      `INSERT INTO messages (thread_id, seq, author, body, attachments, "to", resolved, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, thread_id, seq, author, body, attachments, "to", resolved, created_at`,
      [
        threadId,
        newSeq,
        authorId,
        input.body,
        JSON.stringify(input.attachments || null),
        to,
        input.resolve || false,
        idempotencyKey || null
      ]
    );
    
    // Update thread status
    let newStatus = thread.status;
    let waitingOn: string | null = to;
    
    if (input.reopen) {
      newStatus = 'open';
    } else if (input.resolve) {
      newStatus = 'resolved';
      waitingOn = null;
      await client.query(
        'UPDATE threads SET outcome = $1 WHERE id = $2',
        [input.outcome, threadId]
      );
    }
    
    await client.query(
      'UPDATE threads SET status = $1, waiting_on = $2, updated_at = NOW() WHERE id = $3',
      [newStatus, waitingOn, threadId]
    );
    
    // Advance author's cursor
    await client.query(
      'UPDATE cursors SET seen_seq = $1 WHERE thread_id = $2 AND participant = $3',
      [newSeq, threadId, authorId]
    );
    
    await client.query('COMMIT');
    return {
      message,
      thread: { status: newStatus, waiting_on: waitingOn }
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const MAX_MESSAGE_INLINE = 8192;
const MAX_ATTACHMENTS_INLINE = 2048;

export function truncateMessage(message: Message, publicUrl?: string): Message {
  const result = { ...message };
  
  if (message.body.length > MAX_MESSAGE_INLINE) {
    result.body = message.body.substring(0, MAX_MESSAGE_INLINE);
    result.truncated = true;
  }
  
  if (message.attachments && 
      JSON.stringify(message.attachments).length > MAX_ATTACHMENTS_INLINE) {
    result.attachments = { truncated: true };
  }
  
  return result;
}

export interface BudgetResult {
  messages: Message[];
  bytes: number;
  truncated: boolean;
}

export function applyBudget(
  messages: Message[],
  maxBytes: number,
  publicUrl?: string
): BudgetResult {
  const result: Message[] = [];
  let bytes = 0;
  let truncated = false;
  
  for (const msg of messages) {
    const processed = truncateMessage(msg, publicUrl);
    const size = JSON.stringify(processed).length;
    
    if (bytes + size > maxBytes) {
      truncated = true;
      break;
    }
    
    result.push(processed);
    bytes += size;
  }
  
  return { messages: result, bytes, truncated };
}
