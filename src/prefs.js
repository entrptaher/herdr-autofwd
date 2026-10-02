// @ts-check
// Choices made in the Ports panel, saved by the daemon. This is state, not config: nobody edits it by hand.
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR, log } from "./common.js";
import { destHost, destPort, isPort, parseDest, showDest } from "./text.js";

const FILE = path.join(STATE_DIR, "prefs.json");

/**
 * Forward destinations ("dests", "host:port" as seen from the machine) are described in text.js.
 *
 * @typedef {{auto: boolean, stopped: number[], manual: string[], local: Record<string, number>, companion: boolean}} MachinePrefs
 *   auto: forward detected ports automatically; stopped: detected ports you stopped; manual: dests you
 *   added; local: dest -> the local port you picked for it; companion: the integration is installed there.
 * @typedef {{notify: boolean, shortcut: boolean, machines: Record<string, MachinePrefs>}} Prefs
 */

/** @returns {Prefs} */
export function load() {
  /** @type {any} */
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") log(`ignoring unreadable ${FILE}: ${err}`);
  }
  /** @type {Prefs} */
  const prefs = { notify: raw?.notify !== false, shortcut: raw?.shortcut === true, machines: {} };
  for (const [id, m] of Object.entries(raw?.machines ?? {})) {
    const p = machine(prefs, id);
    p.auto = m?.auto !== false;
    p.companion = m?.companion === true;
    p.stopped = Array.isArray(m?.stopped) ? m.stopped.filter(isPort) : [];
    // Older versions saved bare port numbers; parseDest reads both.
    p.manual = Array.isArray(m?.manual) ? [...new Set(m.manual.map(parseDest).filter(Boolean))] : [];
    for (const [dest, local] of Object.entries(m?.local ?? {})) {
      const t = parseDest(dest);
      if (t && isPort(local)) p.local[t] = local;
    }
  }
  return prefs;
}

/** Write atomically, so a crash mid-write never leaves a half file. @param {Prefs} prefs */
export function save(prefs) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2) + "\n");
  fs.renameSync(tmp, FILE);
}

/** A machine's prefs, created with defaults on first use. @param {Prefs} prefs @param {string} id */
export function machine(prefs, id) {
  return (prefs.machines[id] ??= { auto: true, stopped: [], manual: [], local: {}, companion: false });
}

export { destHost, destPort, isPort, parseDest, showDest };
