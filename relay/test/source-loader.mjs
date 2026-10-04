// Node 22.15+/24 test-only resolution for dependency-free TypeScript source tests.
// This does not stub production dependencies or replace typechecking.
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts") && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
