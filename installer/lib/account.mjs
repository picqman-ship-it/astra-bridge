import { Checkpoint, InstallerError } from "./util.mjs";

// Pin both config and environment to this result before any lookup or deploy. Old records
// without an account are deliberately not ownership evidence.
export function resolveAccount({ explicit, env = {}, configured, remembered, accounts = [] }) {
  const selected = explicit ?? env.CLOUDFLARE_ACCOUNT_ID ?? env.CF_ACCOUNT_ID ?? configured ?? remembered
    ?? (accounts.length === 1 ? accounts[0].id : null);
  if (!selected) return null;
  if (!/^[a-f0-9]{32}$/.test(selected)) throw new InstallerError("Cloudflare account id must be 32 lowercase hex characters");
  if (accounts.length && !accounts.some((a) => a.id === selected)) {
    throw new Checkpoint("the selected Cloudflare account is not available to this login", {
      instructions: ["Re-run with --account-id <id> for an account listed by wrangler whoami."],
    });
  }
  return selected;
}

export function ownsDeployment(record, accountId, worker) {
  return Boolean(accountId) && record?.accountId === accountId && record?.worker === worker;
}
