// @ts-check
// The Ports panel driven like a user would: keys and mouse clicks at the coordinates it drew, read back
// from a small virtual terminal. A fake daemon api records what the panel asks for.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { after, test } from "node:test";
import { Panel } from "../src/panel.js";

const ROWS = 20;
const COLS = 110;
// The panel opens URLs and copies with these; record instead of touching your browser and clipboard.
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "afw-panel-"));
for (const tool of ["open", "xdg-open", "pbcopy", "wl-copy"]) fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >>"${bin}/log"\ncat >/dev/null\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
after(() => fs.rmSync(bin, { recursive: true, force: true }));

/** Just enough of a terminal for the panel: cursor moves, line/screen clears, text; styles ignored. */
class Screen extends Writable {
  constructor() {
    super();
    this.raw = "";
    this.grid = Array.from({ length: ROWS }, () => Array(COLS).fill(" "));
    [this.x, this.y] = [0, 0];
  }
  /** @param {Buffer} chunk @param {string} _enc @param {() => void} done */
  _write(chunk, _enc, done) {
    const s = String(chunk);
    this.raw += s;
    const re = /\x1b\[(\d*)(?:;(\d*))?([A-Za-z])|\x1b\[\?\d+[hl]|\x1b\][^\x07]*\x07|([\s\S])/g;
    for (const m of s.matchAll(re)) {
      if (m[3] === "H") [this.y, this.x] = [Number(m[1] || 1) - 1, Number(m[2] || 1) - 1];
      else if (m[3] === "K" && m[1] === "2") this.grid[this.y]?.fill(" ");
      else if (m[3] === "J") this.grid.forEach((r) => r.fill(" "));
      else if (m[4] !== undefined && this.grid[this.y] && this.x < COLS) this.grid[this.y][this.x++] = m[4];
    }
    done();
  }
  text() {
    return this.grid.map((r) => r.join("").trimEnd()).join("\n");
  }
  /** 1-based terminal coordinates of a text, as a mouse report needs them. @param {string} needle */
  find(needle) {
    for (let y = 0; y < ROWS; y++) {
      const x = this.grid[y].join("").indexOf(needle);
      if (x >= 0) return { x: x + 1, y: y + 1 };
    }
    throw new Error(`"${needle}" is not on screen:\n${this.text()}`);
  }
}

/** @param {{machines?: number, reply?: (msg: any) => {ok: boolean, message: string}}} [opts] */
function setup({ machines = 1, reply = () => ({ ok: true, message: "done" }) } = {}) {
  /** @type {any[]} */
  const calls = [];
  const machine = (/** @type {number} */ n) => ({
    id: `m${n}`, label: n === 1 ? "box" : `box${n}`, target: `ssh://box${n}`, status: "connected", error: "", auto: true, shortcut: "",
    ports: n === 1 ? [
      { dest: "localhost:3000", remote: "3000", local: 3000, name: "node", manual: false, detected: true, state: "forwarded", note: "" },
      { dest: "db:5432", remote: "db:5432", local: 5432, name: "", manual: true, detected: false, state: "forwarded", note: "" },
      { dest: "localhost:8080", remote: "8080", local: null, name: "evil\x1b]52;c;aGk=\x07", manual: false, detected: true, state: "stopped", note: "" },
    ] : [
      { dest: "localhost:3000", remote: "3000", local: 3001, name: "node", manual: false, detected: true, state: "forwarded", note: "localhost:3000 is used by the forward from box (3000)" },
    ],
  });
  const state = { notify: true, shortcut: { on: false, key: "prefix+f", error: "" }, machines: Array.from({ length: machines }, (_, i) => machine(i + 1)) };
  const api = { snapshot: () => state, act: async (/** @type {any} */ msg) => (calls.push(msg), reply(msg)), onChange: () => () => {} };
  const input = new PassThrough();
  const screen = new Screen();
  let closed = false;
  const panel = new Panel(api, { input, output: screen, rows: ROWS, cols: COLS, onClose: () => (closed = true) });
  const send = (/** @type {string} */ s) => panel.input(s);
  const click = (/** @type {string} */ text, button = 0) => {
    const { x, y } = screen.find(text);
    send(`\x1b[<${button};${x};${y}M\x1b[<${button};${x};${y}m`);
  };
  return { calls, screen, send, click, panel, isClosed: () => closed };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test("rows show ports, other hosts, conflicts and stopped ports; remote text can't inject escapes", () => {
  const { screen, send, panel } = setup({ machines: 2 });
  const text = screen.text();
  for (const s of ["Ports 3", "REMOTE", "localhost:3000", "db:5432", "stopped", "+ Add a forward", "localhost:3001"])
    assert.ok(text.includes(s), `${s}\n${text}`);
  assert.ok(!screen.raw.includes("\x1b]52"), "a process name can't write to the clipboard");
  send("G"); // select box2's 3000, the conflicted one: its full note shows above the buttons
  assert.ok(screen.text().includes("! box2 3000: localhost:3000 is used by the forward from box (3000)"), screen.text());
  panel.close();
});

test("bottom buttons act on the selected row", async () => {
  const { calls, click, panel } = setup();
  click("s stop");
  await settle();
  assert.deepEqual(calls.at(-1), { op: "stop", machine: "m1", dest: "localhost:3000" });
  click("c copy");
  click("↵ open");
  // The tools run detached; wait for both to have logged.
  const logged = () => { try { const l = fs.readFileSync(path.join(bin, "log"), "utf8"); return /(pbcopy|wl-copy)/.test(l) && /open http:\/\/localhost:3000/.test(l); } catch { return false; } };
  for (let i = 0; i < 50 && !logged(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(logged(), "copy and open went to this computer's clipboard and browser tools");
  panel.close();
});

test("add form: click fields, type host, remote port and local port, click Save", async () => {
  const { calls, screen, send, click, panel } = setup();
  click("+ Add a forward");
  assert.ok(screen.text().includes("Add a forward"), screen.text());
  click("Remote host");
  send("\x7f".repeat(9) + "db.internal");
  click("Remote port");
  send("5433");
  click("Local port");
  send("15433");
  click("[ Save ]");
  await settle();
  assert.deepEqual(calls.at(-1), { op: "save", machine: "m1", dest: null, to: "db.internal:5433", local: 15433 });
  assert.ok(!screen.text().includes("Add a forward ─"), "form closed after saving");
  panel.close();
});

test("edit from the right-click menu: change the remote port, Enter saves", async () => {
  const { calls, screen, send, click, panel } = setup();
  click("db:5432", 2);
  click("Edit…");
  const text = screen.text();
  assert.ok(text.includes("Edit forward") && text.includes("Remote host   db"), text);
  send("\x7f\x7f\x7f\x7f6543\r"); // the remote port field has focus
  await settle();
  assert.deepEqual(calls.at(-1), { op: "save", machine: "m1", dest: "db:5432", to: "db:6543", local: 5432 });
  panel.close();
});

test("a conflict stays in the form with the reason; nothing closes", async () => {
  const reason = "localhost:3001 is already used by the forward from box2 (3000). Pick another local port.";
  const { calls, screen, send, panel } = setup({ machines: 2, reply: (msg) => (msg.local === 3001 ? { ok: false, message: reason } : { ok: true, message: "done" }) });
  send("e"); // edit the selected row (box 3000)
  send("\t\x7f\x7f\x7f\x7f3001\r"); // tab to the local port, type 3001, Enter
  await settle();
  assert.equal(calls.at(-1).local, 3001);
  assert.ok(screen.text().includes(`! ${reason.slice(0, 60)}`), screen.text());
  assert.ok(screen.text().includes("Edit forward"), "the form is still open to fix it");
  send("\x7f3002\r");
  await settle();
  assert.ok(!screen.text().includes("Edit forward ─"), "fixed and saved");
  panel.close();
});

test("form checks its fields before asking, and switches machines", async () => {
  const { calls, screen, send, click, panel } = setup({ machines: 2 });
  send("+");
  assert.ok(screen.text().includes("◂ box ▸"), screen.text());
  send("\r"); // empty remote port
  assert.ok(screen.text().includes("! Remote port: a number from 1 to 65535"), screen.text());
  assert.equal(calls.length, 0);
  click("▸");
  assert.ok(screen.text().includes("◂ box2 ▸"), "the arrow switches machine");
  click("Remote port");
  send("8080\r");
  await settle();
  assert.deepEqual(calls.at(-1), { op: "save", machine: "m2", dest: null, to: "localhost:8080", local: null });
  panel.close();
});

test("Esc cancels the form first, then closes the panel", async () => {
  const { calls, screen, send, isClosed } = setup();
  send("+");
  send("\x1b");
  await new Promise((r) => setTimeout(r, 100)); // a lone Esc waits briefly in case it starts an arrow key
  assert.ok(!screen.text().includes("Add a forward ─") && !isClosed(), "form cancelled, panel open");
  send("\x1b");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(isClosed());
  assert.equal(calls.length, 0);
});

test("Machines tab: click the auto-forward cell and the settings", async () => {
  const { calls, screen, click, panel } = setup();
  click("Machines 1");
  assert.ok(screen.text().includes("New server?"), screen.text());
  click("on            "); // the AUTO-FORWARD cell
  await settle();
  assert.deepEqual(calls.at(-1), { op: "auto", machine: "m1", on: false });
  click("herdr integration");
  await settle();
  assert.deepEqual(calls.at(-1), { op: "shortcut", on: true });
  click("Notifications");
  await settle();
  assert.deepEqual(calls.at(-1), { op: "notify", on: false });
  panel.close();
});
