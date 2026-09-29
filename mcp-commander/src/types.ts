import type { ZodRawShape, z } from 'zod';
import type { ConfigSource } from './config.js';

/** One content block of a tool result (the MCP CallToolResult content subset we use). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * A tool definition. Modules export arrays of these; server.ts registers them with the SDK and
 * wraps every handler with error handling, unknown-parameter warnings and call history.
 * Handlers may return a plain string (becomes one text block) or a full ToolResult, and may
 * throw — a thrown Error becomes `Error: <message>` with isError: true.
 */
export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputSchema: S;
  annotations?: ToolAnnotations;
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult | string> | ToolResult | string;
}

/** Shared services handed to every tool module. */
export interface ToolContext {
  config: ConfigSource;
  /** Client name/version reported in the MCP initialize handshake (may be undefined early). */
  getClientInfo: () => { name: string; version: string } | undefined;
}

export function defineTool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message.startsWith('Error') ? message : `Error: ${message}` }], isError: true };
}

/** Thrown by handlers for expected, user-facing failures (message is shown verbatim). */
export class ToolError extends Error {}
