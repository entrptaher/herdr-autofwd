// The browser demo: the real Ports panel (src/panel.js) running in xterm.js over pretend machines
// (demo/sim.js), with a server shell to type in, the tunnels drawn live, scenarios and a tour (#tour
// plays it on load). build.js inlines this and its imports into one page.
import { Panel } from "../../src/panel.js";
import { destPort, indicator } from "../../src/text.js";
import { createSim } from "../sim.js";
import { LINES } from "./lines.js";

/* global Terminal, FitAddon */
const MACHINES = ["dev-server", "gpu-box"];
const sim = createSim(MACHINES);
const $ = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const esc = (/** @type {unknown} */ s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const allRows = () => sim.state.machines.flatMap((m) => m.ports.map((r) => ({ ...r, m, key: `${m.id}|${r.dest}` })));
const rowOf = (/** @type {string} */ id, /** @type {number} */ port) => sim.state.machines.find((m) => m.id === id)?.ports.find((r) => r.dest === `localhost:${port}`);

const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
// herdr's palette, so the panel looks the way it does in herdr
const THEME = {
  background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc", cursorAccent: "#1e1e2e", selectionBackground: "#585b70",
  black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af", blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
  brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#f5c2e7", brightCyan: "#94e2d5", brightWhite: "#a6adc8",
};

// ---- the server shells ----

const C = { r: "\x1b[0m", b: "\x1b[1m", d: "\x1b[2m", g: "\x1b[32m", c: "\x1b[36m", bl: "\x1b[34m" };
const prompt = (/** @type {string} */ id) => `${C.b}${C.g}dev@${id}${C.r}:${C.b}${C.bl}~/app${C.r}$ `;
const HELP = `${C.d}This pretend server knows: npm run dev, python3 -m http.server [port], jupyter lab, node server.js, npx wrangler login, ls, clear. ctrl+c stops a server.${C.r}\r\n`;
/** What each server prints, and its process name as the port watcher reports it. */
const KINDS = {
  vite: { name: "node", banner: (/** @type {number} */ p) => `\r\n  ${C.b}${C.g}VITE${C.r} ${C.g}v5.4.8${C.r}  ${C.d}ready in${C.r} ${C.b}312${C.r} ${C.d}ms${C.r}\r\n\r\n  ${C.g}➜${C.r}  ${C.b}Local${C.r}:   ${C.c}http://localhost:${C.b}${p}${C.r}${C.c}/${C.r}\r\n  ${C.g}➜${C.r}  ${C.d}Network: use --host to expose${C.r}\r\n` },
  python: { name: "python3", banner: (/** @type {number} */ p) => `Serving HTTP on 0.0.0.0 port ${p} (http://0.0.0.0:${p}/) ...\r\n` },
  jupyter: { name: "jupyter-lab", banner: (/** @type {number} */ p) => `[I ServerApp] Jupyter Server 2.14.2 is running at:\r\n[I ServerApp] http://localhost:${p}/lab?token=5c1f0e8a9b2d\r\n[I ServerApp] Use Control-C to stop this server.\r\n` },
  node: { name: "node", banner: (/** @type {number} */ p) => `Listening on http://localhost:${p}\r\n` },
};

/** @typedef {{kind: string, port: number}} Job */
/** @type {Record<string, {log: string, line: string, job: Job | null}>} */
const shells = {};
let current = MACHINES[0];
let prefix = false; // ctrl+b was pressed: herdr's prefix key
/** @type {any} */ let shellTerm;
/** @type {any} */ let fitShell;
/** @type {any} */ let panelTerm;
/** @type {any} */ let fitPanel;
/** @type {Panel | null} */ let panel = null;
/** @type {((d: string) => void) | null} */ let panelSink = null;

function out(/** @type {string} */ id, /** @type {string} */ text) {
  const sh = shells[id];
  sh.log += text;
  if (sh.log.length > 40000) sh.log = sh.log.slice(sh.log.indexOf("\n", sh.log.length - 30000) + 1);
  if (id === current) shellTerm.write(text);
}

/** Show a machine, the way clicking it in herdr's sidebar does. @param {string} id */
function show(id, force = false) {
  if (id === current && !force) return;
  current = id;
  document.querySelectorAll(".side .m[data-machine]").forEach((b) => b.classList.toggle("on", /** @type {HTMLElement} */ (b).dataset.machine === id));
  $("#wintitle").textContent = `herdr · ${id}`;
  shellTerm.write(`\x1bc${shells[id].log}`); // reset in the write stream: reset() would run before queued writes
  renderIndicator();
}

/** Keys typed into a machine's shell, by you or by a scenario. @param {string} id @param {string} data */
function type(id, data) {
  const sh = shells[id];
  if (prefix) return void ((prefix = false), data === "f" && openPanel());
  if (data === "\x02") return void (prefix = true);
  if (data.startsWith("\x1b")) return; // arrows and such: nothing to do in this shell
  for (const ch of data) {
    if (sh.job) return void (ch === "\x03" && stopJob(id));
    if (ch === "\r") {
      const line = sh.line.trim();
      sh.line = "";
      out(id, "\r\n");
      run(id, line);
    } else if (ch === "\x7f" || ch === "\b") {
      if (sh.line) (sh.line = sh.line.slice(0, -1)), out(id, "\b \b");
    } else if (ch === "\x03") {
      sh.line = "";
      out(id, `^C\r\n${prompt(id)}`);
    } else if (ch === "\x0c") {
      sh.log = "";
      out(id, `\x1b[2J\x1b[3J\x1b[H${prompt(id)}${sh.line}`);
    } else if (/^[\x20-\x7e -￿]$/u.test(ch) && sh.line.length < 200) {
      sh.line += ch;
      out(id, ch);
    }
  }
}

/** @param {string} id @param {string} cmd */
function run(id, cmd) {
  let m;
  if (!cmd) return out(id, prompt(id));
  if (/^(?:npm run dev|pnpm(?: run)? dev|yarn dev|npx vite|vite)$/.test(cmd)) return serve(id, "vite", 5173);
  if ((m = /^python3? -m http\.server(?:\s+(\d{1,6}))?$/.exec(cmd))) return serve(id, "python", m[1] ? Number(m[1]) : 8000);
  if (/^jupyter[ -](?:lab|notebook)$/.test(cmd)) return serve(id, "jupyter", 8888);
  if (/^node server(?:\.js)?$/.test(cmd)) return serve(id, "node", 3000);
  if (/^(?:npx )?wrangler login$/.test(cmd)) return login(id);
  if (cmd === "clear") return type(id, "\x0c");
  if (cmd === "ls") return out(id, `app.py  notebooks  package.json  server.js  src\r\n${prompt(id)}`);
  if (cmd === "help") return out(id, HELP + prompt(id));
  out(id, `bash: ${cmd.split(/\s+/)[0]}: command not found\r\n${HELP}${prompt(id)}`);
}

/** A server starts; the port watcher sees it a moment later. @param {string} id @param {keyof KINDS} kind @param {number} port */
function serve(id, kind, port) {
  if (port === 0) port = 40000 + Math.floor(Math.random() * 20000);
  if (port > 65535) return out(id, `OverflowError: bind(): port must be 0-65535.\r\n${prompt(id)}`);
  if (port < 1024) return out(id, `PermissionError: [Errno 13] Permission denied\r\n${prompt(id)}`);
  const job = { kind, port };
  shells[id].job = job;
  setTimeout(() => {
    if (shells[id].job !== job) return;
    out(id, KINDS[kind].banner(port));
    sim.listen(id, port, KINDS[kind].name);
  }, kind === "vite" ? 450 : 250);
}

/** @param {string} id */
function stopJob(id) {
  const job = shells[id].job;
  if (!job) return;
  shells[id].job = null;
  out(id, `^C${job.kind === "python" ? "\r\nKeyboard interrupt received, exiting." : ""}\r\n${prompt(id)}`);
  sim.close(id, job.port);
}

/** A CLI login: it listens on its OAuth callback port and waits for the browser's redirect. @param {string} id */
function login(id) {
  const job = { kind: "login", port: 8976 };
  shells[id].job = job;
  out(id, `Attempting to login via OAuth...\r\nOpening a link in your default browser: ${C.c}https://dash.cloudflare.com/oauth2/auth?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Foauth%2Fcallback${C.r}\r\n`);
  setTimeout(() => shells[id].job === job && sim.listen(id, 8976, "node"), 300);
  setTimeout(() => callback(id, job), 2600); // you approve in the browser, which redirects to localhost:8976
}

/** @type {(() => void) | null} */ let retry = null;
/** The browser on your laptop follows the redirect to localhost:8976. @param {string} id @param {Job} job */
function callback(id, job) {
  if (shells[id].job !== job) return;
  const row = rowOf(id, 8976);
  const url = "http://localhost:8976/oauth/callback?code=f3b9c2";
  if (row?.local !== 8976) {
    retry = () => callback(id, job);
    const where = row?.local ? `localhost:${row.local}` : "nowhere";
    return browse(url, `<div class="site down"><h3>This site can't be reached</h3><p>localhost refused to connect. The callback needs port 8976 itself, and the forward is at ${where} right now. Free 8976 on your laptop, then press e in the Ports panel and set the local port to 8976.</p><button class="btn retry" type="button">Try again</button></div>`, "");
  }
  browse(url, `<div class="site done"><div class="ok">✓</div><h3>Login complete</h3><p>wrangler got its OAuth callback. You can close this tab.</p></div>`, `localhost:8976 → ${id}:8976 over SSH`);
  setTimeout(() => {
    if (shells[id].job !== job) return;
    shells[id].job = null;
    out(id, `Successfully logged in.\r\n${prompt(id)}`);
    sim.close(id, 8976);
  }, 1300);
}

// ---- a browser on your laptop ----

const SITES = {
  vite: () => `<div class="site vite"><svg width="46" height="46" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2 4 13.5h6.2L9 22l10-12.2h-6.4z" fill="#ffd62e"/></svg><h3>Vite + React</h3><button class="count" type="button">count is 0</button><p>Edit <code>src/App.tsx</code> and save to test HMR</p></div>`,
  python: () => `<div class="site list"><h3>Directory listing for /</h3><ul>${["app.py", "notebooks/", "package.json", "server.js", "src/"].map((f) => `<li><a>${f}</a></li>`).join("")}</ul></div>`,
  jupyter: () => `<div class="site jupyter"><div class="hd">jupyter</div>${[["analysis.ipynb", "2 minutes ago"], ["train.py", "an hour ago"], ["data/", "yesterday"]].map(([f, t]) => `<div class="f">${f}<span>${t}</span></div>`).join("")}</div>`,
  node: (/** @type {any} */ r) => `<div class="site json">{<br>&nbsp;&nbsp;"ok": true,<br>&nbsp;&nbsp;"host": "${esc(r.m.id)}",<br>&nbsp;&nbsp;"port": ${destPort(r.dest)}<br>}</div>`,
};

/** @param {string} url @param {string} html @param {string} via */
function browse(url, html, via) {
  $("#url").textContent = url;
  $("#site").innerHTML = html;
  $("#via").textContent = via;
  $("#via").hidden = !via;
  $("#browser").hidden = false;
}
const closeBrowser = () => ($("#browser").hidden = true);

/** "Open in browser" from the panel or a scenario. @param {string} url */
function openLocal(url) {
  const local = Number(new URL(url).port);
  const r = allRows().find((x) => x.local === local);
  panel?.say(`Opened ${url}`, "ok");
  if (!r) return browse(url, `<div class="site down"><h3>This site can't be reached</h3><p>Nothing is forwarded to localhost:${local}.</p></div>`, "");
  const job = shells[r.m.id].job;
  const kind = job && r.dest === `localhost:${job.port}` ? job.kind : "";
  if (kind === "login") return callback(r.m.id, /** @type {Job} */ (job));
  const site = SITES[/** @type {keyof SITES} */ (kind)] ?? SITES.node;
  browse(url, site(r), `localhost:${local} → ${r.m.label}:${r.remote} over SSH`);
}

// ---- the Ports panel, in herdr's floating popup ----

function openPanel() {
  if (panel) return panelTerm.focus();
  $("#popup").hidden = false;
  if (!panelTerm.element) panelTerm.open($("#panel"));
  fitPanel.fit();
  panel = new Panel(sim.api, {
    input: /** @type {any} */ ({ on: (/** @type {string} */ ev, /** @type {any} */ fn) => ev === "data" && (panelSink = fn) }),
    output: /** @type {any} */ ({ write: (/** @type {string} */ s) => panelTerm.write(s), end() {}, on() {} }),
    rows: panelTerm.rows,
    cols: panelTerm.cols,
    focus: current,
    open: openLocal,
    copy: (url) => navigator.clipboard?.writeText(url).catch(() => {}),
    onClose: () => {
      panel = panelSink = null;
      $("#popup").hidden = true;
      shellTerm.focus();
    },
  });
  panelTerm.focus();
}
const closePanel = () => panel?.close();

function renderIndicator() {
  const text = indicator(sim.state.machines.find((m) => m.id === current)?.ports ?? []);
  const el = $("#indicator");
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 900);
}

