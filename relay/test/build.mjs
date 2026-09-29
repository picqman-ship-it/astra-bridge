// Bundles the TypeScript sources for Node tests. `cloudflare:workers` and `cloudflare:email`
// only exist in the Workers runtime, so they are mapped to small stubs.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new URL("./stubs/cloudflare-workers.mjs", import.meta.url));
const emailStub = fileURLToPath(new URL("./stubs/cloudflare-email.mjs", import.meta.url));
const cloudflareStub = {
  name: "cloudflare-workers-stub",
  setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: stub }));
    b.onResolve({ filter: /^cloudflare:email$/ }, () => ({ path: emailStub }));
  },
};

const entries = process.argv.slice(2);
for (const entry of entries) {
  const name = entry.replace(/^src\//, "").replace(/\.ts$/, "");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: `.test-tmp/${name}.mjs`,
    plugins: [cloudflareStub],
    logLevel: "warning",
  });
}
