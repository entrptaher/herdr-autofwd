// @ts-check
// The long-running half of the plugin, one per user. It keeps a Forwarder for every enabled saved
// machine, hosts the Ports panel, keeps the tab-row indicator current, and lives as long as at least one
// herdr server that started it does.
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { CONTROL_SOCK, HERDR, RUN_DIR, STATE_DIR, connectable, ensureRunDir, log, sleep } from "./common.js";
import { Forwarder } from "./forwarder.js";
import * as Integration from "./integration.js";
import { Panel } from "./panel.js";
import * as Prefs from "./prefs.js";
import { indicator } from "./text.js";

const run = promisify(execFile);
const MACHINE_POLL_MS = 3000;
const HERDR_POLL_MS = 5000;
const STATUS_REFRESH_MS = 30_000; // the indicator hides text older than a minute
const LOCAL_STATUS = path.join(STATE_DIR, "status");

/** @type {Map<string, Forwarder>} machine id -> forwarder */
const forwarders = new Map();
/** @type {Map<string, number>} herdr API socket -> consecutive failed checks */
const herdrSockets = new Map();
/** @type {Set<() => void>} open panels waiting for state changes */
const watchers = new Set();
const prefs = Prefs.load();
let localError = "";
/** @type {Map<string, string>} machine id -> integration state there: "ok", "working", "pending", "error: ..." */
const remoteState = new Map();
/** @type {Map<string, string>} machine id -> indicator text last written there */
const sentStatus = new Map();
let stopping = false;

function savePrefs() {
  try {
    Prefs.save(prefs);
  } catch (err) {
    log(`could not save prefs: ${/** @type {Error} */ (err).message}`);
  }
}

/** @type {NodeJS.Timeout | undefined} */
let publishTimer;
function changed() {
  watchers.forEach((fn) => fn());
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => publish(false), 300);
}

/** What the Ports panel works with. */
export const api = {
  snapshot: () => ({
    notify: prefs.notify,
    shortcut: { on: prefs.shortcut, key: Integration.KEY, error: localError },
    machines: [...forwarders.values()].map((f) => ({ ...f.snapshot(), shortcut: remoteState.get(f.id) ?? "" })),
  }),
  act,
  /** @param {() => void} fn */
  onChange(fn) {
    watchers.add(fn);
    return () => watchers.delete(fn);
  },
};

/**
 * Every change a user can make, from the panel or the control socket.
 * @param {any} msg {op, machine?, dest? (or port), local?, to?, on?}
 * @returns {Promise<import("./forwarder.js").Result>}
 */
async function act(msg) {
  if (msg?.op === "notify") {
    prefs.notify = msg.on === true;
    savePrefs();
    changed();
    return { ok: true, message: `Notifications ${prefs.notify ? "on" : "off"}` };
  }
  if (msg?.op === "shortcut") return setIntegration(msg.on === true);
  const f = forwarders.get(msg?.machine);
  if (!f) return { ok: false, message: "That machine is no longer saved" };
  const input = String(msg.dest ?? msg.port ?? "");
  const dest = Prefs.parseDest(input);
  if (["stop", "resume", "local"].includes(msg.op) && !dest) return { ok: false, message: `"${input}" isn't a port or host:port` };
  if (msg.op === "save" && input && !dest) return { ok: false, message: `"${input}" isn't a port or host:port` };
  const shown = dest ? Prefs.showDest(dest) : "";
  const local = msg.local === null || msg.local === undefined || msg.local === "" ? null : Number(msg.local);
  switch (msg.op) {
    case "stop":
      f.stopDest(/** @type {string} */ (dest));
      return { ok: true, message: `Stopped forwarding ${shown}` };
    case "resume":
      f.resumeDest(/** @type {string} */ (dest));
      return { ok: true, message: `Forwarding ${shown} again` };
    case "save": // the Ports panel's form: add (no dest) or edit, to = host:port
      return f.saveForward(dest, String(msg.to ?? ""), local);
    case "add":
      return f.saveForward(null, input, local);
    case "local":
      return f.saveForward(/** @type {string} */ (dest), /** @type {string} */ (dest), local);
    case "auto":
      f.setAuto(msg.on === true);
      return { ok: true, message: `Auto-forward ${msg.on ? "on" : "off"} for ${f.label}` };
    case "reconnect":
      f.reconnect();
      return { ok: true, message: `Reconnecting to ${f.label}` };
  }
  return { ok: false, message: `Unknown action: ${msg.op}` };
}