// ---- the tunnel map ----

/** @type {Set<string> | null} */ let drawn = null;
let mapQueued = false;
function scheduleMap() {
  if (mapQueued) return;
  mapQueued = true;
  requestAnimationFrame(() => ((mapQueued = false), renderMap()));
}

function renderMap() {
  const rows = allRows();
  const seen = new Set();
  const fresh = (/** @type {string} */ key) => (seen.add(key), drawn && !drawn.has(key) ? " new" : "");
  const laptop = [
    ...rows.filter((r) => r.local !== null).map((r) => {
      const moved = Boolean(r.note);
      const why = moved ? " · moved" : "";
      return { port: /** @type {number} */ (r.local), html: `<div class="chip ${moved ? "moved" : "live"}${fresh(`L${r.key}`)}" data-l="${esc(r.key)}"><b>localhost:${r.local}</b><small>${esc(r.m.label)}:${esc(r.remote)}${why}</small></div>` };
    }),
    ...[...sim.localPrograms].map(([port, holder]) => ({ port, html: `<div class="chip yours${fresh(`P${port}`)}"><b>localhost:${port}</b><small>${esc(holder.replace(/ on this computer$/, ""))} · already yours</small></div>` })),
  ].sort((a, b) => a.port - b.port);
  const boxes = sim.state.machines.map((m) => {
    const chips = m.ports.map((r) => {
      const key = `${m.id}|${r.dest}`;
      const cls = r.state === "forwarded" ? (r.note ? "moved" : "live") : r.state === "busy" ? "bad" : "off";
      const label = r.dest.startsWith("localhost:") ? `:${r.remote}` : r.remote;
      const what = r.state === "forwarded" ? r.name || "added by you" : r.state === "busy" ? "no free local port" : r.state;
      return `<div class="chip ${cls}${fresh(`R${key}`)}" data-r="${esc(key)}"><b>${esc(label)}</b><small>${esc(what)}</small></div>`;
    });
    return `<div class="box"><div class="mh">${esc(m.label)}<span>● <em>connected</em></span></div>${chips.join("") || `<div class="empty">nothing listening</div>`}</div>`;
  });
  const body = $("#map");
  body.innerHTML = `<div class="lap"><div class="colh">your laptop</div>${laptop.map((l) => l.html).join("") || `<div class="empty">Nothing forwarded yet. Start something on a server.</div>`}</div><div></div><div class="srv"><div class="colh">servers</div>${boxes.join("")}</div>`;

  const box = body.getBoundingClientRect();
  const k = box.width / body.offsetWidth || 1; // the video's camera may be zoomed in
  const wires = rows.filter((r) => r.local !== null).map((r) => {
    const a = body.querySelector(`[data-l="${CSS.escape(r.key)}"]`)?.getBoundingClientRect();
    const b = body.querySelector(`[data-r="${CSS.escape(r.key)}"]`)?.getBoundingClientRect();
    if (!a || !b) return "";
    const x1 = (a.right - box.left) / k, y1 = (a.top + a.height / 2 - box.top) / k;
    const x2 = (b.left - box.left) / k, y2 = (b.top + b.height / 2 - box.top) / k;
    const dx = (x2 - x1) * 0.55;
    const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    const color = r.note ? "var(--moved)" : "var(--live)";
    return `<path class="wire base" d="${d}" style="stroke:${color}"/><path class="wire flow${fresh(`W${r.key}`)}" d="${d}" style="stroke:${color}"/>`;
  });
  body.insertAdjacentHTML("afterbegin", `<svg aria-hidden="true">${wires.join("")}</svg>`);
  drawn = seen;
}

