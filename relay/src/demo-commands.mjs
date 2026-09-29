// The review demo never runs a shell. start_process and job_start accept only this
// grammar, and every command is simulated in-process by the demo runtime.
//
//   pwd
//   node --version | node -v
//   echo [text]          text: letters, digits, spaces and . , : _ - + = @ % / only
//   sleep <seconds>      0-30, at most three decimals

import { DEMO_COMMAND_HELP } from "./demo-tools.mjs";

export const MAX_COMMAND_CHARS = 200;
export const MAX_SLEEP_SECONDS = 30;
// Fixed value: the demo never executes node, so it cannot report the host's version.
export const DEMO_NODE_VERSION = "v22.12.0";
export const DEMO_NODE_VERSION_OUTPUT = `${DEMO_NODE_VERSION} (astra-bridge review demo: fixed value, node was not executed)`;

const ECHO_TEXT = /^[A-Za-z0-9 .,:_\-+=@%/]*$/;
const SLEEP_ARG = /^\d{1,2}(\.\d{1,3})?$/;

export class CommandRefused extends Error {}

function refuse(reason) {
  return new CommandRefused(
    `Demo policy: command refused (${reason}). The review demo agent simulates only: ${DEMO_COMMAND_HELP}. `
      + "No shell, pipes, redirects, substitution, network, filesystem or other programs are available.",
  );
}

/**
 * Parses a command line into a simulated step, or throws CommandRefused.
 * Returns { kind: "pwd" } | { kind: "node_version" } | { kind: "echo", text } | { kind: "sleep", ms }.
 */
export function parseDemoCommand(command) {
  if (typeof command !== "string") throw refuse("command must be a string");
  if (command.length > MAX_COMMAND_CHARS) throw refuse(`longer than ${MAX_COMMAND_CHARS} characters`);
  const line = command.trim();
  if (!line) throw refuse("empty command");
  if (/[\r\n\0]/.test(line)) throw refuse("multi-line input");
  if (/[|]/.test(line)) throw refuse("pipes are not supported");
  if (/[<>]/.test(line)) throw refuse("redirects are not supported");
  if (/[$`]/.test(line)) throw refuse("substitution and variables are not supported");
  if (/[;&]/.test(line)) throw refuse("command chaining and background jobs are not supported");
  if (/[(){}[\]*?~!\\'"#]/.test(line)) throw refuse("shell syntax is not supported");

  const words = line.split(/\s+/);
  const [name, ...args] = words;
  switch (name) {
    case "pwd":
      if (args.length) throw refuse("pwd takes no arguments");
      return { kind: "pwd" };
    case "node":
      if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) return { kind: "node_version" };
      throw refuse("only 'node --version' is available");
    case "echo": {
      const text = line.slice(4).trim();
      if (!ECHO_TEXT.test(text)) throw refuse("echo text may contain only letters, digits, spaces and . , : _ - + = @ % /");
      return { kind: "echo", text: args.join(" ") };
    }
    case "sleep": {
      if (args.length !== 1 || !SLEEP_ARG.test(args[0])) throw refuse(`sleep needs one number of seconds (0-${MAX_SLEEP_SECONDS})`);
      const seconds = Number(args[0]);
      if (!(seconds >= 0 && seconds <= MAX_SLEEP_SECONDS)) throw refuse(`sleep is limited to ${MAX_SLEEP_SECONDS} seconds`);
      return { kind: "sleep", ms: Math.round(seconds * 1000) };
    }
    default:
      throw refuse(`'${name.slice(0, 40)}' is not part of the demo grammar`);
  }
}

/** Output of a finished simulated command (sleep prints nothing). */
export function simulatedOutput(step, cwd) {
  switch (step.kind) {
    case "pwd": return `${cwd}\n`;
    case "node_version": return `${DEMO_NODE_VERSION_OUTPUT}\n`;
    case "echo": return `${step.text}\n`;
    default: return "";
  }
}