/** The panel's S: this computer now, every machine now or when it next connects. @param {boolean} on */
async function setIntegration(on) {
  prefs.shortcut = on;
  savePrefs();
  const problems = [];
  const notes = [];
  const here = await Integration.local(on, LOCAL_STATUS);
  localError = here.error;
  if (here.error) problems.push(`this computer: ${here.error}`);
  if (here.note) notes.push(`this computer: ${here.note}`);
  await Promise.all(
    [...forwarders.values()].map(async (f) => {
      const r = await applyIntegration(f);
      if (r.error) problems.push(`${f.label}: ${r.error}`);
      if (r.note) notes.push(`${f.label}: ${r.note}`);
    }),
  );
  if (!on) fs.rmSync(LOCAL_STATUS, { force: true });
  sentStatus.clear();
  changed();
  if (problems.length) return { ok: false, message: [...problems, ...notes].join(" · ") };
  if (!on) return { ok: true, message: "herdr integration removed" };
  const where = ["this computer", ...[...forwarders.values()].map((f) => f.label)].join(", ");
  return { ok: true, message: [`${Integration.KEY} and the ports indicator are set up on ${where}`, ...notes].join(" · ") };
}

/** Install or remove the integration on one machine to match prefs; offline machines get it on connect. @param {Forwarder} f */
async function applyIntegration(f) {
  const mp = Prefs.machine(prefs, f.id);
  if (!prefs.shortcut && !mp.companion) return { error: "", note: "" };
  if (!f.up) {
    remoteState.set(f.id, prefs.shortcut ? "pending" : "");
    return { error: "", note: "" };
  }
  remoteState.set(f.id, "working");
  watchers.forEach((fn) => fn());
  const r = await Integration.remote(f, prefs.shortcut);
  if (!r.error) mp.companion = prefs.shortcut;
  remoteState.set(f.id, r.error ? `error: ${r.error}` : prefs.shortcut ? "ok" : "");
  savePrefs();
  changed();
  if (r.error) log(`${f.label}: integration: ${r.error}`);
  return r;
}

/**
 * Names what holds a local port, for conflict messages: one of our forwards ("the forward from demo-2
 * (3000)") or a program on this computer ("node (pid 4123) on this computer"). @param {number} port
 */