// ---- scenarios and the tour ----

const STOP = Symbol("stop");
let runId = 0;
let active = 0; // the run in progress, 0 when none
const cancel = () => ((runId++), (active = 0), mark(null));
/** @param {string | null} name */
const mark = (name) => document.querySelectorAll("#scenarios button").forEach((b) => b.classList.toggle("on", /** @type {HTMLElement} */ (b).dataset.s === name));

/** @typedef {{wait: (ms: number) => Promise<void>}} Ctx */
/** Run a scenario; starting another, or typing yourself, stops it. @param {string | null} name @param {(ctx: Ctx) => Promise<void>} fn */
async function play(name, fn) {
  const id = ++runId;
  active = id;
  mark(name);
  /** @type {Ctx} */
  const ctx = { wait: async (ms) => { await sleep(ms); if (id !== runId) throw STOP; } };
  try {
    await fn(ctx);
  } catch (err) {
    if (err !== STOP) throw err;
  } finally {
    if (id === runId) (active = 0), mark(null);
  }
}

/** @param {string} step @param {string} html */
function caption(step, html) {
  $("#step").textContent = step;
  const el = $("#caption");
  el.classList.remove("words");
  el.innerHTML = html;
  el.classList.remove("fade");
  void el.offsetWidth;
  el.classList.add("fade");
}
const IDLE = "Type a command in the shell, press <code>ctrl+b f</code> for the Ports panel, or pick a scenario.";

