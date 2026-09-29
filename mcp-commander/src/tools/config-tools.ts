import os from 'node:os';
import { z } from 'zod';
import { CONFIG_FIELDS, CONFIG_KEYS, type ConfigKey } from '../config.js';
import { defineTool, errorResult, type ToolContext } from '../types.js';
import { VERSION } from '../version.js';

function systemInfo(ctx: ToolContext) {
  const mem = process.memoryUsage();
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeVersion: process.versions.node,
    pathSeparator: process.platform === 'win32' ? '\\' : '/',
    homeDir: os.homedir(),
    serverCwd: process.cwd(),
    serverPid: process.pid,
    memoryRss: `${(mem.rss / 1024 / 1024).toFixed(2)} MB`,
    currentClient: ctx.getClientInfo() ?? { name: 'uninitialized', version: 'uninitialized' },
  };
}

export function configTools(ctx: ToolContext) {
  return [
    defineTool({
      name: 'get_config',
      description:
        'Get the complete server configuration as JSON: blockedCommands, allowedDirectories, defaultShell, ' +
        'fileReadLineLimit, fileWriteLineLimit, plus system information (OS, shell, Node version, server cwd, client).',
      inputSchema: {},
      annotations: { title: 'Get Configuration', readOnlyHint: true },
      handler: () => {
        const payload = {
          ...ctx.config.get(),
          version: VERSION,
          configFile: ctx.config.file,
          ...(ctx.config.loadError ? { configWarning: ctx.config.loadError } : {}),
          systemInfo: systemInfo(ctx),
        };
        return `Current configuration:\n${JSON.stringify(payload, null, 2)}`;
      },
    }),
    defineTool({
      name: 'set_config_value',
      description:
        `Set one configuration value. Allowed keys: ${CONFIG_KEYS.join(', ')}.\n` +
        CONFIG_KEYS.map((k) => `- ${k} (${CONFIG_FIELDS[k].valueType}): ${CONFIG_FIELDS[k].description}`).join('\n') +
        '\nArrays may be given as JSON arrays or JSON array strings (blockedCommands also accepts "rm, sudo"; ' +
        'a plain string for allowedDirectories is one path). An array value replaces the whole list. ' +
        'Changes apply immediately. ' +
        'allowedDirectories = [] means FULL filesystem access for the file tools. ' +
        'Only change security settings (blockedCommands, allowedDirectories) when the user explicitly asks.',
      inputSchema: {
        key: z.string().describe(`One of: ${CONFIG_KEYS.join(', ')}`),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]).describe('New value'),
      },
      annotations: { title: 'Set Configuration Value', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: ({ key, value }) => {
        if (!(CONFIG_KEYS as string[]).includes(key)) {
          return errorResult(
            `Key "${key}" is not configurable via this tool. Allowed keys: ${CONFIG_KEYS.join(', ')}`,
          );
        }
        const updated = ctx.config.set(key as ConfigKey, value);
        return (
          `Successfully set ${key} to ${JSON.stringify(updated[key as ConfigKey], null, 2)}\n\n` +
          `Updated configuration:\n${JSON.stringify(updated, null, 2)}`
        );
      },
    }),
  ];
}
