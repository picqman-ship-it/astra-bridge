-- Authorization grants contain only SHA-256 digests, never invite secrets.
-- Integer millisecond timestamps; maximum lifetime 24 hours.
CREATE TABLE enrollment_invites (
  invite_hash TEXT PRIMARY KEY CHECK (length(invite_hash) = 64 AND invite_hash NOT GLOB '*[^0-9a-f]*'),
  owner_id TEXT NOT NULL REFERENCES users(user_id),
  created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms > created_at_ms AND expires_at_ms <= created_at_ms + 86400000),
  revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR typeof(revoked_at_ms) = 'integer'),
  redeemed_at_ms INTEGER CHECK (redeemed_at_ms IS NULL OR typeof(redeemed_at_ms) = 'integer'),
  redeemed_device_id TEXT,
  redemption_id TEXT UNIQUE,
  CHECK ((redeemed_at_ms IS NULL AND redeemed_device_id IS NULL AND redemption_id IS NULL)
    OR (redeemed_at_ms IS NOT NULL AND redeemed_device_id IS NOT NULL AND redemption_id IS NOT NULL))
);
CREATE INDEX idx_enrollment_invites_owner ON enrollment_invites(owner_id);
