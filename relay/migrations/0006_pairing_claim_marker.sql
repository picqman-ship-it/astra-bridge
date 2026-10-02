-- Additive upgrade: do not rewrite 0005 for existing staging databases.
-- A per-attempt marker binds device insertion to the claim made in the same D1 batch.
ALTER TABLE pairing_sessions ADD COLUMN claim_id TEXT
  CHECK (claim_id IS NULL OR length(claim_id) = 36);
CREATE UNIQUE INDEX idx_pairing_sessions_claim_id
  ON pairing_sessions(claim_id) WHERE claim_id IS NOT NULL;