/** Show keys being pressed. @param {...string} keys */
function keycap(...keys) {
  $("#keys").innerHTML = keys.map((k) => `<kbd>${esc(k)}</kbd>`).join("");
}

/** @param {Ctx} ctx @param {string} id @param {string} text */
async function typeCmd(ctx, id, text) {
  show(id);
  await ctx.wait(300);
  for (const ch of text) type(id, ch), await ctx.wait(35 + Math.random() * 45);
  await ctx.wait(250);
  type(id, "\r");
}

/** Stop whatever runs in a machine's shell. @param {Ctx} ctx @param {string} id */
async function idle(ctx, id) {
  if (!shells[id].job) return;
  show(id);
  await ctx.wait(300);
  keycap("ctrl+c");
  stopJob(id);
  await ctx.wait(800);
}

/** @param {Ctx} ctx @param {string} label @param {string} seq @param {number} [ms] */
async function press(ctx, label, seq, ms = 550) {
  keycap(label);
  panel?.input(seq);
  await ctx.wait(ms);
}

/** Replace the form's focused number with another. @param {Ctx} ctx @param {number} from @param {number} to */
async function retype(ctx, from, to) {
  for (const _ of String(from)) panel?.input("\x7f"), await ctx.wait(60);
  keycap(String(to));
  for (const ch of String(to)) panel?.input(ch), await ctx.wait(110);
  await ctx.wait(300);
}