async function whoHolds(port) {
  for (const f of forwarders.values())
    for (const [dest, fw] of f.forwards) if (fw.local === port) return `the forward from ${f.label} (${Prefs.showDest(dest)})`;
  const lsof = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]).then((r) => r.stdout, () => "");
  let m = /^p(\d+)\nc(.+)$/m.exec(lsof);
  if (m) return `${m[2]} (pid ${m[1]}) on this computer`;
  const ss = await run("ss", ["-Hltnp", `sport = :${port}`]).then((r) => r.stdout, () => "");
  if ((m = /users:\(\("([^"]+)",pid=(\d+)/.exec(ss))) return `${m[1]} (pid ${m[2]}) on this computer`;
  return "another program on this computer";
}

/**
 * Keep the indicator text current: this computer's file and each machine's. Files are rewritten at least
 * every STATUS_REFRESH_MS, since the indicator hides anything older than a minute.
 * @param {boolean} refresh rewrite even when unchanged
 */
function publish(refresh) {
  if (!prefs.shortcut || stopping) return;
  const all = [...forwarders.values()];
  try {
    fs.writeFileSync(LOCAL_STATUS, all.length ? indicator(all.flatMap((f) => f.rows())) + "\n" : "");
  } catch (err) {
    log(`could not write ${LOCAL_STATUS}: ${/** @type {Error} */ (err).message}`);
  }
  for (const f of all) {
    if (!f.up || remoteState.get(f.id) !== "ok") continue;
    const text = indicator(f.rows());
    if (!refresh && sentStatus.get(f.id) === text) continue;
    sentStatus.set(f.id, text);
    const child = f.session(`umask 077; mkdir -p "\${HOME}/.cache/herdr-autofwd" && cat >"${Integration.REMOTE_STATUS}"`);
    child.stdin?.on("error", () => {});
    child.stdin?.end(text + "\n");
  }
}

/** The machine's companion popup asked for the panel: stream it there over the existing connection. @param {Forwarder} f */
function remotePanel(f, /** @type {{dir: string, rows: number, cols: number}} */ { dir, rows, cols }) {
  const q = `'${dir}'`; // the forwarder only accepts [\w./-] paths, so quoting is safe
  const keys = f.session(`touch ${q}/attached && exec cat ${q}/in`);
  const screen = f.session(`exec cat >${q}/out`);
  if (!keys.stdout || !screen.stdin) return;
  new Panel(api, { input: keys.stdout, output: screen.stdin, rows, cols, focus: f.id, onClose: () => keys.kill() });
}

export async function main() {
  ensureRunDir();
  const server = net.createServer(onClient);
  if (!(await listen(server))) return log("another autofwd daemon is already running");
  if (process.env.HERDR_SOCKET_PATH) herdrSockets.set(process.env.HERDR_SOCKET_PATH, 0);
  for (const sig of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"])) process.on(sig, () => shutdown(sig));
  process.on("uncaughtException", (err) => (log(err), shutdown("crash")));
  // Last resort: never leave ssh masters (and their forwards) running without us.
  process.on("exit", () => forwarders.forEach((f) => f.child?.kill("SIGTERM")));
  log(`started (pid ${process.pid})`);
  // Bring an existing setup up to date with this version (for example, add the indicator).
  if (prefs.shortcut) Integration.local(true, LOCAL_STATUS).then((r) => (localError = r.error), (err) => log(err));
  loop(syncMachines, MACHINE_POLL_MS);
  loop(checkHerdr, HERDR_POLL_MS);
  loop(async () => publish(true), STATUS_REFRESH_MS);
}

/** @param {() => Promise<void>} fn @param {number} ms */
async function loop(fn, ms) {
  let last = "";
  while (!stopping) {
    // Log a failure once, not every few seconds while it lasts.
    const err = await fn().then(() => "", (e) => String(e?.message ?? e));
    if (err && err !== last) log(err);
    last = err;
    await sleep(ms);
  }
}

/** Listen on the control socket; false when a live daemon already owns it. @param {net.Server} server */
async function listen(server) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const err = await new Promise((resolve) => {
      server.once("error", resolve);
      server.listen(CONTROL_SOCK, () => (server.off("error", resolve), resolve(null)));
    });
    if (!err) return true;
    if (err.code !== "EADDRINUSE" || (await connectable(CONTROL_SOCK))) return false;
    fs.rmSync(CONTROL_SOCK, { force: true }); // stale socket from a daemon that died
  }
  return false;
}

/** Mirror herdr's saved machines: start forwarders for new or re-enabled ones, stop the rest. */
async function syncMachines() {
  const { stdout } = await run(HERDR, ["machine", "list", "--json"], { timeout: 10_000 });
  const list = JSON.parse(stdout);
  if (!Array.isArray(list)) throw new Error("herdr machine list --json did not return an array");
  /** @type {Map<string, {id: string, label: string, target: string}>} */
  const wanted = new Map();
  for (const m of list) {
    if (m && typeof m.id === "string" && typeof m.target === "string" && m.target && m.enabled !== false)
      wanted.set(m.id, { id: m.id, label: typeof m.label === "string" && m.label ? m.label : m.target, target: m.target });
  }
  let dirty = false;
  for (const [id, f] of forwarders) {
    const m = wanted.get(id);
    if (m && m.target === f.target) {
      dirty ||= f.label !== m.label;
      f.label = m.label;
    } else {
      log(`${f.label}: removed or disabled`);
      f.stop();
      forwarders.delete(id);
      dirty = true;
    }
  }
  for (const [id, m] of wanted) {
    if (forwarders.has(id) || stopping) continue;
    const f = new Forwarder(m, RUN_DIR, Prefs.machine(prefs, id), savePrefs, whoHolds);
    announce(f);
    f.on("change", changed);
    f.on("ui", (req) => remotePanel(f, req));
    f.on("status", (next) => next === "connected" && applyIntegration(f));
    forwarders.set(id, f);
    f.start();
    dirty = true;
  }
  if (dirty) changed();
}

