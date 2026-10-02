// @ts-check
// Paths, the herdr binary, and the daemon's control socket, shared by every entry point.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "autofwd";
export const HERDR = process.env.HERDR_BIN_PATH || "herdr";
// Outside herdr (cli.js in a plain terminal) fall back to the dir herdr gives the plugin, so both find
// the same daemon.
export const STATE_DIR =
  process.env.HERDR_PLUGIN_STATE_DIR ||
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "herdr", "plugins", PLUGIN_ID);
// Sockets live in a short temp dir, one per herdr setup (its plugin state dir), so two herdr homes for the
// same user never share or stop each other's daemon. Unix socket paths max out at 103 bytes, and ssh
// creates "<dir>/<10-char name>.<16 random chars>" first, so a long $TMPDIR falls back to /tmp.
const setup = crypto.createHash("sha256").update(canonical(STATE_DIR)).digest("hex").slice(0, 8);
const runName = `afwd-${os.userInfo().uid}-${setup}`;
export const SOCKET_ROOM = 1 + 10 + 17; // "/" + machine socket name + ssh's temporary suffix
export const RUN_DIR =
  process.env.AUTOFWD_RUN_DIR ||
  [path.join(os.tmpdir(), runName), path.join("/tmp", runName)].find((d) => d.length + SOCKET_ROOM <= 103) ||
  path.join("/tmp", runName);
export const CONTROL_SOCK = path.join(RUN_DIR, "daemon.sock");

/**
 * One spelling per directory ("a//b", symlinks), so herdr's path and the plain-terminal fallback agree.
 * @param {string} dir
 */
function canonical(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** Create RUN_DIR private to this user, and refuse one someone else could have planted in a shared /tmp. */
export function ensureRunDir() {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(RUN_DIR);
  if (!st.isDirectory() || st.uid !== os.userInfo().uid || (st.mode & 0o077) !== 0)
    throw new Error(`${RUN_DIR} must be a directory owned by you with mode 700`);
}

/** @param {string} sock */
export function connectable(sock) {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    c.once("connect", () => (c.destroy(), resolve(true)));
    c.once("error", () => resolve(false));
  });
}

/**
 * Send one request to the daemon; rejects when no daemon is listening.
 * @param {{cmd: string, [key: string]: unknown}} msg
 * @returns {Promise<any>}
 */
export function request(msg, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(CONTROL_SOCK);
    let data = "";
    conn.setTimeout(timeoutMs, () => conn.destroy(new Error("autofwd daemon did not answer")));
    conn.on("connect", () => conn.write(JSON.stringify(msg) + "\n"));
    conn.on("data", (d) => (data += d));
    conn.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("bad reply from autofwd daemon"));
      }
    });
    conn.on("error", reject);
  });
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {...unknown} args */
export const log = (...args) => console.error(new Date().toISOString(), ...args);
