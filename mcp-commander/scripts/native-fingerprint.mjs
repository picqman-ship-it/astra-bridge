import crypto from 'node:crypto';

// Shared with regression tests; native caching must include the target and build recipe.
export function nativeFingerprint({ source, recipe, compiler, version, sdk, sdkVersion, flags,
  arch = process.arch, platform = process.platform, node = process.version }) {
  return crypto.createHash('sha256').update(source).update(recipe)
    .update(JSON.stringify({ compiler, version, sdk, sdkVersion, flags, arch, platform, node })).digest('hex');
}
