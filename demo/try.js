#!/usr/bin/env node
// @ts-check
// Try the Ports panel in your terminal with no servers: the real panel, driven by two pretend machines
// whose ports come and go, including a clash between them and a local program in the way.
// Run: npm run demo   (q quits)
import { PassThrough } from "node:stream";
import { Panel } from "../src/panel.js";
import { createSim } from "./sim.js";

const sim = createSim(["dev-server", "gpu-box"], { 8080: "node (pid 4242) on this computer" }); // pretend you run something here

// What happens on the pretend machines: a dev server, a clash, a local program in the way, and a CLI
// login (wrangler login) whose OAuth callback port opens and closes.
sim.listen("dev-server", 3000, "node");
const script = [
  [1500, () => sim.listen("dev-server", 5173, "vite")],
  [3500, () => sim.listen("gpu-box", 5173, "vite")],
  [5500, () => sim.listen("gpu-box", 8080, "jupyter")],
  [7500, () => sim.listen("dev-server", 8976, "node")],
  [15000, () => sim.close("dev-server", 8976)],
];
for (const [ms, fn] of /** @type {[number, () => void][]} */ (script)) setTimeout(fn, ms).unref();

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Run this in a terminal: npm run demo");
  process.exit(1);
}
const out = new PassThrough();
out.pipe(process.stdout, { end: false });
process.stdin.setRawMode(true);
const panel = new Panel(sim.api, {
  input: process.stdin,
  output: out,
  rows: process.stdout.rows,
  cols: process.stdout.columns,
  open: (url) => panel.say(`In real use this opens ${url} in your browser`, ""),
  onClose: () => (process.stdin.setRawMode(false), process.exit(0)),
});
process.stdout.on("resize", () => panel.input(`\x1b[8;${process.stdout.rows};${process.stdout.columns}t`));
