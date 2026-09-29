# Third-party notices

## Desktop Commander MCP

`mcp-commander/` is an independent reimplementation of the core ideas of [Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) (tool names, parameters and output formats are kept compatible). Some portions are derived from Desktop Commander and used under the MIT License:

- the fuzzy-search algorithm in `mcp-commander/src/tools/fuzzy.ts`;
- model-facing message and output formats in `mcp-commander/src/tools/{edit,filesystem,terminal,search}.ts`, `mcp-commander/src/files/{lines,read}.ts` and `mcp-commander/src/server.ts`;
- the default `blockedCommands` list in `mcp-commander/src/config.ts`.

Desktop Commander's MIT licence text and copyright notice are reproduced in full in [`mcp-commander/LICENSE`](mcp-commander/LICENSE).

## Runtime dependencies

Installed through npm and not vendored in this repository; each keeps its own licence:

- `@modelcontextprotocol/sdk`, `ws`, `jose`, `zod`, `@vscode/ripgrep` — MIT
- `wrangler`, `@cloudflare/workers-types` — MIT OR Apache-2.0
- `typescript` — Apache-2.0

The macOS Accessibility helper (`mcp-commander/native/ax-helper.swift`) links only Apple system frameworks.
