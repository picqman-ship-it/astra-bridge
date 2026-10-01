-- Bind an authenticated external identity (for example a Cloudflare Access
-- subject) to an Astra owner. Authorization is keyed by issuer + subject, not email.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user_identities (
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 512),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
  owner_id TEXT NOT NULL,
  email TEXT CHECK (email IS NULL OR length(email) BETWEEN 3 AND 320),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (issuer, subject),
  FOREIGN KEY (owner_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_identities_owner_status
  ON user_identities(owner_id, status);