/** Stop once every herdr server that started us is gone. Two misses in a row: a live handoff blips once. */
async function checkHerdr() {
  for (const [sock, misses] of herdrSockets) {
    if (await connectable(sock)) herdrSockets.set(sock, 0);
    else if (misses >= 1) herdrSockets.delete(sock);
    else herdrSockets.set(sock, misses + 1);
  }
  if (herdrSockets.size === 0) shutdown("no herdr server left");
}

/** Herdr toasts for a machine. New forwards are batched briefly so connecting to a busy box is one toast. */
function announce(/** @type {Forwarder} */ f) {
  /** @type {{remote: string, local: number, name: string, note: string}[]} */
  let batch = [];
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  let shownError = "";
  f.on("forward", (fwd) => {
    batch.push(fwd);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const lines = batch.map((b) => `localhost:${b.local} ← ${b.name || "port"} ${b.remote}${b.note ? ` (${b.note})` : ""}`);
      const title = batch.length === 1 ? `${f.label}: localhost:${batch[0].local}` : `${f.label}: ${batch.length} ports forwarded`;
      notify(title, lines.join("\n"));
      batch = [];
    }, 500);
  });
  f.on("busy", (remote) => notify(`${f.label}: can't forward ${remote}`, "All 20 local ports from that number up are in use."));
  f.on("status", (next, prev, error) => {
    if (next === "connected") shownError = "";
    else if (prev === "connected") notify(`${f.label}: connection lost`, "Forwards closed. Reconnecting automatically.");
    else if (!f.ever && error && error !== shownError) {
      shownError = error; // first-time failures (auth, unreachable) once per distinct error
      notify(`${f.label}: can't connect for port forwarding`, error);
    }
  });
}

/** @param {string} title @param {string} body */
function notify(title, body) {
  if (!prefs.notify) return;
  execFile(HERDR, ["notification", "show", title, "--body", body], { timeout: 5000 }, (err) => {
    if (err) log(`notification failed: ${err.message}`);
  });
}

/**
 * One JSON request per connection: status, act, attach (another herdr server started us again), stop.
 * "panel" turns the connection into a terminal stream for the Ports panel (the local popup relay).
 * @param {net.Socket} conn
 */
function onClient(conn) {
  let buf = "";
  conn.on("error", () => {});
  const onData = (/** @type {Buffer} */ d) => {
    buf += d;
    const nl = buf.indexOf("\n");
    if (nl < 0) return void (buf.length > 4096 && conn.destroy());
    conn.off("data", onData);
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(buf.slice(0, nl));
    } catch {
      return reply(conn, { error: "bad request" });
    }
    if (msg?.cmd === "panel") {
      const panel = new Panel(api, { input: conn, output: conn, rows: Number(msg.rows) || 24, cols: Number(msg.cols) || 80 });
      if (buf.length > nl + 1) panel.input(buf.slice(nl + 1));
      return;
    }
    handle(msg).then((r) => reply(conn, r), (err) => reply(conn, { error: String(err?.message ?? err) }));
  };
  conn.on("data", onData);
}

/** @param {any} msg */
async function handle(msg) {
  switch (msg?.cmd) {
    case "status":
      return { pid: process.pid, ...api.snapshot() };
    case "act":
      return act(msg);
    case "attach":
      if (typeof msg.socket === "string" && msg.socket && !herdrSockets.has(msg.socket)) herdrSockets.set(msg.socket, 0);
      return { ok: true, pid: process.pid };
    case "stop":
      setImmediate(() => shutdown("stop requested"));
      return { ok: true };
  }
  return { error: `unknown command: ${msg?.cmd}` };
}

/** @param {net.Socket} conn @param {object} obj */
function reply(conn, obj) {
  conn.end(JSON.stringify(obj) + "\n");
}

/** @param {string} reason */
function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${reason}`);
  forwarders.forEach((f) => f.stop());
  fs.rmSync(CONTROL_SOCK, { force: true });
  fs.rmSync(LOCAL_STATUS, { force: true }); // the indicator disappears with us
  setTimeout(() => process.exit(0), 500); // let the ssh masters close their forwards first
}
