#!/usr/bin/env node
// @ts-check
// Entry point for the manifest commands (start, ports, restart, ports-ui) plus status/stop for a
// terminal and `daemon`, which start() spawns in the background.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROL_SOCK, HERDR, PLUGIN_ID, STATE_DIR, connectable, ensureRunDir, request, sleep } from "./common.js";

const LOG_MAX_BYTES = 1_000_000;

/** Make sure the daemon is running and knows about this herdr server; spawn it when needed. */
async function start() {
  const attach = { cmd: "attach", socket: process.env.HERDR_SOCKET_PATH ?? "" };
  if (await request(attach).then(() => true, () => false)) return;
  ensureRunDir();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const logPath = path.join(STATE_DIR, "daemon.log");
  const tooBig = fs.existsSync(logPath) && fs.statSync(logPath).size > LOG_MAX_BYTES;
  const logFd = fs.openSync(logPath, tooBig ? "w" : "a");
  spawn(process.execPath, [fileURLToPath(import.meta.url), "daemon"], { detached: true, stdio: ["ignore", logFd, logFd] }).unref();
  fs.closeSync(logFd);
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await request(attach).then(() => true, () => false)) return;
  }
  throw new Error(`autofwd daemon did not start; see ${logPath}`);
}

async function stop() {
  if (!(await request({ cmd: "stop" }).then(() => true, () => false))) return;
  for (let i = 0; i < 30 && (await connectable(CONTROL_SOCK)); i++) await sleep(100);
}

/** Open the Ports panel as a floating window (the manifest's popup). */
async function ports() {
  await start();
  const r = spawnSync(HERDR, ["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "ports-ui"], { stdio: "inherit" });
  process.exitCode = r.status ?? 1;
}

async function status() {
  const { describe } = await import("./ui.js");
  console.log(describe(await request({ cmd: "status" }).catch(() => null)));
}

/** @type {Record<string, () => Promise<void>>} */
const commands = {
  start,
  stop,
  restart: async () => (await stop(), await start()),
  ports,
  status,
  "ports-ui": async () => (await import("./ui.js")).relay(),
  daemon: async () => (await import("./daemon.js")).main(),
};

const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error(`usage: cli.js ${Object.keys(commands).join("|")}`);
  process.exit(2);
}
await command().catch((err) => {
  console.error(`autofwd: ${err.message}`);
  process.exit(1);
});