/** Open the panel from the machine that has `key` and move the selection to it. @param {Ctx} ctx @param {string} key */
async function panelOn(ctx, key) {
  show(key.split("|")[0]);
  keycap("ctrl+b", "f");
  await ctx.wait(350);
  openPanel();
  await ctx.wait(900);
  const keys = panel?.portRows().map((r) => r.key) ?? [];
  const steps = keys.indexOf(key) - keys.indexOf(panel?.selectedRow()?.key ?? "");
  for (let i = 0; i < Math.abs(steps); i++) await press(ctx, steps > 0 ? "↓" : "↑", steps > 0 ? "\x1b[B" : "\x1b[A", 380);
}

const freePort = (/** @type {number} */ from) => {
  while (sim.whoHolds(from)) from++;
  return from;
};

/** @type {Record<string, (ctx: Ctx) => Promise<void>>} */
const SCENARIOS = {
  async dev(ctx) {
    closePanel();
    caption("scenario", "Running <code>npm run dev</code> on dev-server…");
    await idle(ctx, "dev-server");
    await typeCmd(ctx, "dev-server", "npm run dev");
    await ctx.wait(1300);
    caption("scenario", "dev-server's 5173 is on your laptop at <code>localhost:5173</code>, a moment after it started listening.");
  },
  async clash(ctx) {
    closePanel();
    if (shells["dev-server"].job?.port !== 5173) await SCENARIOS.dev(ctx);
    caption("scenario", "Now gpu-box starts the same dev server, on the same port…");
    await idle(ctx, "gpu-box");
    await typeCmd(ctx, "gpu-box", "npm run dev");
    await ctx.wait(1300);
    const r = rowOf("gpu-box", 5173);
    if (r?.local) caption("scenario", `gpu-box's 5173 is at <code>localhost:${r.local}</code>. ${esc(r.note || "")}.`);
  },
  async mine(ctx) {
    closePanel();
    sim.holdLocal(8888, "python3 (pid 5120) on this computer");
    caption("scenario", "Something on your laptop already listens on 8888. Now Jupyter starts on gpu-box…");
    await ctx.wait(1200);
    await idle(ctx, "gpu-box");
    await typeCmd(ctx, "gpu-box", "jupyter lab");
    await ctx.wait(1300);
    const r = rowOf("gpu-box", 8888);
    if (r?.local) caption("scenario", `Jupyter is at <code>localhost:${r.local}</code>. ${esc(r.note || "")}.`);
  },
  async edit(ctx) {
    closePanel();
    if (!allRows().some((r) => r.local !== null)) await SCENARIOS.clash(ctx);
    const forwarded = allRows().filter((r) => r.local !== null);
    const target = forwarded.find((r) => r.note) ?? forwarded[0];
    caption("scenario", "Open the panel and edit a forward: remote host, remote port, local port.");
    await panelOn(ctx, target.key);
    await press(ctx, "e", "e", 900);
    await press(ctx, "tab", "\t", 600);
    let local = /** @type {number} */ (target.local);
    const taken = forwarded.find((r) => r.key !== target.key)?.local;
    if (taken) {
      await retype(ctx, local, taken);
      await press(ctx, "↵", "\r", 600);
      caption("scenario", "A taken port is refused, and the form says who has it. Nothing else changes.");
      await ctx.wait(2200);
      local = taken;
    }
    const to = freePort(4000);
    await retype(ctx, local, to);
    await press(ctx, "↵", "\r", 1200);
    caption("scenario", `Saved: the forward moved to <code>localhost:${to}</code>.`);
    await ctx.wait(1400);
  },
  async login(ctx) {
    closePanel();
    caption("scenario", "<code>npx wrangler login</code> waits for its OAuth callback on the server's localhost:8976…");
    await idle(ctx, "dev-server");
    await typeCmd(ctx, "dev-server", "npx wrangler login");
    await ctx.wait(1400);
    caption("scenario", "…so your laptop's browser redirect to <code>localhost:8976</code> needs a forward. It's already there.");
    await ctx.wait(3600);
    caption("scenario", "Logged in. The port closed, and its forward went away with it.");
  },
};

