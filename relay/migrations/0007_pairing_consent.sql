-- Additive only. Legacy pending sessions lack a browser code and must restart.
-- Raw polling, claim and consent credentials are never stored, only SHA-256 hex.
-- Consent can only ever carry the file-only scope; widening it needs a new migration.
ALTER TABLE pairing_sessions ADD COLUMN claim_code_hash TEXT
  CHECK (claim_code_hash IS NULL OR (length(claim_code_hash) = 64 AND claim_code_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE pairing_sessions ADD COLUMN consent_hash TEXT
  CHECK (consent_hash IS NULL OR (length(consent_hash) = 64 AND consent_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE pairing_sessions ADD COLUMN consent_issuer TEXT;
ALTER TABLE pairing_sessions ADD COLUMN consent_subject TEXT;
ALTER TABLE pairing_sessions ADD COLUMN consent_email TEXT;
ALTER TABLE pairing_sessions ADD COLUMN consent_scope TEXT
  CHECK (consent_scope IS NULL OR consent_scope = 'files-v1');
ALTER TABLE pairing_sessions ADD COLUMN consent_device_id TEXT;
ALTER TABLE pairing_sessions ADD COLUMN consent_agent_public_key_b64 TEXT;
ALTER TABLE pairing_sessions ADD COLUMN consent_created_at_ms INTEGER
  CHECK (consent_created_at_ms IS NULL OR typeof(consent_created_at_ms) = 'integer');
ALTER TABLE pairing_sessions ADD COLUMN consent_expires_at_ms INTEGER
  CHECK (consent_expires_at_ms IS NULL OR typeof(consent_expires_at_ms) = 'integer');
CREATE UNIQUE INDEX idx_pairing_claim_code ON pairing_sessions(claim_code_hash)
  WHERE claim_code_hash IS NOT NULL;
CREATE UNIQUE INDEX idx_pairing_consent ON pairing_sessions(consent_hash)
  WHERE consent_hash IS NOT NULL;
CREATE INDEX idx_pairing_pending_key ON pairing_sessions(agent_public_key_b64, expires_at_ms)
  WHERE status = 'pending';
