// Minimal JSONC (JSON with comments, as used by wrangler.jsonc) support: parse it, and
// replace individual string values in place so the user's comments, ordering and any extra
// settings they added survive. Not a general JSONC library; it handles exactly the syntax
// wrangler accepts: // and /* */ comments, and trailing commas.

/**
 * Scans `text` once and returns every property whose value is a string literal, as
 * { path: ["vars", "AGENT_DEVICE_ID"], start, end } where text.slice(start, end) is the
 * quoted value. Array elements are not reported. Throws on unterminated strings/comments.
 */
export function stringProperties(text) {
  const out = [];
  // Each open container: { type: "obj" | "arr", key: its property name (or null), expectKey }.
  const stack = [];
  let pendingKey = null; // key read in the current object, waiting for its value
  let i = 0;

  const keyPath = () => stack.map((c) => c.key).filter((k) => k !== null);

  const readString = () => {
    const start = i;
    i++; // opening quote
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        return { start, end: i, value: JSON.parse(text.slice(start, i)) };
      }
      if (ch === "\n") break;
      i++;
    }
    throw new Error(`unterminated string at offset ${start}`);
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) throw new Error(`unterminated comment at offset ${i}`);
      i = close + 2;
      continue;
    }
    const top = stack[stack.length - 1];
    if (ch === '"') {
      const s = readString();
      if (top?.type === "obj" && top.expectKey) {
        pendingKey = s.value;
        top.expectKey = false;
      } else if (top?.type === "obj" && pendingKey !== null) {
        out.push({ path: [...keyPath(), pendingKey], start: s.start, end: s.end, value: s.value });
        pendingKey = null;
      }
      continue;
    }
    if (ch === "{" || ch === "[") {
      const key = top?.type === "obj" ? pendingKey : null;
      pendingKey = null;
      stack.push({ type: ch === "{" ? "obj" : "arr", key: top?.type === "arr" ? null : key, expectKey: ch === "{" });
      // A container inside an array has no name; mark it so its properties are not reported
      // under the parent's path.
      if (top?.type === "arr") stack[stack.length - 1].key = "[]";
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      pendingKey = null;
      i++;
      continue;
    }
    if (ch === ",") {
      if (top?.type === "obj") {
        top.expectKey = true;
        pendingKey = null;
      }
      i++;
      continue;
    }
    // ':' , whitespace and scalar literals (numbers, true/false/null) need no tracking,
    // except that a scalar value ends the pending key.
    if (/[-0-9tfn]/.test(ch) && top?.type === "obj" && pendingKey !== null) pendingKey = null;
    i++;
  }
  if (stack.length) throw new Error("unbalanced braces");
  return out.filter((p) => !p.path.includes("[]"));
}

/** Removes comments and trailing commas so JSON.parse accepts the text. */
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      out += text.slice(start, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    if (ch === ",") {
      // Drop a trailing comma: the next significant character closes the container.
      let j = i + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === "/" && text[j + 1] === "/") {
          while (j < text.length && text[j] !== "\n") j++;
        } else if (text[j] === "/" && text[j + 1] === "*") {
          const close = text.indexOf("*/", j + 2);
          j = close === -1 ? text.length : close + 2;
        } else break;
      }
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}

/**
 * Returns `text` with the string value at `path` replaced by `value`. The property must exist
 * exactly once as a string literal; anything else is an error rather than a guess.
 */
export function setStringProperty(text, path, value) {
  if (typeof value !== "string") throw new TypeError("value must be a string");
  const want = path.join("\u0000");
  const hits = stringProperties(text).filter((p) => p.path.join("\u0000") === want);
  if (hits.length !== 1) {
    throw new Error(`${path.join(".")} ${hits.length ? "appears more than once" : "is missing or not a string"}`);
  }
  const [{ start, end }] = hits;
  return text.slice(0, start) + JSON.stringify(value) + text.slice(end);
}
