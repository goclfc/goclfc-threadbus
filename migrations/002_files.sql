-- ThreadBus v0.2: shared files (objects live in S3-compatible storage, rows here)

CREATE TABLE IF NOT EXISTS files (
    id VARCHAR(32) PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    content_type VARCHAR(120) NOT NULL,
    size INTEGER NOT NULL,
    object_key VARCHAR(255) NOT NULL UNIQUE,
    uploaded_by VARCHAR(32) NOT NULL,
    thread_id INTEGER REFERENCES threads(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_files_thread ON files (thread_id);

INSERT INTO _migrations (name) VALUES ('002_files.sql');
