// @ts-check
// One saved machine: a single OpenSSH connection that streams the machine's listening ports
// (watch.sh) and doubles as the control master that every local forward is added to.
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { log } from "./common.js";
import { destHost, destPort, isPort, parseDest, printable, showDest } from "./text.js";

const WATCH_SCRIPT = fs.readFileSync(new URL("./watch.sh", import.meta.url), "utf8");
const SPAN = 20; // local ports tried per forward: the wanted one first, then the next free ones
const MAX_DELAY_MS = 30_000;
// Forwards bind 127.0.0.1 and ::1 separately: a plain -L succeeds if either binds, which would let a
// local server on the other address silently shadow the forward.
const HAS_V6 = Object.values(os.networkInterfaces())
  .flat()
  .some((i) => i?.internal && i.address === "::1");

/**
 * A forward's destination ("dest") is "host:port" as seen from the machine; ports the machine itself
 * listens on are "localhost:PORT".
 *
 * @typedef {{local: number, name: string, note: string}} Forward
 * @typedef {"connecting" | "connected" | "retrying"} Status
 * @typedef {"forwarded" | "stopped" | "off" | "busy" | "pending"} PortState
 * @typedef {{dest: string, remote: string, local: number | null, name: string, manual: boolean, detected: boolean, state: PortState, note: string}} PortRow
 *   remote: dest as shown ("3000", or "db:5432" for another host)
 * @typedef {{ok: boolean, message: string}} Result
 *
 * Events: "change"; "status" (next, prev, error); "forward" ({remote, local, name, note}) for automatic
 * forwards; "busy" (remote); "ui" ({dir, rows, cols}) when the machine's companion asks for the panel.
 */
export class Forwarder extends EventEmitter {
  /**
   * @param {{id: string, label: string, target: string}} machine target: the SSH target
   * @param {string} runDir
   * @param {import("./prefs.js").MachinePrefs} prefs this machine's prefs, owned by the daemon
   * @param {() => void} savePrefs
   * @param {(port: number) => Promise<string>} [whoHolds] names what holds a local port, for messages
   */
  constructor(machine, runDir, prefs, savePrefs, whoHolds = async () => "something else") {
    super();
    this.whoHolds = whoHolds;
    this.id = machine.id;
    this.label = machine.label;
    this.target = machine.target;
    this.prefs = prefs;
    this.savePrefs = savePrefs;
    const hash = crypto.createHash("sha256").update(`${machine.id}\0${machine.target}`).digest("hex");
    this.sock = path.join(runDir, hash.slice(0, 10)); // short: see SOCKET_ROOM in common.js
    /** @type {Status} */
    this.status = "connecting";
    this.error = "";
    this.ever = false; // has this machine ever connected since the daemon started
    this.up = false; // the current connection has reported =ready
    /** @type {Map<number, string>} ports the machine listens on now -> process name */
    this.detected = new Map();
    /** @type {Map<string, Forward>} dest -> active local forward */
    this.forwards = new Map();
    /** @type {Map<string, string>} dest -> why it couldn't be forwarded */
    this.problems = new Map();
    /** @type {import("node:child_process").ChildProcess | null} */
    this.child = null;
    this.generation = 0; // bumps per connection, so late async work from a dead one is dropped
    this.queue = Promise.resolve(); // forward/cancel work runs one at a time, in order
    this.pending = false; // a reconcile is already queued
    this.delay = 1000;
    this.stopped = false;
    /** @type {NodeJS.Timeout | undefined} */
    this.timer = undefined;
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.child?.kill("SIGTERM"); // the forwards die with the master connection
  }

  /** Drop the connection (if any) and connect again right away. */
  reconnect() {
    clearTimeout(this.timer);
    this.delay = 0;
    if (this.child) this.child.kill("SIGTERM");
    else this.connect();
  }

  snapshot() {
    const { id, label, target, status, error } = this;
    return { id, label, target, status, error, auto: this.prefs.auto, ports: this.rows() };
  }

  /** Every forward worth showing: listening now, added by you, or forwarded. @returns {PortRow[]} */
  rows() {
    const p = this.prefs;
    const dests = new Set([...[...this.detected.keys()].map((port) => `localhost:${port}`), ...p.manual, ...this.forwards.keys()]);
    return [...dests]
      .sort((a, b) => destPort(a) - destPort(b) || a.localeCompare(b))
      .map((dest) => {
        const f = this.forwards.get(dest);
        const manual = p.manual.includes(dest);
        const own = destHost(dest) === "localhost" ? destPort(dest) : 0;
        const detected = this.detected.has(own);
        /** @type {PortState} */
        const state = f ? "forwarded"
          : !manual && p.stopped.includes(own) ? "stopped"
          : this.problems.has(dest) ? "busy"
          : !manual && !p.auto ? "off"
          : "pending";
        const name = this.detected.get(own) ?? f?.name ?? "";
        return { dest, remote: showDest(dest), local: f?.local ?? null, name, manual, detected, state, note: f?.note || this.problems.get(dest) || "" };
      });
  }

