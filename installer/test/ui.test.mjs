import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createUi } from "../lib/ui.mjs";
import { Checkpoint } from "../lib/util.mjs";
import { validateEmail } from "../lib/validate.mjs";

function interactiveUi(lines) {
  const input = new PassThrough();
  const out = new PassThrough();
  let text = "";
  out.on("data", (c) => (text += c));
  const ui = createUi({ interactive: true, input, out, color: false });
  input.write(lines.map((l) => `${l}\n`).join(""));
  return { ui, input, output: () => text };
}

test("prompts: invalid answers are re-asked, pasted lines are not lost, defaults apply", async () => {
  const { ui, output } = interactiveUi(["not-an-email", "Owner@Corp.Test", "", "n", "enable", "nope"]);
  assert.equal(await ui.ask("Email", { validate: validateEmail }), "owner@corp.test");
  assert.match(output(), /enter one email address/);
  assert.equal(await ui.confirm("Deploy?"), true, "empty answer takes the default");
  assert.equal(await ui.confirm("Deploy?"), false);
  assert.equal(await ui.typed("Enable?", "enable"), true);
  assert.equal(await ui.typed("Delete?", "delete"), false);
  ui.release();
});

test("prompts: closed input and non-interactive mode end at a checkpoint, never at a guess", async () => {
  const { ui, input } = interactiveUi([]);
  const pending = ui.ask("Team domain");
  input.end();
  await assert.rejects(pending, (err) => err instanceof Checkpoint);

  const quiet = createUi({ interactive: false, out: new PassThrough() });
  await assert.rejects(quiet.ask("Email", { flag: "--email" }), (err) => err instanceof Checkpoint && err.instructions[0].includes("--email"));
  await assert.rejects(quiet.confirm("Deploy?"), (err) => err instanceof Checkpoint && /--yes/.test(err.instructions[0]));
  assert.equal(await quiet.typed("Enable?", "enable"), false, "risky opt-ins are never typed for you");
  assert.equal(await createUi({ interactive: false, yes: true, out: new PassThrough() }).confirm("Deploy?"), true);
  assert.equal(await quiet.ask("Device id", { fallback: "my-mac" }), "my-mac");
});

test("--yes accepts ordinary TTY confirmations but never supplies typed consent", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const out = new PassThrough();
  let text = "";
  out.on("data", (chunk) => { text += chunk; });
  const ui = createUi({ interactive: true, yes: true, input, out, color: false });
  assert.equal(await ui.confirm("Restart?", { defaultYes: false }), true);
  assert.equal(text, "", "ordinary confirmation does not read from the terminal");
  const risky = ui.typed("Delete?", "delete");
  input.write("yes\n");
  assert.equal(await risky, false);
  const explicit = ui.typed("Delete?", "delete");
  input.write("delete\n");
  assert.equal(await explicit, true);
  ui.release();
});
