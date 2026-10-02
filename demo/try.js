#!/usr/bin/env node
// @ts-check
// Try the Ports panel in your terminal with no servers: the real panel, driven by two pretend machines
// whose ports come and go, including a clash between them and a local program in the way.
// Run: npm run demo   (q quits)
import { PassThrough } from "node:stream";
import { Panel } from "../src/panel.js";
import { destHost, destPort, isPort, parseDest, showDest } from "../src/prefs.js";

/** @typedef {{dest: string, remote: string, local: number | null, name: string, manual: boolean, detected: boolean, state: string, note: string}} Row */
/** @typedef {{id: string, label: string, target: string, status: string, error: string, auto: boolean, shortcut: string, ports: Row[]}} Machine */

/** @type {Machine[]} */
const machines = ["dev-server", "gpu-box"].map((label) => ({
  id: label, label, target: `ssh://${label}`, status: "connected", error: "", auto: true, shortcut: "", ports: [],
}));
const localPrograms = new Map([[8080, "node (pid 4242) on this computer"]]); // pretend you run something here
const state = { notify: true, shortcut: { on: true, key: "prefix+f", error: "" }, machines };
/** @type {Set<() => void>} */
const watchers = new Set();
const changed = () => watchers.forEach((fn) => fn());
const machine = (/** @type {string} */ id) => /** @type {Machine} */ (machines.find((m) => m.id === id));

/** What holds a local port, worded like the real thing. @param {number} port @param {Row} [except] */
function whoHolds(port, except) {
  for (const m of machines) for (const r of m.ports) if (r !== except && r.local === port) return `the forward from ${m.label} (${r.remote})`;
  return localPrograms.get(port) ?? "";
}

/** Forward a row on its wanted port or the next free one, saying why when it moved. @param {Row} row @param {number} [wanted] */
function forward(row, wanted = destPort(row.dest)) {
  for (let local = wanted; local < wanted + 20; local++) {
    if (whoHolds(local, row)) continue;
    Object.assign(row, { local, state: "forwarded", note: local === wanted ? "" : `localhost:${wanted} is used by ${whoHolds(wanted, row)}` });
    return;
  }
  Object.assign(row, { local: null, state: "busy", note: `localhost:${wanted}-${wanted + 19} are all in use` });
}

/** A port starts listening on a machine. @param {string} id @param {number} port @param {string} name */
function listen(id, port, name) {
  const row = { dest: `localhost:${port}`, remote: String(port), local: null, name, manual: false, detected: true, state: "pending", note: "" };
  machine(id).ports.push(row);
  if (machine(id).auto) forward(row);
  else row.state = "off";
  changed();
}

/** @param {string} id @param {number} port */
function close(id, port) {
  const m = machine(id);
  m.ports = m.ports.filter((r) => !(r.detected && r.dest === `localhost:${port}`));
  changed();
}

/** The same actions the real daemon takes, on pretend state. @param {any} msg */
async function act(msg) {
  if (msg.op === "notify") return (state.notify = msg.on), changed(), { ok: true, message: `Notifications ${msg.on ? "on" : "off"}` };
  if (msg.op === "shortcut") return { ok: true, message: "In herdr, S sets up prefix+f and the ⇄ indicator on every machine (nothing to do in this demo)" };
  const m = machine(msg.machine);
  const row = m.ports.find((r) => r.dest === msg.dest);
  switch (msg.op) {
    case "stop":
      if (!row) break;
      if (row.manual && !row.detected) m.ports = m.ports.filter((r) => r !== row);
      else Object.assign(row, { local: null, state: "stopped", note: "" });
      changed();
      return { ok: true, message: `Stopped forwarding ${row.remote}` };
    case "resume":
      if (row) forward(row), changed();
      return { ok: true, message: `Forwarding ${row?.remote} again` };
    case "auto":
      m.auto = msg.on;
      for (const r of m.ports) if (!r.manual) msg.on ? forward(r) : Object.assign(r, { local: null, state: "off", note: "" });
      changed();
      return { ok: true, message: `Auto-forward ${msg.on ? "on" : "off"} for ${m.label}` };
    case "reconnect":
      return { ok: true, message: `Reconnected to ${m.label}` };
    case "save": {
      const next = parseDest(msg.to);
      if (!next) return { ok: false, message: `"${msg.to}" isn't a valid host:port` };
      const local = msg.local === null ? null : Number(msg.local);
      if (local !== null && !isPort(local)) return { ok: false, message: "The local port must be a number from 1 to 65535" };
      const holder = local !== null && local !== row?.local ? whoHolds(local, row) : "";
      if (holder) return { ok: false, message: `localhost:${local} is already used by ${holder}. Pick another local port.` };
      const target = row ?? m.ports.find((r) => r.dest === next);
      if (target) {
        Object.assign(target, { dest: next, remote: showDest(next), manual: target.manual || next !== msg.dest, name: destHost(next) === "localhost" ? target.name : "" });
        forward(target, local ?? target.local ?? destPort(next));
      } else {
        const added = { dest: next, remote: showDest(next), local: null, name: "", manual: true, detected: false, state: "pending", note: "" };
        m.ports.push(added);
        forward(added, local ?? destPort(next));
      }
      m.ports.sort((a, b) => destPort(a.dest) - destPort(b.dest));
      changed();
      return { ok: true, message: msg.dest ? `Now forwarding ${showDest(next)}` : `Forwarding ${showDest(next)} from ${m.label}` };
    }
  }
  return { ok: false, message: "Not available in the demo" };
}

// What happens on the pretend machines: a dev server, a clash, a local program in the way, and an OAuth
// login whose callback port opens and closes.
listen("dev-server", 3000, "node");
const script = [
  [1500, () => listen("dev-server", 5173, "vite")],
  [3500, () => listen("gpu-box", 5173, "vite")],
  [5500, () => listen("gpu-box", 8080, "jupyter")],
  [7500, () => listen("dev-server", 33333, "gh (auth login)")],
  [15000, () => close("dev-server", 33333)],
];
for (const [ms, fn] of /** @type {[number, () => void][]} */ (script)) setTimeout(fn, ms).unref();

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Run this in a terminal: npm run demo");
  process.exit(1);
}
const out = new PassThrough();
out.pipe(process.stdout, { end: false });
process.stdin.setRawMode(true);
const api = { snapshot: () => state, act, onChange: (/** @type {() => void} */ fn) => (watchers.add(fn), () => watchers.delete(fn)) };
const panel = new Panel(api, {
  input: process.stdin,
  output: out,
  rows: process.stdout.rows,
  cols: process.stdout.columns,
  open: (url) => panel.say(`In real use this opens ${url} in your browser`, ""),
  onClose: () => (process.stdin.setRawMode(false), process.exit(0)),
});
process.stdout.on("resize", () => panel.input(`\x1b[8;${process.stdout.rows};${process.stdout.columns}t`));