// ---- the video's camera (#tour only): zoom onto what's happening, so it reads on a phone ----

/** An element's box in the camera's own, unzoomed coordinates. @param {Element} el */
function localRect(el) {
  const cam = $("#camera");
  const c = cam.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const s = c.width / cam.offsetWidth;
  return { x: (r.left - c.left) / s, y: (r.top - c.top) / s, w: r.width / s, h: r.height / s };
}

/** Terminal cells r0..r1 x c0..c1 as a box. @param {any} term @param {number} r0 @param {number} c0 @param {number} r1 @param {number} c1 */
function cells(term, r0, c0, r1, c1) {
  const box = localRect(term.element.querySelector(".xterm-screen"));
  const cw = box.w / term.cols, ch = box.h / term.rows;
  return { x: box.x + c0 * cw, y: box.y + r0 * ch, w: (c1 - c0 + 1) * cw, h: (r1 - r0 + 1) * ch };
}

/** The shell around its cursor. @param {number} below rows of output to make room for @param {number} cols */
const shellAt = (below, cols) => {
  const y = shellTerm.buffer.active.cursorY;
  return cells(shellTerm, Math.max(0, y - 1), 0, Math.min(shellTerm.rows - 1, y + below), Math.min(shellTerm.cols - 1, cols));
};

/** The panel's add/edit form, found by its frame. */
function formBox() {
  const b = panelTerm.buffer.active;
  const line = (/** @type {number} */ r) => b.getLine(r)?.translateToString() ?? "";
  for (let r = 0; r < panelTerm.rows; r++) {
    const c0 = line(r).indexOf("┌ Edit forward");
    if (c0 < 0) continue;
    let r1 = r + 1;
    while (r1 < panelTerm.rows - 1 && !line(r1).includes("└")) r1++;
    return cells(panelTerm, r, c0, r1, line(r).indexOf("┐"));
  }
  return localRect($("#popup"));
}

/** Zoom onto a box, or all the way out without one. @param {{x: number, y: number, w: number, h: number} | null} box @param {number} [max] */
function camera(box, max = 1.7) {
  const cam = $("#camera");
  if (!document.body.classList.contains("tour")) return void (cam.style.transform = "");
  const W = $("#lens").clientWidth, H = $("#lens").clientHeight;
  let s = 1, x = 0, y = 0;
  if (box) {
    s = Math.max(1, Math.min(max, W / (box.w + 36), H / (box.h + 36)));
    x = Math.min(0, Math.max(W - cam.offsetWidth * s, W / 2 - (box.x + box.w / 2) * s));
    y = Math.min(0, Math.max(H - cam.offsetHeight * s, H / 2 - (box.y + box.h / 2) * s));
  }
  cam.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
}
const tunnels = () => localRect($(".map"));