  // ---- actions from the Ports panel; each saves prefs and re-applies them ----

  /** Stop forwarding: a detected port stays stopped until resumed; one you added is removed. @param {string} dest */
  stopDest(dest) {
    const p = this.prefs;
    p.manual = p.manual.filter((x) => x !== dest);
    const own = destHost(dest) === "localhost" ? destPort(dest) : 0;
    if (this.detected.has(own) && !p.stopped.includes(own)) p.stopped.push(own);
    this.changed(dest);
  }

  /** @param {string} dest */
  resumeDest(dest) {
    const p = this.prefs;
    const own = destHost(dest) === "localhost" ? destPort(dest) : 0;
    p.stopped = p.stopped.filter((x) => x !== own);
    if (!p.auto && !p.manual.includes(dest)) p.manual.push(dest); // auto is off: pin it instead
    this.changed(dest);
  }

  /**
   * Add a forward (old = null) or change one: where it points on the machine (any host:port reachable
   * from there, e.g. "localhost:5432", "db.internal:5432") and which local port it uses (null: the same
   * as the remote port, or the next free one; when editing, null keeps the current one). A taken local
   * port is reported and changes nothing.
   * @param {string | null} old @param {string} input host:port (or just a port) @param {number | null} local
   * @returns {Promise<Result>}
   */
  async saveForward(old, input, local) {
    const next = parseDest(input);
    if (!next) return { ok: false, message: `"${input}" isn't a valid host:port` };
    if (local !== null && !isPort(local)) return { ok: false, message: "The local port must be a number from 1 to 65535" };
    if (!old && this.forwards.has(next)) old = next; // "adding" what's already forwarded: edit that one
    const cur = old ? this.forwards.get(old) : undefined;
    if (old === next) {
      // Same destination: only the local port can change, and setLocal binds before it releases.
      if (local === null || local === cur?.local) return { ok: true, message: "Nothing to change" };
      return this.setLocal(next, local);
    }
    if (local !== null && local !== cur?.local) {
      const holder = await this.holderOf(local);
      if (holder) return { ok: false, message: `localhost:${local} is already used by ${holder}. Pick another local port.` };
    }
    const p = this.prefs;
    const own = (/** @type {string} */ d) => (destHost(d) === "localhost" ? destPort(d) : 0);
    if (old) {
      p.manual = p.manual.filter((x) => x !== old);
      if (this.detected.has(own(old)) && !p.stopped.includes(own(old))) p.stopped.push(own(old)); // a detected port: stop it
      delete p.local[old];
      this.problems.delete(old);
    }
    p.stopped = p.stopped.filter((x) => x !== own(next));
    if (!p.manual.includes(next)) p.manual.push(next);
    const keep = local ?? cur?.local; // pointing an existing forward elsewhere keeps its local port
    if (keep !== undefined && keep !== destPort(next)) p.local[next] = keep;
    this.changed(next);
    return { ok: true, message: old ? `Now forwarding ${showDest(next)}` : `Forwarding ${showDest(next)} from ${this.label}` };
  }

  /** What holds a local port right now, or "" when it's free. @param {number} port */
  async holderOf(port) {
    return (await portFree(port)) ? "" : this.whoHolds(port);
  }

  /** @param {boolean} on */
  setAuto(on) {
    this.prefs.auto = on;
    this.changed();
  }

  /**
   * Move a forward to a local port you pick. It binds the new port before releasing the old one, so a
   * taken port leaves the working forward alone.
   * @param {string} dest @param {number} local @returns {Promise<Result>}
   */
  setLocal(dest, local) {
    if (!isPort(local)) return Promise.resolve({ ok: false, message: "A port is a number from 1 to 65535" });
    return this.run(async () => {
      const cur = this.forwards.get(dest);
      if (cur?.local !== local && this.up && (cur || this.desired().has(dest))) {
        if (!(await this.bind(local, dest)))
          return { ok: false, message: `localhost:${local} is already used by ${await this.whoHolds(local)}. Pick another local port.` };
        if (cur) await this.unbind(cur.local, dest);
        const name = cur?.name ?? (destHost(dest) === "localhost" ? this.detected.get(destPort(dest)) : "") ?? "";
        this.forwards.set(dest, { local, name, note: "" });
        this.problems.delete(dest);
      }
      if (local === destPort(dest)) delete this.prefs.local[dest];
      else this.prefs.local[dest] = local;
      this.savePrefs();
      this.emit("change");
      return { ok: true, message: `${showDest(dest)} is now on localhost:${local}` };
    });
  }

