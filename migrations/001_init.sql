-- ThreadBus v0.1 Initial Schema

CREATE TABLE IF NOT EXISTS _migrations (
    name VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS participants (
    id VARCHAR(32) PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,32}$'),
    name VARCHAR(255) NOT NULL,
    kind VARCHAR(10) NOT NULL CHECK (kind IN ('human', 'agent')),
    key_hash VARCHAR(128) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS threads (
    id SERIAL PRIMARY KEY,
    title VARCHAR(120) NOT NULL,
    kind VARCHAR(32),
    status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'archived')),
    waiting_on VARCHAR(32) REFERENCES participants(id),
    participants TEXT[] NOT NULL CHECK (array_length(participants, 1) BETWEEN 2 AND 8),
    created_by VARCHAR(32) NOT NULL REFERENCES participants(id),
    outcome VARCHAR(280),
    seq INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_threads_waiting_status_updated 
    ON threads (waiting_on, status, updated_at);

CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    author VARCHAR(32) NOT NULL REFERENCES participants(id),
    body TEXT NOT NULL CHECK (length(body) <= 32768),
    attachments JSONB,
    "to" VARCHAR(32) REFERENCES participants(id),
    resolved BOOLEAN NOT NULL DEFAULT false,
    idempotency_key VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (thread_id, seq),
    UNIQUE (thread_id, author, idempotency_key)
);

CREATE INDEX idx_messages_thread_seq ON messages (thread_id, seq);

CREATE TABLE IF NOT EXISTS cursors (
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    participant VARCHAR(32) NOT NULL REFERENCES participants(id),
    seen_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, participant)
);

-- Insert the migration record
INSERT INTO _migrations (name) VALUES ('001_init.sql');
