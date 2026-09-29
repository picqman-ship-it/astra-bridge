#!/usr/bin/env node
import './bootstrap.js';
import { createCommanderServer } from './server.js';
import { serveStdio } from './stdio-lifecycle.js';
import { VERSION } from './version.js';

function parseArgs(argv: string[]): { configDir?: string } {
  const out: { configDir?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version' || a === '-v') {
      process.stderr.write(`mcp-commander ${VERSION}\n`);
      process.exit(0);
    } else if (a === '--help' || a === '-h') {
      process.stderr.write(
        'mcp-commander — MCP server for terminal, process, file and search tools (stdio transport)\n\n' +
          'Usage: mcp-commander [--config-dir <dir>]\n\n' +
          '  --config-dir <dir>  where config.json lives (default ~/.mcp-commander, or $MCP_COMMANDER_CONFIG_DIR)\n',
      );
      process.exit(0);
    } else if (a === '--config-dir') {
      // An empty value would put config.json in the current directory; use the default instead.
      out.configDir = argv[++i] || undefined;
    } else if (a.startsWith('--config-dir=')) {
      out.configDir = a.slice('--config-dir='.length) || undefined;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const commander = createCommanderServer(parseArgs(process.argv.slice(2)));
  await serveStdio(commander, 'mcp-commander', `${VERSION} ready (config: ${commander.config.file})`);
}

main().catch((err) => {
  console.error('[mcp-commander] fatal:', err);
  process.exit(1);
});
