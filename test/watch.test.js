// @ts-check
// The port watcher's macOS side, on any OS: uname, ps and lsof are faked with what a Mac reports, so
// this checks which listeners count. Only programs with a terminal on them or above them do; the
// Linux side is covered by the end-to-end test against a real server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afw-watch-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fake = (/** @type {string} */ name, /** @type {string} */ body) =>
  fs.writeFileSync(path.join(tmp, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
fs.mkdirSync(path.join(tmp, "bin"));
fake("uname", "echo Darwin");
fake("ps", 'cat "$FAKE_DIR/ps"');
// Honors -p like the real one: only the listed processes' sockets.
fake("lsof", `while [ $# -gt 0 ]; do [ "$1" = -p ] && pids=$2; shift; done
awk -v pids=",$pids," '/^p/ { keep = index(pids, "," substr($0, 2) ",") > 0 } keep' "$FAKE_DIR/lsof"`);

// pid ppid tdev, as \`ps -axo pid=,ppid=,tdev=\` prints them
const PS = `
    1     0   ??
  747     1   ??
  988     1   ??
 1618   988   ??
  500     1   ??
  600     1 16/4
  601   600 16/4
  700   500 16/5
  701   700   ??
  702   701   ??
  800   600 16/4
`;
/** @param {Record<number, [string, string[]]>} procs pid -> [command, addresses] */
const lsof = (procs) =>
  Object.entries(procs).map(([pid, [cmd, addrs]]) => `p${pid}\nc${cmd}\n${addrs.map((a, i) => `f${10 + i}\nn${a}\n`).join("")}`).join("");
const LISTENERS = {
  747: ["ControlCenter", ["*:5000", "*:7000"]], // AirPlay, started by launchd
  1618: ["node", ["127.0.0.1:23654"]], // an app's helper: no terminal above it either
  601: ["vite", ["*:5173", "[::1]:5173"]], // a pane whose herdr server was replaced by a live handoff
  702: ["python3", ["127.0.0.1:8000", "192.168.1.5:9000"]], // started in the background by an agent in a pane
  800: ["Some Server", ["10.0.0.2:3000"]], // only on one interface: localhost can't reach it
};

test("macOS watcher: forwards what was started from a terminal, skips apps and agents of launchd", async () => {
  fs.writeFileSync(path.join(tmp, "ps"), PS);
  fs.writeFileSync(path.join(tmp, "lsof"), lsof(LISTENERS));
  const child = spawn("sh", [path.join(ROOT, "src/watch.sh")], {
    env: { ...process.env, PATH: `${tmp}/bin:${process.env.PATH}`, HOME: tmp, FAKE_DIR: tmp },
  });
  /** @type {string[]} */
  const lines = [];
  /** @type {() => void} */
  let wake = () => {};
  readline.createInterface({ input: child.stdout }).on("line", (l) => {
    if (l) lines.push(l);
    wake();
  });
  const until = (/** @type {string} */ line) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no "${line}" in ${JSON.stringify(lines)}`)), 5000);
      wake = () => lines.includes(line) && (clearTimeout(timer), resolve(undefined));
      wake();
    });
  try {
    await until("+8000 python3");
    assert.deepEqual(lines, ["=ready", "+5173 vite", "+8000 python3"]);

    const { 601: _, ...rest } = LISTENERS; // vite stops
    fs.writeFileSync(path.join(tmp, "lsof"), lsof(rest));
    await until("-5173");
    assert.deepEqual(lines, ["=ready", "+5173 vite", "+8000 python3", "-5173"]);
  } finally {
    child.kill();
  }
});