/**
 * Speak a line of the tour. Its subtitle lights up word by word on the voiceover's timing when the
 * video recorder provides one (window.NARRATION), and the step lasts at least as long as the line.
 * @param {Ctx} ctx @param {keyof LINES} id @param {boolean} [quiet] no subtitle (the title card shows it)
 */
async function say(ctx, id, quiet = false) {
  const w = /** @type {any} */ (window);
  const words = LINES[id].text.split(/\s+/);
  const voice = w.NARRATION?.[id];
  (w.saidAt ??= []).push({ id, t: Date.now() / 1000 }); // when each line starts, to lay the audio under the video
  const el = $("#caption");
  $("#step").textContent = "";
  el.classList.add("words");
  el.innerHTML = quiet ? "" : words.map((word) => `<span>${esc(word)}</span>`).join(" ");
  const spans = [...el.children];
  if (voice) voice.words.forEach((/** @type {number} */ t, /** @type {number} */ i) => setTimeout(() => spans[i]?.classList.add("on"), t * 1000));
  else spans.forEach((span) => span.classList.add("on"));
  const ids = Object.keys(LINES);
  $("#progress").style.width = `${((ids.indexOf(id) + 1) / ids.length) * 100}%`;
  await ctx.wait(voice ? voice.duration * 1000 + 150 : 500 + words.length * 300);
}

/** @param {Ctx} ctx */
async function tour(ctx) {
  /** Do things while a line is spoken; the step ends when both are done. @param {keyof LINES} id @param {() => Promise<unknown>} fn */
  const along = (id, fn) => Promise.all([say(ctx, id), fn()]);
  /** Show a machine's shell and zoom onto its prompt. @param {string} id @param {number} below @param {number} cols */
  const onShell = async (id, below, cols) => (show(id), await ctx.wait(150), camera(shellAt(below, cols)), await ctx.wait(450));
  reset(true);
  $("#caption").innerHTML = "";
  $("#stage").insertAdjacentHTML("beforeend", `<div class="intro" id="intro"><div><div class="mark"><span>⇄</span> autofwd</div><p>Automatic port forwarding for herdr.</p></div></div>`);
  await ctx.wait(500);
  await Promise.all([say(ctx, "intro", true), ctx.wait(2000)]);
  $("#intro").classList.add("gone");
  await ctx.wait(450);
  $("#intro")?.remove();
  await onShell("dev-server", 7, 58);
  await along("start", async () => (await typeCmd(ctx, "dev-server", "npm run dev"), await ctx.wait(900)));
  camera(tunnels(), 1.5);
  await along("local", () => ctx.wait(1400));
  openLocal("http://localhost:5173/");
  camera(localRect($("#browser")), 1.6);
  await along("open", () => ctx.wait(1700));
  closeBrowser();
  await onShell("gpu-box", 7, 58);
  await along("clash", async () => {
    await typeCmd(ctx, "gpu-box", "npm run dev");
    await ctx.wait(700);
    camera(tunnels(), 1.5);
    await ctx.wait(1900);
  });
  camera(null);
  await along("panel", async () => {
    await panelOn(ctx, "gpu-box|localhost:5173");
    await ctx.wait(400);
    camera(cells(panelTerm, 0, 0, 5, Math.round(panelTerm.cols * 0.72))); // the forwards and where they go
    await ctx.wait(1500);
  });
  await along("refuse", async () => {
    await press(ctx, "e", "e", 600);
    camera(formBox());
    await ctx.wait(400);
    await press(ctx, "tab", "\t", 450);
    await retype(ctx, 5174, 5173);
    await press(ctx, "↵", "\r", 2000);
  });
  await along("free", async () => {
    await retype(ctx, 5173, 4000);
    await press(ctx, "↵", "\r", 900);
    camera(null);
    await ctx.wait(700);
    await press(ctx, "esc", "\x1b", 300);
    camera(tunnels(), 1.5);
    await ctx.wait(1200);
  });
  show("dev-server");
  await along("stop", async () => (await ctx.wait(500), keycap("ctrl+c"), stopJob("dev-server"), await ctx.wait(1600)));
  await onShell("dev-server", 6, shellTerm.cols);
  $("#caption").innerHTML = "";
  await typeCmd(ctx, "dev-server", "npx wrangler login");
  for (let i = 0; i < 50 && $("#browser").hidden; i++) await ctx.wait(100);
  camera(localRect($("#browser")), 1.6);
  await along("login", () => ctx.wait(1800));
  camera(null);
  await ctx.wait(500);
  outro();
  await along("outro", () => ctx.wait(2800));
}

