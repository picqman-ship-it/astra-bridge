-- Closed-beta registry. Tokens are represented only by SHA-256 lowercase hex
-- digests; this schema deliberately has no plaintext-token or audit-payload fields.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY CHECK (user_id NOT GLOB '*[^A-Za-z0-9._-]*' AND user_id GLOB '[A-Za-z0-9]*' AND length(user_id) BETWEEN 1 AND 96),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY CHECK (device_id NOT GLOB '*[^A-Za-z0-9._-]*' AND device_id GLOB '[A-Za-z0-9]*' AND length(device_id) BETWEEN 1 AND 96),
  owner_id TEXT NOT NULL,
  agent_public_key_b64 TEXT NOT NULL CHECK (length(agent_public_key_b64) BETWEEN 1 AND 1024),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  terminal_enabled INTEGER NOT NULL DEFAULT 0 CHECK (terminal_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (owner_id) REFERENCES users(user_id),
  UNIQUE (device_id, owner_id)
);

CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (owner_id) REFERENCES users(user_id),
  FOREIGN KEY (device_id, owner_id) REFERENCES devices(device_id, owner_id),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

-- These fields intentionally exclude arguments, commands, file content,
-- authorization headers, secrets, private keys, and bearer plaintext.
CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY CHECK (event_id NOT GLOB '*[^A-Za-z0-9._-]*' AND event_id GLOB '[A-Za-z0-9]*' AND length(event_id) BETWEEN 1 AND 96),
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128),
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'succeeded', 'failed')),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(user_id),
  FOREIGN KEY (device_id, owner_id) REFERENCES devices(device_id, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_devices_owner_status ON devices(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_access_tokens_device_status ON access_tokens(device_id, status);
CREATE INDEX IF NOT EXISTS idx_access_tokens_expiry ON access_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_owner_created ON audit_events(owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_device_created ON audit_events(device_id, created_at);
