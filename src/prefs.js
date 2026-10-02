// @ts-check
// Choices made in the Ports panel, saved by the daemon. This is state, not config: nobody edits it by hand.
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR, log } from "./common.js";

const FILE = path.join(STATE_DIR, "prefs.json");

/**
 * A forward destination ("dest") is "host:port" as seen from the machine: "localhost:3000", "db.internal:5432",
 * "[fd00::1]:80". Ports the machine listens on itself are always "localhost:PORT".
 *
 * @typedef {{auto: boolean, stopped: number[], manual: string[], local: Record<string, number>, companion: boolean}} MachinePrefs
 *   auto: forward detected ports automatically; stopped: detected ports you stopped; manual: dests you
 *   added; local: dest -> the local port you picked for it; companion: the integration is installed there.
 * @typedef {{notify: boolean, shortcut: boolean, machines: Record<string, MachinePrefs>}} Prefs
 */

const isPort = (/** @type {unknown} */ n) => Number.isInteger(n) && /** @type {number} */ (n) >= 1 && /** @type {number} */ (n) <= 65535;

/**
 * "3000" -> "localhost:3000"; "db:5432" and "[fd00::1]:80" stay; anything else is null. The host check
 * also keeps dests safe inside an ssh -L spec.
 * @param {string} text @returns {string | null}
 */
export function parseDest(text) {
  const m = /^(?:(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):)?(\d{1,5})$/.exec(String(text).trim());
  return m && isPort(Number(m[2])) ? `${m[1] ?? "localhost"}:${Number(m[2])}` : null;
}

/** @param {string} dest */
export const destPort = (dest) => Number(dest.slice(dest.lastIndexOf(":") + 1));
/** @param {string} dest */
export const destHost = (dest) => dest.slice(0, dest.lastIndexOf(":"));
/** How a dest is shown: just the port when it's the machine's own. @param {string} dest */
export const showDest = (dest) => (destHost(dest) === "localhost" ? String(destPort(dest)) : dest);

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

export { isPort };
