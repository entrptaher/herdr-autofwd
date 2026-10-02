// @ts-check
// On this computer the Ports panel's terminal (the herdr popup, or any terminal) is a plain relay: keys go
// to the panel inside the daemon, the screen comes back. Also the text behind `cli.js status`.
import net from "node:net";
import { CONTROL_SOCK } from "./common.js";

export function relay() {
  const { stdin, stdout } = process;
  stdin.setRawMode?.(true);
  /** @type {net.Socket | null} */
  let conn = null;
  stdin.on("data", (d) => conn?.write(d));
  stdout.on("resize", () => conn?.write(`\x1b[8;${stdout.rows};${stdout.columns}t`));
  const connect = (/** @type {number} */ attempt) => {
    const c = net.connect(CONTROL_SOCK);
    let up = false;
    c.on("connect", () => {
      up = true;
      conn = c;
      c.write(JSON.stringify({ cmd: "panel", rows: stdout.rows, cols: stdout.columns }) + "\n");
    });
    c.on("data", (d) => stdout.write(d));
    c.on("error", () => {});
    c.on("close", () => {
      if (up) return process.exit(0); // the panel closed
      if (attempt < 20) return void setTimeout(() => connect(attempt + 1), 150); // the daemon may be starting
      stdout.write('\r\n  Port forwarding isn\'t running.\r\n  It starts with herdr; or run the "Restart port forwarding" action.\r\n\r\n  Press any key to close.');
      stdin.once("data", () => process.exit(1));
    });
  };
  connect(0);
}

/** @param {any} status a daemon status reply, or null when the daemon isn't running */
export function describe(status) {
  if (!status) return "Port forwarding is not running.";
  if (!status.machines.length) return "No saved SSH machines yet. Add one with: herdr machine add <host>";
  return status.machines
    .map((/** @type {any} */ m) => {
      const head = `${m.label}  ${m.status}${m.error ? `: ${m.error}` : ""}${m.auto ? "" : "  (auto-forward off)"}`;
      const ports = m.ports.map((/** @type {any} */ p) =>
        `  ${p.remote}`.padEnd(24) + (p.local === null ? p.state : `localhost:${p.local}`).padEnd(22) + `${p.name}${p.manual ? " (added)" : ""}${p.note ? `  ${p.note}` : ""}`);
      return [head, ...(ports.length ? ports : ["  no listening ports"])].join("\n");
    })
    .join("\n\n");
}
