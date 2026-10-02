// @ts-check
// The Ports panel: a VS Code-style list of forwarded ports you can act on with keys or the mouse, with one
// form to add or edit a forward. It runs inside the daemon and draws into a plain terminal byte stream,
// so herdr's floating windows on this computer and on SSH machines only relay keys and screen.
import { spawn } from "node:child_process";
import { printable } from "./forwarder.js";
import { destHost, destPort, isPort, parseDest } from "./prefs.js";

const RESET = "\x1b[0m";
const S = { bold: "\x1b[1m", dim: "\x1b[2m", inv: "\x1b[7m", ul: "\x1b[4m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", magenta: "\x1b[35m", cyan: "\x1b[36m" };
const ENTER = "\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[2J"; // hide cursor, no wrap, mouse on (SGR)
const LEAVE = "\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[0m\x1b[2J\x1b[H";
const FLASH_MS = 5000;
const DOUBLE_CLICK_MS = 400;
// Keys, mouse reports, resize reports (CSI 8;rows;cols t, sent by the relays), other CSI/SS3, lone ESC, one char.
const TOKEN = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[8;(\d+);(\d+)t|\x1b\[(\d*)(?:;\d*)*([A-Za-z~])|\x1bO([A-Za-z])|\x1b|[\s\S]/gy;

/**
 * @typedef {{snapshot: () => Snapshot, act: (msg: object) => Promise<{ok: boolean, message: string}>, onChange: (fn: () => void) => () => void}} Api
 * @typedef {{notify: boolean, shortcut: {on: boolean, key: string, error: string}, machines: Machine[]}} Snapshot
 * @typedef {ReturnType<import("./forwarder.js").Forwarder["snapshot"]> & {shortcut: string}} Machine
 * @typedef {import("./forwarder.js").PortRow & {machine: Machine, key: string}} Row
 * @typedef {"machine" | "host" | "port" | "local"} Field
 * @typedef {{old: string | null, detected: boolean, machine: string, host: string, port: string, local: string, focus: Field, error: string, busy: boolean}} Form
 *   old: the forward being edited (null: adding one)
 * @typedef {{label: string, run: () => void}} MenuItem
 * @typedef {{x: number, y: number, items: MenuItem[], sel: number}} Menu
 * @typedef {{y: number, x0: number, x1: number, run: () => void, key?: string}} Hit
 */

export class Panel {
  /**
   * @param {Api} api
   * @param {{input: NodeJS.ReadableStream, output: NodeJS.WritableStream, rows: number, cols: number, focus?: string, onClose?: () => void, open?: (url: string) => void}} io
   *   focus: the machine the panel was opened from, selected first; open: how to open a URL (default: the
   *   system browser)
   */
  constructor(api, io) {
    this.api = api;
    this.openUrl = io.open;
    this.out = io.output;
    this.rows = io.rows;
    this.cols = io.cols;
    this.onClose = io.onClose;
    /** @type {"ports" | "machines"} */
    this.view = "ports";
    this.selPort = ""; // row key, so the selection survives rows coming and going
    this.selMachine = "";
    this.top = 0;
    /** @type {Form | null} */
    this.form = null;
    /** @type {Menu | null} */
    this.menu = null;
    this.flash = { text: "", tone: "", at: 0 };
    this.help = false;
    this.closed = false;
    /** @type {Hit[]} clickable regions from the last frame, first match wins */
    this.hits = [];
    this.lastClick = { key: "", at: 0 };
    this.mouseX = 0; // column of the last click
    /** @type {NodeJS.Timeout | undefined} */
    this.timer = undefined;
    /** @type {{text: string, timer: NodeJS.Timeout} | undefined} a partial escape sequence waiting for the rest */
    this.held = undefined;
    this.state = api.snapshot();
    if (io.focus) {
      this.selMachine = io.focus;
      this.selPort = this.portRows().find((r) => r.machine.id === io.focus)?.key ?? "";
    }
    this.unsubscribe = api.onChange(() => this.refresh());
    io.input.on("data", (d) => this.input(String(d)));
    io.input.on("end", () => this.close());
    io.input.on("error", () => this.close());
    this.out.on("error", () => this.close());
    this.write(ENTER);
    this.render();
  }

  // ---- data ----

  refresh() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.state = this.api.snapshot();
      this.render();
    }, 30);
  }

  /** @returns {Row[]} */
  portRows() {
    return this.state.machines.flatMap((m) => m.ports.map((p) => ({ ...p, machine: m, key: `${m.id}|${p.dest}` })));
  }

  selectedRow() {
    const rows = this.portRows();
    return rows.find((r) => r.key === this.selPort) ?? rows[0];
  }

  selectedMachine() {
    const ms = this.state.machines;
    return ms.find((m) => m.id === this.selMachine) ?? ms[0];
  }

  // ---- input ----

  /** @param {string} data */
  input(data) {
    if (this.held) {
      clearTimeout(this.held.timer);
      data = this.held.text + data;
      this.held = undefined;
    }
    // A key sequence split across reads (likely over SSH) ends a chunk with a partial escape: wait a
    // moment for the rest before treating it as the Esc key, which would close the panel.
    const partial = /\x1b(?:\[[\d;<]*|O)?$/.exec(data);
    if (partial) {
      const text = partial[0];
      data = data.slice(0, partial.index);
      this.held = { text, timer: setTimeout(() => ((this.held = undefined), this.feed(text)), 50) };
    }
    if (data) this.feed(data);
  }

  /** @param {string} data */
  feed(data) {
    TOKEN.lastIndex = 0;
    let m;
    while (TOKEN.lastIndex < data.length && (m = TOKEN.exec(data))) {
      if (m[1] !== undefined) this.mouse(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1, m[4] === "M");
      else if (m[5] !== undefined) this.resize(Number(m[5]), Number(m[6]));
      else if (m[8] !== undefined) this.key(csiKey(m[7], m[8]));
      else if (m[9] !== undefined) this.key(csiKey("", m[9]));
      else this.key(charKey(m[0]));
      if (this.closed) return;
    }
    this.render();
  }

  /** @param {number} rows @param {number} cols */
  resize(rows, cols) {
    if (rows > 0 && cols > 0) [this.rows, this.cols] = [rows, cols];
    this.menu = null;
    this.write("\x1b[2J");
  }

  /** @param {string} k */
  key(k) {
    if (this.form) return this.formKey(k);
    if (this.menu) return this.menuKey(k);
    if (this.help) return void (this.help = k !== "esc" && k !== "?" && k !== "q" && k !== "enter");
    if (k === "q" || k === "esc" || k === "ctrl-c") return this.close();
    if (k === "tab" || k === "shift-tab" || k === "left" || k === "right") return this.switchView();
    if (k === "?") return void (this.help = true);
    if (k === "n") return this.do({ op: "notify", on: !this.state.notify });
    if (k === "S") return this.toggleIntegration();
    if (this.view === "ports") this.portsKey(k);
    else this.machinesKey(k);
  }

  /** @param {string} k */
  portsKey(k) {
    const rows = this.portRows();
    const i = Math.max(0, rows.findIndex((r) => r.key === this.selPort));
    const move = (/** @type {number} */ to) => rows.length && (this.selPort = rows[Math.max(0, Math.min(rows.length - 1, to))].key);
    if (k === "up" || k === "k") return move(i - 1);
    if (k === "down" || k === "j") return move(i + 1);
    if (k === "pgup") return move(i - this.bodyHeight());
    if (k === "pgdn") return move(i + this.bodyHeight());
    if (k === "home" || k === "g") return move(0);
    if (k === "end" || k === "G") return move(rows.length - 1);
    if (k === "+" || k === "a") return this.openForm(null, this.selectedRow()?.machine.id);
    const row = this.selectedRow();
    if (!row) return;
    if (k === "enter" || k === "o") return this.open(row);
    if (k === "c") return this.copy(row);
    if (k === "e") return this.openForm(row);
    if (k === "s" || k === "x" || k === "delete" || k === "backspace") return this.toggle(row);
    if (k === "r") return this.do({ op: "reconnect", machine: row.machine.id });
    if (k === "m") {
      const y = this.hits.find((h) => h.key === row.key)?.y ?? 3;
      return this.openMenu(4, y + 1, this.rowMenu(row));
    }
  }

  /** @param {string} k */
  machinesKey(k) {
    const ms = this.state.machines;
    const i = Math.max(0, ms.findIndex((m) => m.id === this.selMachine));
    const move = (/** @type {number} */ to) => ms.length && (this.selMachine = ms[Math.max(0, Math.min(ms.length - 1, to))].id);
    if (k === "up" || k === "k") return move(i - 1);
    if (k === "down" || k === "j") return move(i + 1);
    const m = this.selectedMachine();
    if (!m) return;
    if (k === " " || k === "a" || k === "enter") return this.do({ op: "auto", machine: m.id, on: !m.auto });
    if (k === "r") return this.do({ op: "reconnect", machine: m.id });
    if (k === "+") return this.openForm(null, m.id);
    if (k === "m") {
      const y = this.hits.find((h) => h.key === m.id)?.y ?? 3;
      return this.openMenu(4, y + 1, this.machineMenu(m));
    }
  }

  /** @param {string} k */
  menuKey(k) {
    const menu = /** @type {Menu} */ (this.menu);
    if (k === "up" || k === "k") return void (menu.sel = (menu.sel + menu.items.length - 1) % menu.items.length);
    if (k === "down" || k === "j") return void (menu.sel = (menu.sel + 1) % menu.items.length);
    this.menu = null;
    if (k === "enter" || k === " ") menu.items[menu.sel].run();
  }

  /** @param {number} button @param {number} x @param {number} y @param {boolean} press */
  mouse(button, x, y, press) {
    if (!press) return;
    this.mouseX = x;
    if (button === 64 || button === 65) return this.form ? undefined : this.key(button === 64 ? "up" : "down"); // wheel
    const hit = this.hits.find((h) => h.y === y && x >= h.x0 && x < h.x1);
    if (this.form) {
      // The form stays until Save or Cancel; clicks outside it do nothing.
      if (button === 0 && hit?.key?.startsWith("form:")) hit.run();
      return;
    }
    if (this.menu) {
      // Clicking outside the menu just closes it.
      if (button === 0 && hit?.key?.startsWith("menu:")) hit.run();
      else this.menu = null;
      return;
    }
    if (button === 2) {
      // Right click: select the row under the pointer and offer its actions.
      const target = this.hits.find((h) => h.key && h.y === y && x >= h.x0 && x < h.x1);
      if (!target) return;
      target.run();
      const port = this.view === "ports" ? this.selectedRow() : undefined;
      const items = port ? this.rowMenu(port) : this.selectedMachine() ? this.machineMenu(/** @type {Machine} */ (this.selectedMachine())) : [];
      return this.openMenu(x, y + 1, items);
    }
    if (button !== 0 || !hit) return;
    const now = Date.now();
    const double = hit.key !== undefined && this.lastClick.key === hit.key && now - this.lastClick.at < DOUBLE_CLICK_MS;
    this.lastClick = { key: hit.key ?? "", at: now };
    hit.run();
    if (double && this.view === "ports") this.key("enter");
  }

  // ---- the add/edit form ----

  /**
   * Add a forward (row null) or edit one. Every row can be edited: pointing a detected port elsewhere
   * stops it and adds the new destination as a forward of your own.
   * @param {Row | null} row @param {string} [machine] machine to add to
   */
  openForm(row, machine) {
    const m = row?.machine.id ?? machine ?? this.state.machines[0]?.id;
    if (!m) return this.say("Save a machine first: herdr machine add <host>", "err");
    this.menu = null;
    this.form = row
      ? { old: row.dest, detected: row.detected && !row.manual, machine: m, host: destHost(row.dest), port: String(destPort(row.dest)), local: row.local === null ? "" : String(row.local), focus: "port", error: "", busy: false }
      : { old: null, detected: false, machine: m, host: "localhost", port: "", local: "", focus: "port", error: "", busy: false };
  }

  /** @returns {Field[]} */
  formFields() {
    const f = /** @type {Form} */ (this.form);
    return [...(f.old === null && this.state.machines.length > 1 ? /** @type {Field[]} */ (["machine"]) : []), "host", "port", "local"];
  }

  /** @param {string} k */
  formKey(k) {
    const f = /** @type {Form} */ (this.form);
    if (f.busy) return;
    const fields = this.formFields();
    const i = fields.indexOf(f.focus);
    if (k === "esc" || k === "ctrl-c") return void (this.form = null);
    if (k === "enter") return this.submitForm();
    if (k === "tab" || k === "down") return void (f.focus = fields[(i + 1) % fields.length]);
    if (k === "shift-tab" || k === "up") return void (f.focus = fields[(i + fields.length - 1) % fields.length]);
    if (f.focus === "machine") {
      const ms = this.state.machines;
      const j = ms.findIndex((m) => m.id === f.machine);
      if (k === "left" || k === "right" || k === " ") f.machine = ms[(j + (k === "left" ? ms.length - 1 : 1)) % ms.length].id;
      return;
    }
    const field = /** @type {"host" | "port" | "local"} */ (f.focus);
    if (k === "backspace") f[field] = f[field].slice(0, -1);
    else if ((field === "host" ? /^[0-9A-Za-z.:[\]-]$/ : /^[0-9]$/).test(k) && f[field].length < (field === "host" ? 253 : 5)) f[field] += k;
    else return;
    f.error = "";
  }

  submitForm() {
    const f = /** @type {Form} */ (this.form);
    const host = f.host.trim() || "localhost";
    const fail = (/** @type {Field} */ focus, /** @type {string} */ error) => Object.assign(f, { focus, error });
    if (!isPort(Number(f.port))) return fail("port", "Remote port: a number from 1 to 65535");
    if (f.local !== "" && !isPort(Number(f.local))) return fail("local", "Local port: a number from 1 to 65535, or empty");
    // A bare IPv6 address needs brackets to be told apart from its port.
    const to = host.includes(":") && !host.startsWith("[") ? `[${host}]:${f.port}` : `${host}:${f.port}`;
    if (!parseDest(to)) return fail("host", `Remote host "${host}" isn't a valid hostname or address`);
    f.busy = true;
    const machine = f.machine;
    this.api.act({ op: "save", machine, dest: f.old, to, local: f.local === "" ? null : Number(f.local) }).then(
      (r) => {
        if (this.form !== f) return;
        if (!r.ok) return Object.assign(f, { busy: false, error: r.message }), this.render();
        this.form = null;
        this.selPort = `${machine}|${parseDest(to)}`; // the forward comes up selected
        this.say(r.message, "ok");
      },
      (err) => (Object.assign(f, { busy: false, error: String(err?.message ?? err) }), this.render()),
    );
  }

  // ---- actions ----

  switchView() {
    this.view = this.view === "ports" ? "machines" : "ports";
    this.top = 0;
  }

  toggleIntegration() {
    this.say(this.state.shortcut.on ? "Removing the herdr integration…" : "Setting up the herdr integration…", "");
    this.do({ op: "shortcut", on: !this.state.shortcut.on });
  }

  /** @param {Row} row */
  toggle(row) {
    const op = row.state === "stopped" || row.state === "off" ? "resume" : "stop";
    this.do({ op, machine: row.machine.id, dest: row.dest });
  }

  /** @param {Row} row */
  open(row) {
    if (row.local === null) return this.say(`${row.remote} isn't forwarded right now`, "err");
    const url = `http://localhost:${row.local}`;
    if (this.openUrl) return this.openUrl(url);
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [url], { detached: true, stdio: "ignore" }).on("error", () => this.say(`Couldn't run ${opener}`, "err")).unref();
    this.say(`Opened ${url}`, "ok");
  }

  /** @param {Row} row */
  copy(row) {
    if (row.local === null) return this.say(`${row.remote} isn't forwarded right now`, "err");
    const url = `http://localhost:${row.local}`;
    copyText(url, () => this.write(`\x1b]52;c;${Buffer.from(url).toString("base64")}\x07`)); // OSC 52 fallback
    this.say(`Copied ${url}`, "ok");
  }

  /** @param {Row} row @returns {MenuItem[]} */
  rowMenu(row) {
    /** @type {MenuItem[]} */
    const items = [];
    if (row.local !== null) items.push({ label: "Open in browser", run: () => this.open(row) }, { label: "Copy address", run: () => this.copy(row) });
    items.push({ label: "Edit…", run: () => this.openForm(row) });
    const stopLabel = row.state === "stopped" || row.state === "off" ? "Forward again" : row.manual && !row.detected ? "Remove" : "Stop forwarding";
    items.push({ label: stopLabel, run: () => this.toggle(row) });
    items.push({ label: "Add a forward…", run: () => this.openForm(null, row.machine.id) });
    items.push({ label: `Reconnect ${row.machine.label}`, run: () => this.do({ op: "reconnect", machine: row.machine.id }) });
    return items;
  }

  /** @param {Machine} m @returns {MenuItem[]} */
  machineMenu(m) {
    return [
      { label: `Turn auto-forward ${m.auto ? "off" : "on"}`, run: () => this.do({ op: "auto", machine: m.id, on: !m.auto }) },
      { label: "Add a forward…", run: () => this.openForm(null, m.id) },
      { label: "Reconnect", run: () => this.do({ op: "reconnect", machine: m.id }) },
    ];
  }

  /** @param {number} x @param {number} y @param {MenuItem[]} items */
  openMenu(x, y, items) {
    if (items.length) this.menu = { x, y, items, sel: 0 };
  }

  /** @param {object} msg */
  do(msg) {
    this.api.act(msg).then(
      (r) => r.message && this.say(r.message, r.ok ? "ok" : "err"),
      (err) => this.say(String(err?.message ?? err), "err"),
    );
  }

  /** @param {string} text @param {"ok" | "err" | ""} tone */
  say(text, tone) {
    this.flash = { text, tone, at: Date.now() };
    this.render();
    setTimeout(() => this.render(), FLASH_MS + 50);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.held?.timer);
    this.unsubscribe();
    this.out.write(LEAVE);
    this.out.end();
    this.onClose?.();
  }

  /** @param {string} s */
  write(s) {
    if (!this.closed) this.out.write(s);
  }

  // ---- drawing ----

  /** Short windows: tabs and machines share the top line, and one bottom line serves hints and messages. */
  get compact() {
    return this.rows < 14;
  }

  /** Lines between the top line and the bottom line(s). */
  bodyHeight() {
    return Math.max(1, this.rows - (this.compact ? 2 : 3));
  }

  flashing() {
    return Boolean(this.flash.text) && Date.now() - this.flash.at < FLASH_MS;
  }

  render() {
    if (this.closed) return;
    const W = Math.max(20, this.cols);
    const R = this.rows;
    this.hits = [];
    /** @type {string[]} */
    const lines = [];
    lines.push(this.tabsLine(W));
    if (this.help) lines.push(...(this.compact ? [] : [""]), ...this.helpLines(W));
    else if (this.view === "ports") lines.push(...this.portsLines(W));
    else lines.push(...this.machinesLines(W));
    const bottom = !this.compact
      ? [this.statusLine(W, R - 2), this.hintsLine(W, R - 1)]
      : this.flashing() && !this.form ? [this.statusLine(W, R - 1)] : [this.hintsLine(W, R - 1)];
    while (lines.length < R - bottom.length) lines.push("");
    lines.length = Math.max(0, R - bottom.length);
    lines.push(...bottom);
    // Clear first: with autowrap off, an erase after a full-width line would also erase its last column.
    let frame = "";
    lines.forEach((l, i) => (frame += `\x1b[${i + 1};1H\x1b[2K${l}`));
    if (this.menu) frame += this.menuFrame(W);
    if (this.form) frame += this.formFrame(W);
    this.write(frame);
  }

  /** A box drawn over the frame; returns its escape sequences. @param {number} x @param {number} y @param {number} w @param {string[]} body @param {string} [title] */
  box(x, y, w, body, title = "") {
    const head = title ? `┌ ${title} ${"─".repeat(Math.max(0, w - title.length - 5))}┐` : `┌${"─".repeat(w - 2)}┐`;
    let out = `\x1b[${y + 1};${x + 1}H${S.bold}${head}${RESET}`;
    body.forEach((line, i) => (out += `\x1b[${y + 2 + i};${x + 1}H${S.bold}│${RESET}${line}${S.bold}│${RESET}`));
    return out + `\x1b[${y + body.length + 2};${x + 1}H${S.bold}└${"─".repeat(w - 2)}┘${RESET}`;
  }

  /** The context menu; its items are hit-tested before anything under it. @param {number} W */
  menuFrame(W) {
    const menu = /** @type {Menu} */ (this.menu);
    const w = Math.min(W, Math.max(...menu.items.map((i) => i.label.length)) + 4);
    const x = Math.max(0, Math.min(menu.x, W - w));
    const y = Math.max(1, Math.min(menu.y, this.rows - menu.items.length - 2));
    const body = menu.items.map((item, i) => {
      this.hits.unshift({ y: y + 1 + i, x0: x, x1: x + w, key: `menu:${i}`, run: () => ((this.menu = null), item.run()) });
      return `${i === menu.sel ? S.inv : ""} ${clip(item.label, w - 4).padEnd(w - 4)} ${RESET}`;
    });
    return this.box(x, y, w, body);
  }

  /** The add/edit form, centred over the panel; its fields and buttons are clickable. @param {number} W */
  formFrame(W) {
    const f = /** @type {Form} */ (this.form);
    const w = Math.min(W, 72);
    const inner = w - 2;
    const fields = this.formFields();
    const message = f.error ? wrap(`! ${f.error}`, inner - 4) : [f.busy ? "Saving…" : ""];
    const height = fields.length + 5 + message.length + (f.detected ? 1 : 0);
    const x = Math.max(0, Math.floor((W - w) / 2));
    const y = Math.max(0, Math.floor((this.rows - height - 2) / 2));
    const m = this.state.machines.find((x) => x.id === f.machine);
    /** @type {string[]} */
    const body = [new Line(inner).pad(inner).toString()];
    const labels = { machine: "Machine", host: "Remote host", port: "Remote port", local: "Local port" };
    const tips = {
      machine: "←/→ or click to switch",
      host: "as seen from the machine",
      port: "",
      local: f.old ? "empty: keep the current one" : "empty: same, or next free",
    };
    for (const field of fields) {
      const focused = f.focus === field;
      const line = new Line(inner).add("  ").add(`${labels[field]}`.padEnd(14), focused ? S.bold : "");
      const value = field === "machine" ? `◂ ${m?.label ?? "?"} ▸` : f[field];
      const vx = line.len;
      line.add(value, focused ? S.ul : "");
      if (focused && field !== "machine") line.add(" ", S.inv);
      line.pad(vx + 26).add(tips[field], S.dim).pad(inner);
      const row = y + 1 + body.length;
      this.hits.unshift({ y: row, x0: x + 1, x1: x + 1 + inner, key: `form:${field}`, run: () => this.clickField(field, x + 1 + vx) });
      body.push(line.toString());
    }
    if (f.detected) body.push(new Line(inner).add("  Detected: a new remote host or port stops it and adds yours.", S.dim).pad(inner).toString());
    body.push(new Line(inner).pad(inner).toString());
    for (const text of message) body.push(new Line(inner).add(`  ${text}`, f.error ? S.red : S.dim).pad(inner).toString());
    body.push(new Line(inner).pad(inner).toString());
    const buttons = new Line(inner);
    const cancel = "[ Cancel ]";
    const save = "[ Save ]";
    buttons.pad(inner - cancel.length - save.length - 4);
    const cx = buttons.len;
    buttons.add(cancel, S.bold).add("  ");
    const sx = buttons.len;
    buttons.add(save, S.bold + S.inv).pad(inner);
    const by = y + 1 + body.length;
    this.hits.unshift({ y: by, x0: x + 1 + cx, x1: x + 1 + cx + cancel.length, key: "form:cancel", run: () => (this.form = null) });
    this.hits.unshift({ y: by, x0: x + 1 + sx, x1: x + 1 + sx + save.length, key: "form:save", run: () => this.submitForm() });
    body.push(buttons.toString());
    return this.box(x, y, w, body, f.old ? "Edit forward" : "Add a forward");
  }

  /** Focus a clicked field; on the machine field, ◂ and ▸ switch machines. @param {Field} field @param {number} valueX screen column where the value starts */
  clickField(field, valueX) {
    const f = /** @type {Form} */ (this.form);
    f.focus = field;
    if (field === "machine") this.formKey(this.mouseX < valueX + 2 ? "left" : "right");
  }

  /** @param {number} W */
  tabsLine(W) {
    const line = new Line(W);
    const ports = this.portRows().filter((r) => r.state === "forwarded").length;
    for (const [view, label] of /** @type {const} */ ([["ports", ` Ports ${ports} `], ["machines", ` Machines ${this.state.machines.length} `]])) {
      const x0 = line.len;
      line.add(label, this.view === view ? S.inv + S.bold : S.dim);
      this.hits.push({ y: 0, x0, x1: line.len, run: () => ((this.view = view), (this.help = false)) });
      line.add(" ");
    }
    if (this.compact) this.machineStrip(line.add(" "));
    const tip = "? help";
    line.pad(W - tip.length);
    this.hits.push({ y: 0, x0: line.len, x1: W, run: () => (this.help = !this.help) });
    line.add(tip, S.dim);
    return line.toString();
  }

  /** @param {number} W */
  portsLines(W) {
    const ms = this.state.machines;
    if (!ms.length) return noMachines();
    /** @type {string[]} */
    const lines = this.compact ? [] : [this.machineStrip(new Line(W)).toString()];
    const rows = this.portRows();
    const addRow = (/** @type {string} */ text) => {
      this.hits.push({ y: 1 + lines.length, x0: 0, x1: W, run: () => this.openForm(null, this.selectedRow()?.machine.id) });
      lines.push(new Line(W).add(text, S.dim).toString());
    };
    if (!rows.length) {
      const anyUp = ms.some((m) => m.status === "connected");
      if (!this.compact) lines.push("");
      lines.push(anyUp ? "  Nothing is listening yet." : "  Waiting for a connection…");
      lines.push(`${S.dim}  Start a dev server on your machine and it shows up here, forwarded to localhost.${RESET}`);
      addRow("  + Add a forward   (a port on the machine, or any host:port it can reach)");
      return lines;
    }
    const multi = ms.length > 1;
    const mw = multi ? Math.min(16, Math.max(7, ...ms.map((m) => m.label.length))) + 2 : 0;
    const rw = Math.min(26, Math.max(8, ...rows.map((r) => r.remote.length + 2)));
    const cols = { addr: 18, proc: 16 };
    const head = new Line(W).add("     ");
    if (multi) head.add("MACHINE".padEnd(mw));
    head.add("REMOTE".padEnd(rw)).add("LOCAL ADDRESS".padEnd(cols.addr)).add("PROCESS".padEnd(cols.proc)).add("NOTE");
    lines.push(`${S.dim}${head}${RESET}`);

    const height = Math.max(1, this.bodyHeight() - lines.length - 1); // minus the strip and header, and the add row
    // A selection that isn't listed (yet) shows as the first row but is kept: a forward you just added
    // appears a moment later and should come up selected.
    const sel = Math.max(0, rows.findIndex((r) => r.key === this.selPort));
    if (sel < this.top) this.top = sel;
    if (sel >= this.top + height) this.top = sel - height + 1;
    this.top = Math.max(0, Math.min(this.top, rows.length - height));
    rows.slice(this.top, this.top + height).forEach((r, i) => {
      const selected = i + this.top === sel;
      const line = new Line(W, selected ? S.inv : "");
      line.add(selected ? " ›  " : "    ", S.bold);
      const [dot, dotStyle] = DOTS[r.state];
      line.add(dot + " ", dotStyle);
      if (multi) line.add(r.machine.label.padEnd(mw));
      line.add(r.remote.padEnd(rw), S.bold);
      const [addr, addrStyle] = address(r);
      line.add(addr.padEnd(cols.addr), addrStyle);
      line.add((r.name || (r.manual ? "added" : "—")).padEnd(cols.proc), r.name ? "" : r.manual ? S.magenta : S.dim);
      if (r.name && r.manual) line.add("added ", S.magenta);
      if (r.note) line.add(`! ${r.note}`, r.state === "busy" ? S.red : S.yellow);
      line.pad(W);
      this.hits.push({ y: 1 + lines.length, x0: 0, x1: W, key: r.key, run: () => (this.selPort = r.key) }); // +1: tab bar
      lines.push(line.toString());
    });
    addRow("    + Add a forward");
    return lines;
  }

  /** Each machine's connection state, added to a line. @param {Line} line */
  machineStrip(line) {
    line.add(" ");
    for (const m of this.state.machines) {
      const [dot, st] = m.status === "connected" ? ["●", S.green] : m.status === "connecting" ? ["◌", S.yellow] : ["○", S.red];
      line.add(`${dot} `, st).add(m.label, S.bold);
      if (m.status === "retrying") line.add(` ${m.error}`, S.red);
      else if (!m.auto) line.add(" auto-forward off", S.dim);
      line.add("   ");
    }
    return line;
  }

  /** @param {number} W */
  machinesLines(W) {
    const ms = this.state.machines;
    if (!ms.length) return [...noMachines(), "", ...this.settingsLines(W, 2 + noMachines().length)]; // +1 tab bar, +1 blank
    const lw = Math.min(20, Math.max(7, ...ms.map((m) => m.label.length))) + 2;
    const head = new Line(W).add("    ").add("MACHINE".padEnd(lw)).add("STATUS".padEnd(34)).add("AUTO-FORWARD".padEnd(15)).add("PORTS");
    /** @type {string[]} */
    const lines = [...(this.compact ? [] : [""]), `${S.dim}${head}${RESET}`];
    const sel = Math.max(0, ms.findIndex((m) => m.id === this.selMachine));
    ms.forEach((m, i) => {
      const selected = i === sel;
      const line = new Line(W, selected ? S.inv : "");
      line.add(selected ? " › " : "   ", S.bold);
      const [dot, st] = m.status === "connected" ? ["●", S.green] : m.status === "connecting" ? ["◌", S.yellow] : ["○", S.red];
      line.add(`${dot} `, st).add(m.label.padEnd(lw), S.bold);
      const status = m.status === "retrying" ? `retrying: ${m.error}` : m.status;
      line.add(clip(status, 32).padEnd(34), m.status === "retrying" ? S.red : "");
      const autoX = line.len;
      line.add((m.auto ? "on" : "off").padEnd(15), m.auto ? S.green : S.dim);
      line.add(`${m.ports.filter((p) => p.state === "forwarded").length} forwarded`);
      line.pad(W);
      const y = 1 + lines.length; // +1: tab bar
      // Clicking the AUTO-FORWARD cell toggles it; anywhere else on the row selects.
      this.hits.push({ y, x0: autoX, x1: autoX + 15, run: () => ((this.selMachine = m.id), this.do({ op: "auto", machine: m.id, on: !m.auto })) });
      this.hits.push({ y, x0: 0, x1: W, key: m.id, run: () => (this.selMachine = m.id) });
      lines.push(line.toString());
    });
    lines.push("", ...this.settingsLines(W, 1 + lines.length + 1));
    lines.push("", `${S.dim}  New server? Run ${RESET}${S.bold}herdr machine add <host>${RESET}${S.dim} in a terminal. Forwarding starts by itself,${RESET}`);
    lines.push(`${S.dim}  and once it connects, ${this.state.shortcut.key} and the ⇄ indicator work there too (with the integration on).${RESET}`);
    return lines;
  }

  /** @param {number} W @param {number} y screen row of the first line */
  settingsLines(W, y) {
    const sc = this.state.shortcut;
    const notify = new Line(W).add("    Notifications".padEnd(25)).add(this.state.notify ? "on " : "off", this.state.notify ? S.green : S.dim).add("   n to turn " + (this.state.notify ? "off" : "on"), S.dim);
    const integ = new Line(W).add("    herdr integration".padEnd(25));
    if (!sc.on) integ.add("off", S.dim).add(`   S: ${sc.key} opens this panel, and a ⇄ ports indicator in the tab row`, S.dim);
    else {
      integ.add(sc.error ? `this computer: ${sc.error}` : "this computer", sc.error ? S.red : S.green);
      for (const m of this.state.machines) {
        const st = m.shortcut;
        integ.add(" · ").add(st === "ok" ? m.label : st.startsWith("error") ? `${m.label}: ${st.slice(7)}` : `${m.label} (${st || "pending"})`,
          st === "ok" ? S.green : st.startsWith("error") ? S.red : S.yellow);
      }
      integ.add("   S to remove", S.dim);
    }
    this.hits.push({ y: y + 1, x0: 0, x1: W, run: () => this.do({ op: "notify", on: !this.state.notify }) });
    this.hits.push({ y: y + 2, x0: 0, x1: W, run: () => this.toggleIntegration() });
    return [`${S.dim}  SETTINGS${RESET}`, notify.toString(), integ.toString()];
  }

  /** @param {number} W */
  helpLines(W) {
    const keys = [
      ["↑ ↓  or click", "select"], ["↵  or double-click", "open in your browser"], ["c", "copy the local address"],
      ["e", "edit: remote host, remote port, local port"], ["+", "add a forward (a port, or any host:port the machine reaches)"],
      ["s", "stop or resume forwarding"], ["m  or right-click", "all actions for the row"],
      ["r", "reconnect the machine"], ["tab", "switch between Ports and Machines"], ["space", "auto-forward on/off (Machines)"],
      ["n", "notifications on/off"], ["S", `herdr integration: ${this.state.shortcut.key} and the ⇄ indicator`], ["q / esc", "close"],
    ];
    return keys.map(([k, what]) => new Line(W).add(`   ${k.padEnd(22)}`, S.bold).add(what).toString());
  }

  /** A message, the selected row's full conflict note (the table may cut it), or a tip. @param {number} W @param {number} y screen row it goes on */
  statusLine(W, y) {
    if (this.flashing()) {
      const tone = this.flash.tone === "ok" ? S.green : this.flash.tone === "err" ? S.red : S.dim;
      return new Line(W).add(` ${this.flash.text}`, tone).toString();
    }
    const row = this.view === "ports" && !this.help ? this.selectedRow() : undefined;
    if (row?.note) return new Line(W).add(` ! ${row.machine.label} ${row.remote}: ${row.note}`, row.state === "busy" ? S.red : S.yellow).toString();
    if (!this.state.shortcut.on && this.state.machines.length) {
      const line = new Line(W).add(" Tip: press ", S.dim).add("S", S.bold).add(` so ${this.state.shortcut.key} opens this panel from any machine`, S.dim);
      this.hits.push({ y, x0: 0, x1: line.len, run: () => this.toggleIntegration() });
      return line.toString();
    }
    return "";
  }

  /** Key hints that are also buttons; the least important drop off when space runs out. @param {number} W @param {number} y */
  hintsLine(W, y) {
    /** @type {[string, string, string][]} [shown key, key it presses, what it does] */
    let hints;
    if (this.form) hints = [["tab", "tab", "next field"], ["↵", "enter", "save"], ["esc", "esc", "cancel"]];
    else if (this.menu) hints = [["↵", "enter", "choose"], ["esc", "esc", "close menu"]];
    else if (this.help) hints = [["esc", "esc", "back"]];
    else if (this.view === "machines")
      hints = this.state.machines.length
        ? [["space", " ", "auto-forward"], ["r", "r", "reconnect"], ["+", "+", "add"], ["n", "n", "notify"], ["tab", "tab", "ports"], ["q", "q", "close"]]
        : [["q", "q", "close"]];
    else {
      const row = this.selectedRow();
      hints = [];
      if (row?.local != null) hints.push(["↵", "enter", "open"], ["c", "c", "copy"]);
      if (row) hints.push(["e", "e", "edit"], ["s", "s", row.state === "stopped" || row.state === "off" ? "forward" : row.manual && !row.detected ? "remove" : "stop"]);
      hints.push(["+", "+", "add"]);
      if (row) hints.push(["m", "m", "more"]);
      hints.push(["tab", "tab", "machines"], ["q", "q", "close"]);
    }
    const width = (/** @type {[string, string, string][]} */ hs) => hs.reduce((n, [k, , what]) => n + [...k].length + what.length + 3, 1);
    while (hints.length > 2 && width(hints) > W) hints.splice(hints.length - 2, 1); // keep the last one
    const line = new Line(W).add(" ");
    for (const [k, press, what] of hints) {
      const x0 = line.len;
      line.add(k, S.bold).add(` ${what}`, S.dim);
      this.hits.push({ y, x0, x1: line.len, run: () => this.key(press) });
      line.add("  ");
    }
    return line.toString();
  }
}