  /** @param {string} [dest] a forward to retry even if it failed before */
  changed(dest) {
    if (dest !== undefined) this.problems.delete(dest);
    this.savePrefs();
    this.reconcile();
    this.emit("change");
  }

  /** Dests that should be forwarded right now. */
  desired() {
    const p = this.prefs;
    const want = new Set(p.manual);
    if (p.auto) for (const port of this.detected.keys()) if (!p.stopped.includes(port)) want.add(`localhost:${port}`);
    return want;
  }

  /** Queue one pass that makes the active forwards match desired(). */
  reconcile() {
    if (this.pending) return;
    this.pending = true;
    this.run(async () => {
      this.pending = false;
      // Read the generation now, not when queued: a pass queued by a dead connection must still
      // serve the new one, since the new one's request was folded into it.
      const generation = this.generation;
      if (!this.up) return;
      const want = this.desired();
      for (const dest of [...this.forwards.keys()]) if (!want.has(dest)) await this.unforward(dest);
      for (const dest of want)
        if (!this.forwards.has(dest) && !this.problems.has(dest)) await this.forward(dest, generation);
      this.emit("change");
    });
  }

  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  run(fn) {
    const result = this.queue.then(fn);
    this.queue = result.then(() => {}, (err) => log(`${this.label}: ${err.message}`));
    return result;
  }

  /** @param {string} dest @param {number} generation */
  async forward(dest, generation) {
    const port = destPort(dest);
    const wanted = this.prefs.local[dest] ?? port;
    const candidates = [...new Set([wanted, ...range(port)])];
    for (const local of candidates) {
      if (generation !== this.generation) return;
      if (!(await this.bind(local, dest))) continue;
      if (generation !== this.generation) return; // the connection died mid-way; its forwards went with it
      const name = destHost(dest) === "localhost" ? this.detected.get(port) ?? "" : "";
      const note = local === wanted ? "" : `localhost:${wanted} is used by ${await this.whoHolds(wanted)}`;
      this.forwards.set(dest, { local, name, note });
      log(`${this.label}: ${showDest(dest)} -> localhost:${local} ${name}`);
      this.emit("forward", { remote: showDest(dest), local, name, note });
      return;
    }
    // A dying master fails every attempt too; only report a real "everything is taken".
    // ponytail: such a forward isn't retried until you act on it in the panel or the machine reconnects;
    // a periodic retry would cover local ports freeing up on their own.
    if (generation === this.generation && (await this.mux("check"))) {
      this.problems.set(dest, `localhost:${port}-${port + SPAN - 1} are all in use (${port}: ${await this.whoHolds(port)})`);
      this.emit("busy", showDest(dest));
    }
  }

  /** @param {string} dest */
  async unforward(dest) {
    const f = this.forwards.get(dest);
    if (!f) return;
    await this.unbind(f.local, dest); // listed until its listener is really gone
    this.forwards.delete(dest);
    log(`${this.label}: ${showDest(dest)} closed`);
  }

  /** @param {number} local @param {string} dest */
  async bind(local, dest) {
    if (!(await this.mux("forward", `127.0.0.1:${local}:${dest}`))) return false;
    if (HAS_V6 && !(await this.mux("forward", `[::1]:${local}:${dest}`))) {
      await this.mux("cancel", `127.0.0.1:${local}:${dest}`);
      return false;
    }
    return true;
  }

  /** @param {number} local @param {string} dest */
  async unbind(local, dest) {
    await this.mux("cancel", `127.0.0.1:${local}:${dest}`);
    if (HAS_V6) await this.mux("cancel", `[::1]:${local}:${dest}`);
  }

  /**
   * Ask this machine's control master to add/cancel a local forward, or check it is alive.
   * @param {"forward" | "cancel" | "check"} op @param {string} [spec]
   * @returns {Promise<boolean>}
   */
  mux(op, spec) {
    const args = ["-F", "/dev/null", "-S", this.sock, "-O", op, ...(spec ? ["-L", spec] : []), "_"];
    return new Promise((resolve) => execFile("ssh", args, { timeout: 10_000 }, (err) => resolve(!err)));
  }

