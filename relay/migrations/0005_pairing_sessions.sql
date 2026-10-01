-- Short-lived one-time pairing sessions for binding an authenticated Astra user
-- to a Mac key. Only a SHA-256 hash of the pairing secret is stored.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pairing_sessions (
  secret_hash TEXT PRIMARY KEY
    CHECK (length(secret_hash) = 64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
  request_id TEXT NOT NULL UNIQUE
    CHECK (length(request_id) BETWEEN 1 AND 96),
  device_id TEXT NOT NULL UNIQUE,
  agent_public_key_b64 TEXT NOT NULL
    CHECK (length(agent_public_key_b64) BETWEEN 1 AND 1024),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'claimed', 'cancelled')),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER,
  owner_id TEXT,
  FOREIGN KEY (owner_id) REFERENCES users(user_id),
  CHECK (expires_at_ms > created_at_ms),
  CHECK (
    (status = 'pending' AND claimed_at_ms IS NULL AND owner_id IS NULL)
    OR (status = 'claimed' AND claimed_at_ms IS NOT NULL AND owner_id IS NOT NULL)
    OR status = 'cancelled'
  )
);

CREATE INDEX IF NOT EXISTS idx_pairing_sessions_expiry
  ON pairing_sessions(expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_pairing_sessions_owner_status
  ON pairing_sessions(owner_id, status);