/** @type {Record<import("./forwarder.js").PortState, [string, string]>} */
const DOTS = { forwarded: ["●", S.green], stopped: ["○", S.dim], off: ["○", S.dim], busy: ["●", S.red], pending: ["◌", S.yellow] };

/** @param {Row} r @returns {[string, string]} */
function address(r) {
  if (r.local !== null) return [`localhost:${r.local}`, S.cyan];
  if (r.state === "stopped") return ["stopped", S.dim];
  if (r.state === "off") return ["not forwarded", S.dim];
  if (r.state === "busy") return ["no free local port", S.red];
  return [r.machine.status === "connected" ? "forwarding…" : "waiting", S.yellow];
}

function noMachines() {
  return [
    "", "  No saved SSH machines yet.", "",
    `${S.dim}  Add your server in a terminal and its ports show up here automatically:${RESET}`,
    `    ${S.bold}herdr machine add <host>${RESET}`,
  ];
}

/** A line of styled segments that never exceeds its width and never cuts an escape sequence. */
class Line {
  /** @param {number} width @param {string} [base] style applied under every segment (row selection) */
  constructor(width, base = "") {
    this.width = width;
    this.base = base;
    this.out = "";
    this.len = 0;
  }

  /** @param {string} text @param {string} [style] */
  add(text, style = "") {
    const room = this.width - this.len;
    if (room <= 0 || !text) return this;
    const t = clip(printable(text), room); // styles come only from `style`, never from the text
    this.out += this.base || style ? `${this.base}${style}${t}${RESET}` : t;
    this.len += [...t].length;
    return this;
  }