  /**
   * Start a command on the machine over the existing connection (no new login).
   * @param {string} command remote shell command
   * @returns {import("node:child_process").ChildProcess}
   */
  session(command) {
    return spawn("ssh", ["-F", "/dev/null", "-S", this.sock, "-o", "BatchMode=yes", "_", command], { stdio: ["pipe", "pipe", "pipe"] });
  }

  connect() {
    if (this.stopped) return;
    fs.rmSync(this.sock, { force: true }); // a crashed master's leftover socket would disable multiplexing
    const generation = ++this.generation;
    // The -o flags override ~/.ssh/config settings that would break a scripted session (RemoteCommand,
    // RequestTTY) or clash with your interactive one (its own forwards). BatchMode: no one can answer
    // a prompt here, so keys must come from ssh-agent or be passphrase-free.
    const child = spawn(
      "ssh",
      [
        "-M", "-S", this.sock,
        "-o", "BatchMode=yes", "-o", "ControlPersist=no",
        "-o", "RemoteCommand=none", "-o", "RequestTTY=no",
        "-o", "ClearAllForwardings=yes", "-o", "ExitOnForwardFailure=no",
        "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=3", "-o", "ServerAliveCountMax=3",
        "--", this.target, "sh", "-s",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    child.stdin?.on("error", () => {});
    child.stdin?.end(WATCH_SCRIPT);

    let fatal = "";
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    readline.createInterface({ input: /** @type {import("node:stream").Readable} */ (child.stdout) }).on("line", (line) => {
      if (generation !== this.generation) return;
      let m;
      if (line === "=ready") {
        this.up = true;
        this.ever = true;
        this.delay = 1000;
        this.setStatus("connected", "");
        this.reconcile(); // forwards you added don't wait for detection
      } else if (line.startsWith("=fatal ")) {
        fatal = line.slice(7);
      } else if (!this.up) {
        // login-shell noise printed before =ready
      } else if ((m = /^\+(\d+)(?: (.*))?$/.exec(line))) {
        this.detected.set(Number(m[1]), printable(m[2] ?? "").slice(0, 64));
        this.reconcile();
        this.emit("change");
      } else if ((m = /^-(\d+)$/.exec(line))) {
        this.detected.delete(Number(m[1]));
        this.reconcile();
        this.emit("change");
      } else if ((m = /^=ui (\/[\w./-]+\/ui\.[A-Za-z0-9]+) (\d+) (\d+)$/.exec(line))) {
        this.emit("ui", { dir: m[1], rows: Number(m[2]), cols: Number(m[3]) });
      } // anything else: heartbeats
    });

    child.on("error", (err) => log(`${this.label}: ssh failed to start: ${err.message}`));
    child.on("close", (code) => {
      if (this.child === child) this.child = null;
      const wasUp = this.up;
      this.up = false;
      this.detected.clear(); // the next watcher reports everything again
      this.forwards.clear(); // they closed with the master
      this.problems.clear();
      this.emit("change");
      if (this.stopped) return;
      const reason = printable(fatal || (wasUp ? "connection lost" : lastLine(stderr) || `ssh exited with status ${code}`));
      const delay = fatal ? MAX_DELAY_MS : this.delay;
      log(`${this.label}: ${reason}; retrying in ${delay / 1000}s`);
      this.setStatus("retrying", reason);
      this.timer = setTimeout(() => this.connect(), delay);
      this.delay = Math.min(Math.max(this.delay, 500) * 2, MAX_DELAY_MS);
    });
  }

  /** @param {Status} status @param {string} error */
  setStatus(status, error) {
    const prev = this.status;
    if (prev === status && this.error === error) return;
    this.status = status;
    this.error = error;
    this.emit("status", status, prev, error);
    this.emit("change");
  }
}

/** Whether localhost:port is free here, tested the way forwards bind it (127.0.0.1 and ::1). @param {number} port */
export function portFree(port) {
  const tryBind = (/** @type {string} */ host) =>
    new Promise((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen({ host, port, exclusive: true }, () => s.close(() => resolve(true)));
    });
  return tryBind("127.0.0.1").then((ok) => ok && (!HAS_V6 || tryBind("::1")));
}

/** @param {number} port */
function range(port) {
  const out = [];
  for (let local = port; local < port + SPAN && local <= 65535; local++) out.push(local);
  return out;
}

/** @param {string} text */
function lastLine(text) {
  return text.trim().split("\n").pop()?.trim() ?? "";
}
