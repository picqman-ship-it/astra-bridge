-- Explicit post-pairing control permissions for hosted/account-paired Macs.
-- Pairing remains file-only; this table is only changed by a separately signed Mac-side flow.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS device_control_permissions (
  device_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  agent_public_key_b64 TEXT NOT NULL CHECK (length(agent_public_key_b64) BETWEEN 1 AND 1024),
  identity_issuer TEXT NOT NULL CHECK (length(identity_issuer) BETWEEN 1 AND 512),
  identity_subject TEXT NOT NULL CHECK (length(identity_subject) BETWEEN 1 AND 512),
  identity_email TEXT NOT NULL CHECK (length(identity_email) BETWEEN 3 AND 320),
  terminal_enabled INTEGER NOT NULL DEFAULT 0 CHECK (terminal_enabled IN (0, 1)),
  gui_enabled INTEGER NOT NULL DEFAULT 0 CHECK (gui_enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  updated_at_ms INTEGER NOT NULL CHECK (typeof(updated_at_ms) = 'integer'),
  FOREIGN KEY (device_id, owner_id) REFERENCES devices(device_id, owner_id),
  FOREIGN KEY (identity_issuer, identity_subject) REFERENCES user_identities(issuer, subject)
);

CREATE TABLE IF NOT EXISTS control_permission_requests (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) = 36),
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  agent_public_key_b64 TEXT NOT NULL CHECK (length(agent_public_key_b64) BETWEEN 1 AND 1024),
  identity_issuer TEXT NOT NULL CHECK (length(identity_issuer) BETWEEN 1 AND 512),
  identity_subject TEXT NOT NULL CHECK (length(identity_subject) BETWEEN 1 AND 512),
  identity_email TEXT NOT NULL CHECK (length(identity_email) BETWEEN 3 AND 320),
  previous_terminal INTEGER NOT NULL CHECK (previous_terminal IN (0, 1)),
  previous_gui INTEGER NOT NULL CHECK (previous_gui IN (0, 1)),
  previous_version INTEGER NOT NULL CHECK (typeof(previous_version) = 'integer' AND previous_version >= 1),
  requested_terminal INTEGER NOT NULL CHECK (requested_terminal IN (0, 1)),
  requested_gui INTEGER NOT NULL CHECK (requested_gui IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'cancelled')),
  created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer'),
  expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms > created_at_ms),
  applied_at_ms INTEGER CHECK (applied_at_ms IS NULL OR typeof(applied_at_ms) = 'integer'),
  FOREIGN KEY (owner_id) REFERENCES users(user_id),
  FOREIGN KEY (device_id, owner_id) REFERENCES devices(device_id, owner_id),
  FOREIGN KEY (identity_issuer, identity_subject) REFERENCES user_identities(issuer, subject),
  CHECK (requested_terminal <> previous_terminal OR requested_gui <> previous_gui),
  CHECK ((status = 'applied' AND applied_at_ms IS NOT NULL AND applied_at_ms >= created_at_ms AND applied_at_ms < expires_at_ms) OR (status <> 'applied' AND applied_at_ms IS NULL))
);

CREATE UNIQUE INDEX idx_control_pending_device
  ON control_permission_requests(device_id) WHERE status = 'pending';
CREATE INDEX idx_control_request_expiry
  ON control_permission_requests(expires_at_ms, status);


-- Applying consent and changing authority must be one atomic database statement.
-- A failed or ignored permission UPDATE aborts the request transition as well;
-- returning no rows to JavaScript after a committed batch cannot provide rollback.
CREATE TRIGGER control_permission_apply
AFTER UPDATE OF status ON control_permission_requests
WHEN OLD.status = 'pending' AND NEW.status = 'applied'
BEGIN
  UPDATE device_control_permissions
  SET terminal_enabled = NEW.requested_terminal,
      gui_enabled = NEW.requested_gui,
      version = version + 1,
      updated_at_ms = NEW.applied_at_ms
  WHERE device_id = NEW.device_id AND owner_id = NEW.owner_id
    AND terminal_enabled = NEW.previous_terminal AND gui_enabled = NEW.previous_gui
    AND version = NEW.previous_version
    AND agent_public_key_b64 = NEW.agent_public_key_b64
    AND identity_issuer = NEW.identity_issuer AND identity_subject = NEW.identity_subject
    AND identity_email = NEW.identity_email
    AND EXISTS (
      SELECT 1 FROM devices d JOIN users u ON u.user_id = d.owner_id
      WHERE d.device_id = NEW.device_id AND d.owner_id = NEW.owner_id
        AND d.agent_public_key_b64 = NEW.agent_public_key_b64
        AND d.status = 'active' AND d.revoked_at IS NULL AND u.status = 'active'
    )
    AND EXISTS (
      SELECT 1 FROM user_identities i
      WHERE i.owner_id = NEW.owner_id AND i.issuer = NEW.identity_issuer
        AND i.subject = NEW.identity_subject AND i.email = NEW.identity_email AND i.status = 'active'
    )
    AND (SELECT COUNT(*) FROM user_identities i
      WHERE i.owner_id = NEW.owner_id AND i.status = 'active') = 1;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'control_permission_conflict') END;
END;