function outro() {
  $("#stage").insertAdjacentHTML("beforeend", `<div class="outro" id="outro"><div><div class="mark"><span>⇄</span> autofwd</div><p>Automatic port forwarding for herdr's SSH machines.</p><div class="install"><code>herdr plugin install entrptaher/herdr-autofwd</code></div><div class="repo">github.com/entrptaher/herdr-autofwd</div><button class="btn" type="button" id="back">Back to the demo</button></div></div>`);
  $("#outro").addEventListener("click", () => {
    $("#outro").remove();
    document.body.classList.remove("tour"); // back to the page from the video layout
    camera(null);
    caption("try it", IDLE);
  });
}

/** Back to the start: a dev server running on dev-server, or nothing at all for the tour. */
function reset(empty = false) {
  closePanel();
  closeBrowser();
  document.querySelector("#outro")?.remove();
  document.querySelector("#intro")?.remove();
  $("#progress").style.width = "0";
  camera(null);
  for (const id of MACHINES) shells[id] = { log: prompt(id), line: "", job: null };
  sim.reset();
  show(MACHINES[0], true);
  if (!empty) type(MACHINES[0], "npm run dev\r");
  caption("try it", IDLE);
}

// ---- start ----

await Promise.race([Promise.all([document.fonts.load(`14px ${MONO}`), document.fonts.load(`bold 14px ${MONO}`)]), sleep(2500)]);
shellTerm = new Terminal({ fontFamily: MONO, fontSize: 14, lineHeight: 1.12, theme: THEME, cursorBlink: true, scrollback: 1000 });
fitShell = new FitAddon.FitAddon();
shellTerm.loadAddon(fitShell);
shellTerm.open($("#shell"));
fitShell.fit();
panelTerm = new Terminal({ fontFamily: MONO, fontSize: 13, theme: THEME, cursorBlink: false, scrollback: 0 });
fitPanel = new FitAddon.FitAddon();
panelTerm.loadAddon(fitPanel);

shellTerm.onData((/** @type {string} */ d) => (active && cancel(), type(current, d)));
panelTerm.onData((/** @type {string} */ d) => (active && cancel(), panelSink?.(d)));
sim.api.onChange(() => (renderIndicator(), scheduleMap()));
new ResizeObserver(() => {
  fitShell.fit();
  if (!panel) return;
  fitPanel.fit();
  panel.input(`\x1b[8;${panelTerm.rows};${panelTerm.cols}t`);
}).observe($("#herdr"));
new ResizeObserver(scheduleMap).observe($("#map"));

document.querySelectorAll(".side .m[data-machine]").forEach((b) => b.addEventListener("click", () => (show(/** @type {string} */ (/** @type {HTMLElement} */ (b).dataset.machine)), shellTerm.focus())));
document.querySelectorAll("#scenarios button").forEach((b) => {
  const name = /** @type {string} */ (/** @type {HTMLElement} */ (b).dataset.s);
  b.addEventListener("click", () => play(name, SCENARIOS[name]));
});
document.querySelectorAll("#cmds button:not(#open-panel)").forEach((b) => {
  const cmd = /** @type {string} */ (b.textContent);
  b.addEventListener("click", () => play(null, async (ctx) => (closePanel(), await idle(ctx, current), await typeCmd(ctx, current, cmd))));
});
$("#open-panel").addEventListener("click", () => (cancel(), openPanel()));
$("#play").addEventListener("click", () => play(null, tour));
$("#reset").addEventListener("click", () => (cancel(), reset()));
$("#close-browser").addEventListener("click", closeBrowser);
$("#site").addEventListener("click", (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.classList.contains("count")) t.textContent = `count is ${Number(t.textContent?.replace(/\D/g, "")) + 1}`;
  if (t.classList.contains("retry")) retry?.();
});
$("#copy").addEventListener("click", () => {
  const text = /** @type {string} */ ($("#install").textContent);
  navigator.clipboard
    .writeText(text)
    .then(() => (($("#copy").textContent = "Copied"), setTimeout(() => ($("#copy").textContent = "Copy"), 1600)))
    .catch(() => getSelection()?.selectAllChildren($("#install")));
});

document.body.classList.toggle("tour", location.hash === "#tour");
reset(location.hash === "#tour");
renderMap();
if (location.hash === "#tour") play(null, tour);
