-- Pre-rollout invariant. Existing duplicates intentionally make migration fail;
-- inspect and revoke/reconcile them before rollout, never silently pick an owner.
CREATE UNIQUE INDEX idx_devices_unique_agent_key ON devices(agent_public_key_b64);
