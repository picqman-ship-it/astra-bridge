/**
 * Imported first by index.ts. stdout carries the JSON-RPC stream, so a single stray
 * console.log from any module would corrupt the protocol. Route all console output to stderr
 * before anything else is evaluated (ES modules evaluate imports in order).
 */
const toStderr = (...args: unknown[]) => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;

// Parallel fs calls on slow (cloud-synced / network) folders can exhaust libuv's default pool of 4.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

export {};
