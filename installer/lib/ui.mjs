// Terminal output and prompts. Interactive only when stdin is a terminal and --non-interactive
// was not given; otherwise every question either has an explicit flag or becomes a checkpoint.

import readline from "node:readline";
import { Checkpoint } from "./util.mjs";

export function createUi({ interactive, yes = false, out = process.stdout, input = process.stdin, color = out.isTTY && !process.env.NO_COLOR } = {}) {
  const paint = (code, s) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const write = (s = "") => out.write(`${s}\n`);

  // One readline session, created on the first question. Lines that arrive before a question
  // is asked (a multi-line paste) are queued, not dropped. Ctrl-C at a prompt ends the run as a
  // checkpoint (readline would otherwise just pause the input and hang).
  let rl = null;
  const queue = [];
  let waiting = null;
  const stop = (reason) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w.reject(new Checkpoint(reason));
    }
  };
  function session() {
    if (rl) return rl;
    rl = readline.createInterface({ input, output: out, terminal: Boolean(input.isTTY) });
    rl.on("line", (line) => {
      if (waiting) {
        const w = waiting;
        waiting = null;
        w.resolve(line.trim());
      } else queue.push(line.trim());
    });
    rl.on("SIGINT", () => {
      out.write("\n");
      stop("stopped with Ctrl-C");
      release();
    });
    rl.on("close", () => {
      rl = null;
      stop("no answer (input closed)");
    });
    return rl;
  }
  function question(prompt) {
    if (queue.length) {
      write(`${prompt}${queue[0]}`);
      return Promise.resolve(queue.shift());
    }
    const r = session();
    return new Promise((resolve, reject) => {
      waiting = { resolve, reject };
      r.setPrompt(prompt);
      r.prompt();
    });
  }
  /** Gives the terminal back (raw mode off) before a child process that reads it runs. */
  function release() {
    if (rl) {
      const r = rl;
      rl = null;
      r.removeAllListeners("close");
      r.close();
    }
  }

  return {
    interactive,
    yes,
    write,
    release,
    heading: (s) => write(`\n${paint("1", `== ${s}`)}`),
    info: (s) => write(`   ${s}`),
    ok: (s) => write(`${paint("32", "  ✓")} ${s}`),
    warn: (s) => write(`${paint("33", "  !")} ${s}`),
    fail: (s) => write(`${paint("31", "  ✗")} ${s}`),
    danger(lines) {
      write("");
      for (const l of lines) write(paint("1;31", `  !! ${l}`));
      write("");
    },

    /**
     * Asks for a value. Non-interactive: returns `fallback` if given, else stops at a checkpoint
     * telling the user which flag to pass. `validate` normalizes or throws a message.
     */
    async ask(label, { fallback, flag, validate = (v) => v, defaultValue } = {}) {
      if (fallback !== undefined && fallback !== null) return validate(fallback);
      if (!interactive) {
        throw new Checkpoint(`${label} is needed`, { instructions: [`Re-run with ${flag} <value>.`] });
      }
      for (;;) {
        const value = (await question(`   ${label}${defaultValue ? ` [${defaultValue}]` : ""}: `)) || defaultValue || "";
        if (!value) continue;
        try {
          return validate(value);
        } catch (err) {
          write(`   ${paint("33", err.message)}`);
        }
      }
    },

    /** Yes/no. Non-interactive: --yes means yes; without it, a checkpoint naming --yes. */
    async confirm(prompt, { defaultYes = true, what } = {}) {
      if (yes) return true;
      if (!interactive) {
        throw new Checkpoint(`confirmation needed: ${what ?? prompt}`, {
          instructions: ["Re-run in a terminal to answer interactively, or add --yes to accept this step."],
        });
      }
      const answer = (await question(`   ${prompt} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
      if (!answer) return defaultYes;
      return answer === "y" || answer === "yes";
    },

    /** Requires typing `expected` exactly (for risky opt-ins and destructive cleanup). */
    async typed(prompt, expected) {
      if (!interactive) return false;
      return (await question(`   ${prompt} Type "${expected}" to confirm: `)) === expected;
    },
  };
}