  /** @param {number} to */
  pad(to) {
    return this.len < to ? this.add(" ".repeat(Math.min(to, this.width) - this.len)) : this;
  }

  toString() {
    return this.out;
  }
}

/** Split text into lines of at most `width`, at spaces. @param {string} text @param {number} width */
function wrap(text, width) {
  const lines = [""];
  for (const word of text.split(" ")) {
    const last = lines.length - 1;
    if (lines[last] && lines[last].length + 1 + word.length > width) lines.push(word);
    else lines[last] = lines[last] ? `${lines[last]} ${word}` : word;
  }
  return lines;
}

/** @param {string} text @param {number} n */
function clip(text, n) {
  const chars = [...text];
  return chars.length <= n ? text : n <= 1 ? chars.slice(0, n).join("") : chars.slice(0, n - 1).join("") + "…";
}

/** @param {string} num @param {string} final */
function csiKey(num, final) {
  const arrows = /** @type {Record<string, string>} */ ({ A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "shift-tab" });
  if (final === "~") return /** @type {Record<string, string>} */ ({ 1: "home", 3: "delete", 4: "end", 5: "pgup", 6: "pgdn", 7: "home", 8: "end" })[num] ?? "";
  return arrows[final] ?? "";
}

/** @param {string} c */
function charKey(c) {
  if (c === "\x1b") return "esc";
  if (c === "\r" || c === "\n") return "enter";
  if (c === "\t") return "tab";
  if (c === "\x7f" || c === "\b") return "backspace";
  if (c === "\x03") return "ctrl-c";
  return c;
}

/** Copy to this computer's clipboard; calls fallback when no clipboard tool exists. @param {string} text @param {() => void} fallback */
function copyText(text, fallback) {
  const tools = process.platform === "darwin" ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
  const attempt = (/** @type {number} */ i) => {
    if (i >= tools.length) return fallback();
    const [cmd, ...args] = tools[i];
    const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    let failed = false; // spawn errors can be followed by close; move on once
    const next = () => !failed && ((failed = true), attempt(i + 1));
    p.on("error", next);
    p.on("close", (code) => code !== 0 && next());
    p.stdin.on("error", () => {});
    p.stdin.end(text);
  };
  attempt(0);
}
