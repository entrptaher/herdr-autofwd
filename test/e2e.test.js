// @ts-check
// End-to-end check against a real sshd in a Debian container (needs Docker). herdr is faked through
// HERDR_BIN_PATH (machine list, notifications, config check) and its API socket through
// HERDR_SOCKET_PATH, so the real daemon runs exactly as herdr would start it, isolated from your own
// herdr, SSH config and herdr config.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afw-")); // short: unix socket paths are length-limited
const name = `autofwd-test-${process.pid}`;
const env = {
  ...process.env,
  PATH: `${tmp}/bin:${process.env.PATH}`,
  HERDR_BIN_PATH: `${tmp}/bin/herdr`,
  HERDR_SOCKET_PATH: `${tmp}/herdr.sock`,
  HERDR_PLUGIN_STATE_DIR: `${tmp}/state`,
  HERDR_CONFIG_PATH: `${tmp}/config.toml`,
  AUTOFWD_RUN_DIR: `${tmp}/run`,
  FAKE_DIR: tmp,
};
process.env.AUTOFWD_RUN_DIR = env.AUTOFWD_RUN_DIR;
const { request } = await import("../src/common.js");

/** @type {net.Server} */ let fakeHerdr;
/** @type {net.Server | undefined} */ let blocker;
let target = "";

const sh = (/** @type {string[]} */ ...args) => execFileSync(args[0], args.slice(1), { encoding: "utf8", env });
const cli = (/** @type {string} */ cmd) => sh(process.execPath, `${ROOT}/src/cli.js`, cmd);
const docker = (/** @type {string[]} */ ...args) => sh("docker", ...args);
const machineEntry = (/** @type {boolean} */ enabled) => ({ id: "m1", label: "box", target, session: "default", enabled, selected: false });
const setMachines = (/** @type {object[]} */ list) => fs.writeFileSync(`${tmp}/machines.json`, JSON.stringify(list));
const status = () => request({ cmd: "status" }).catch(() => null);
const act = (/** @type {object} */ msg) => request({ cmd: "act", machine: "m1", ...msg });
const machine = async () => (await status())?.machines[0];
/** A row by dest; a bare number means that port on the machine itself. @param {number | string} dest */
const portOf = async (dest) => {
  const want = typeof dest === "number" ? `localhost:${dest}` : dest;
  return (await machine())?.ports.find((/** @type {any} */ p) => p.dest === want);
};
const forwardOf = async (/** @type {number | string} */ dest) => {
  const p = await portOf(dest);
  return p?.state === "forwarded" ? { remote: p.remote, local: p.local, name: p.name } : undefined;
};
/** The page a forward serves, or "" when nothing answers. @param {string} url */
const page = (url) => fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => r.text(), () => "");
/** True when the python http.server on the remote answered through the forward. */
const reaches = (/** @type {string} */ url) =>
  fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => r.text()).then((t) => t.includes("Directory listing"), () => false);

/** Poll until fn() is truthy; returns its value. */
async function waitFor(/** @type {() => any} */ fn, /** @type {string} */ what, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return (console.log(`  ok ~${Date.now() - start}ms  ${what}`), v);
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  fs.mkdirSync(`${tmp}/bin`);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", `${tmp}/key`]);
  fs.writeFileSync(`${tmp}/bin/ssh`, `#!/bin/sh\nexec /usr/bin/ssh -i ${tmp}/key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(
    `${tmp}/bin/herdr`,
    `#!/bin/sh
case "$1 $2" in
"machine list") cat "$FAKE_DIR/machines.json" ;;
"notification show") shift 2; printf '%s\\n' "$*" >>"$FAKE_DIR/notifications.log" ;;
"config check") echo "config: ok" ;;
"server reload-config") echo '{"result":{"status":"applied"}}' ;;
*) echo "fake herdr: unsupported: $*" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(env.HERDR_CONFIG_PATH, "onboarding = false\n");
  setMachines([]);
  fakeHerdr = net.createServer((c) => c.end()).listen(env.HERDR_SOCKET_PATH);

  target = await startMachine(name);
});

/** An SSH machine in Docker (user dev, our test key); resolves with its ssh:// target. @param {string} container */
async function startMachine(container) {
  docker("run", "-d", "--name", container, "-p", "127.0.0.1::22", "-e", `KEY=${fs.readFileSync(`${tmp}/key.pub`, "utf8").trim()}`, "debian:bookworm-slim", "sh", "-c",
    `apt-get update -qq && apt-get install -y -qq --no-install-recommends openssh-server iproute2 procps python3 >/dev/null &&
     useradd -m dev && install -d -o dev -m 700 /home/dev/.ssh && echo "$KEY" >/home/dev/.ssh/authorized_keys &&
     chown dev /home/dev/.ssh/authorized_keys && mkdir -p /run/sshd && exec /usr/sbin/sshd -D -e`);
  const port = docker("port", container, "22").split("\n")[0].split(":").pop();
  const ssh = `ssh://dev@127.0.0.1:${port}`;
  await waitFor(() => { try { return sh("ssh", "-o", "BatchMode=yes", ssh, "true") === ""; } catch { return false; } }, `${container} sshd up`, 180_000);
  return ssh;
}

after(() => {
  try { cli("stop"); } catch {}
  blocker?.close();
  fakeHerdr?.close();
  try { docker("rm", "-f", name); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("forwards a saved machine's ports end to end", { timeout: 300_000 }, async () => {
  cli("start");
  const first = await status();
  assert.deepEqual(first?.machines, [], "no machines saved yet");
  cli("start"); // a second herdr server attaching must reuse the daemon, not start another
  assert.equal((await status())?.pid, first?.pid, "same daemon");

  setMachines([machineEntry(true)]);
  await waitFor(async () => (await machine())?.status === "connected", "saved machine connects");

  docker("exec", "-d", "-u", "dev", name, "python3", "-m", "http.server", "45678", "--bind", "127.0.0.1");
  const f = await waitFor(() => forwardOf(45678), "new remote listener is forwarded");
  assert.deepEqual(f, { remote: "45678", local: 45678, name: "python3" });
  assert.ok(await reaches("http://127.0.0.1:45678/"), "127.0.0.1 reaches the remote server");
  assert.ok(await reaches("http://[::1]:45678/"), "::1 reaches the remote server");

  docker("exec", "-d", name, "python3", "-m", "http.server", "45679"); // root-owned: must be ignored
  blocker = await new Promise((resolve) => { const s = net.createServer().listen({ host: "::1", port: 45680 }, () => resolve(s)); });
  docker("exec", "-d", "-u", "dev", name, "python3", "-m", "http.server", "45680");
  const remapped = await waitFor(() => forwardOf(45680), "half-taken local port remaps");
  assert.equal(remapped.local, 45681);
  assert.ok(await reaches("http://localhost:45681/"), "remapped forward reaches the remote server");
  assert.equal(await portOf(45679), undefined, "root-owned port not listed");

  docker("exec", name, "pkill", "-f", "http.server 45678");
  await waitFor(async () => !(await portOf(45678)), "stopped remote server is unforwarded");
  assert.equal(await reaches("http://127.0.0.1:45678/"), false);
  const toasts = () => fs.readFileSync(`${tmp}/notifications.log`, "utf8");
  assert.match(toasts(), /box: localhost:45678/);
  await waitFor(() => /localhost:45681 ← python3 45680 \(localhost:45680 is used by node \(pid \d+\) on this computer\)/.test(toasts()), "remap toast (batched)");
  assert.equal(docker("exec", name, "pgrep", "-c", "-u", "dev", "-fx", "sh -s").trim(), "1", "one remote watcher");

  docker("pause", name); // network drop: the server stops answering
  await waitFor(async () => (await machine())?.status === "retrying", "drop detected", 25_000);
  await waitFor(() => /box: connection lost/.test(toasts()), "connection lost toast");
  docker("unpause", name);
  await waitFor(async () => (await forwardOf(45680))?.local === 45681, "reconnects and restores forwards", 45_000);

  setMachines([machineEntry(false)]);
  await waitFor(async () => (await status())?.machines.length === 0, "disabled machine is dropped");
  assert.equal(await reaches("http://localhost:45681/"), false, "its forwards are closed");
  setMachines([machineEntry(true)]);
  await waitFor(async () => (await forwardOf(45680))?.local === 45681, "re-enabled machine forwards again");
});

test("Ports panel actions change the real forwards", { timeout: 120_000 }, async () => {
  let r = await act({ op: "local", port: 45680, local: 45690 });
  assert.ok(r.ok, r.message);
  assert.deepEqual(await forwardOf(45680), { remote: "45680", local: 45690, name: "python3" });
  assert.ok(await reaches("http://localhost:45690/"), "moved forward works");
  assert.equal(await reaches("http://localhost:45681/"), false, "old local port released");
  r = await act({ op: "local", port: 45680, local: 45680 }); // ::1:45680 is taken by the blocker
  assert.equal(r.ok, false);
  assert.match(r.message, /^localhost:45680 is already used by node \(pid \d+\) on this computer\. Pick another local port\.$/);
  assert.equal((await forwardOf(45680))?.local, 45690, "a taken port leaves the working forward alone");

  await act({ op: "stop", port: 45680 });
  await waitFor(async () => (await portOf(45680))?.state === "stopped", "stop");
  assert.equal(await reaches("http://localhost:45690/"), false);
  await act({ op: "resume", port: 45680 });
  await waitFor(async () => (await forwardOf(45680))?.local === 45690, "resume keeps the chosen local port");

  r = await act({ op: "add", port: 45679 }); // root's server: not detected, added by hand
  assert.ok(r.ok, r.message);
  await waitFor(async () => (await forwardOf(45679))?.local === 45679, "port added by hand is forwarded");
  assert.ok(await reaches("http://localhost:45679/"));
  assert.equal((await portOf(45679))?.manual, true);

  await act({ op: "auto", on: false });
  await waitFor(async () => !(await forwardOf(45680)), "auto-forward off closes detected forwards");
  assert.ok(await forwardOf(45679), "ports added by hand stay");
  await act({ op: "auto", on: true });
  await waitFor(() => forwardOf(45680), "auto-forward on brings them back");

  const prefs = JSON.parse(fs.readFileSync(`${tmp}/state/prefs.json`, "utf8")).machines.m1;
  assert.deepEqual({ manual: prefs.manual, local: prefs.local, auto: prefs.auto }, { manual: ["localhost:45679"], local: { "localhost:45680": 45690 }, auto: true }, "choices are saved");
  assert.equal((await act({ op: "add", port: 70000 })).ok, false, "invalid port rejected");
  assert.equal((await act({ op: "add", dest: "-oProxyCommand=x:22" })).ok, false, "option-like host rejected");
});

test("forwards to another host:port reachable from the machine, and points it elsewhere", { timeout: 60_000 }, async () => {
  // Servers bound to the container's own network address: not loopback, so not detected automatically.
  const ip = docker("exec", name, "hostname", "-i").trim().split(/\s+/).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  docker("exec", "-u", "dev", name, "sh", "-c", "mkdir -p /tmp/a /tmp/b && touch /tmp/a/served-by-A /tmp/b/served-by-B");
  docker("exec", "-d", "-u", "dev", name, "python3", "-m", "http.server", "45700", "--bind", `${ip}`, "-d", "/tmp/a");
  docker("exec", "-d", "-u", "dev", name, "python3", "-m", "http.server", "45702", "--bind", `${ip}`, "-d", "/tmp/b");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await portOf(45700), undefined, "a specific-address listener isn't forwarded automatically");

  const r = await act({ op: "add", dest: `${ip}:45700` });
  assert.ok(r.ok, r.message);
  await waitFor(async () => (await forwardOf(`${ip}:45700`))?.local === 45700, "host:port forward");
  assert.match(await page("http://localhost:45700/"), /served-by-A/);

  const t = await act({ op: "save", dest: `${ip}:45700`, to: `${ip}:45702`, local: null }); // the panel's Edit form
  assert.ok(t.ok, t.message);
  await waitFor(async () => (await forwardOf(`${ip}:45702`))?.local === 45700, "editing the remote keeps the local port");
  assert.match(await page("http://localhost:45700/"), /served-by-B/);
  assert.equal(await portOf(`${ip}:45700`), undefined, "old dest is gone");
  await act({ op: "stop", dest: `${ip}:45702` }); // remove it so later tests see the same rows as before
  await waitFor(async () => !(await portOf(`${ip}:45702`)), "removed");
});

test("the companion popup on the machine relays the panel", { timeout: 60_000 }, async () => {
  docker("cp", `${ROOT}/companion/ui.sh`, `${name}:/tmp/ui.sh`);
  // `script` gives ui.sh a terminal, as herdr's popup would.
  const popup = spawn("docker", ["exec", "-i", "-u", "dev", name, "script", "-qfec", "stty rows 20 cols 90; sh /tmp/ui.sh", "/dev/null"]);
  let screen = "";
  popup.stdout.on("data", (d) => (screen += d));
  await waitFor(() => screen.includes("LOCAL ADDRESS") && screen.includes("localhost:45690"), "panel drawn in the machine's popup", 10_000);
  // Arrow keys split across reads (ESC, then "[B" a moment later) must move, not close the panel.
  for (const part of ["\x1b", "[B", "\x1b", "[A"]) {
    popup.stdin.write(part);
    await new Promise((r) => setTimeout(r, 15));
  }
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(popup.exitCode, null, "a split arrow key isn't taken for Esc");
  popup.stdin.write("s"); // back on the first row: :45679, added by hand -> remove
  await waitFor(async () => !(await portOf(45679)), "keys from the popup act on the forwards");
  popup.stdin.write("q");
  const code = await new Promise((resolve) => popup.on("close", resolve));
  assert.equal(code, 0, "popup exits when the panel closes");
  assert.equal(docker("exec", name, "sh", "-c", "ls /home/dev/.cache/herdr-autofwd | wc -l").trim(), "0", "no FIFOs left behind");
});

/** Hold local ports the way another program on this computer would. @param {number[]} ports */
async function holdPorts(ports) {
  const servers = [];
  for (const port of ports)
    for (const host of ["127.0.0.1", "::1"])
      servers.push(await new Promise((resolve) => { const s = net.createServer().listen({ host, port }, () => resolve(s)); }));
  return () => servers.forEach((s) => /** @type {net.Server} */ (s).close());
}

test("conflicts across machines and with local programs are explained, and nothing breaks", { timeout: 300_000 }, async () => {
  const name2 = `${name}-2`;
  const target2 = await startMachine(name2);
  /** @param {string} id @param {number} port */
  const rowOn = async (id, port) => (await status())?.machines.find((/** @type {any} */ m) => m.id === id)?.ports.find((/** @type {any} */ p) => p.dest === `localhost:${port}`);
  const shown = (/** @type {string} */ what, /** @type {string} */ text) => console.log(`  ${what}:\n      ${text}`);
  try {
    setMachines([machineEntry(true), { id: "m2", label: "box2", target: target2, session: "default", enabled: true, selected: false }]);
    await waitFor(async () => (await status())?.machines.find((/** @type {any} */ m) => m.id === "m2")?.status === "connected", "second machine connects", 20_000);

    // 1. Both machines serve 45710: the first gets it, the second moves to 45711 and says why.
    docker("exec", "-d", "-u", "dev", name, "python3", "-m", "http.server", "45710");
    await waitFor(async () => (await rowOn("m1", 45710))?.local === 45710, "box gets localhost:45710");
    docker("exec", "-d", "-u", "dev", name2, "python3", "-m", "http.server", "45710");
    const moved = await waitFor(async () => { const r = await rowOn("m2", 45710); return r?.local ? r : null; }, "box2's 45710 is forwarded elsewhere");
    assert.equal(moved.local, 45711);
    assert.match(moved.note, /^localhost:45710 is used by the forward from box \(45710\)$/);
    shown("another machine has the port (shown in the row and toast)", moved.note);
    assert.ok(await reaches("http://localhost:45711/"), "and it works on 45711");
    await waitFor(() => /box2: localhost:45711[\s\S]*used by the forward from box/.test(fs.readFileSync(`${tmp}/notifications.log`, "utf8")), "toast says so too");

    // 2. A program on this computer holds 45720: named, with its pid.
    const releaseOne = await holdPorts([45720]);
    docker("exec", "-d", "-u", "dev", name2, "python3", "-m", "http.server", "45720");
    const local = await waitFor(async () => { const r = await rowOn("m2", 45720); return r?.local ? r : null; }, "box2's 45720 moves past a local program");
    assert.equal(local.local, 45721);
    assert.match(local.note, /^localhost:45720 is used by node \(pid \d+\) on this computer$/);
    shown("a program on this computer has the port", local.note);

    // 3. Editing into a taken port is refused with the reason, and nothing changes.
    const intoForward = await act({ machine: "m2", op: "local", dest: "localhost:45710", local: 45710 });
    assert.equal(intoForward.ok, false);
    assert.match(intoForward.message, /^localhost:45710 is already used by the forward from box \(45710\)\. Pick another local port\.$/);
    shown("editing the local port to one another machine uses", intoForward.message);
    const intoProgram = await act({ machine: "m2", op: "save", dest: null, to: "localhost:45722", local: 45720 });
    assert.equal(intoProgram.ok, false);
    assert.match(intoProgram.message, /^localhost:45720 is already used by node \(pid \d+\) on this computer\. Pick another local port\.$/);
    shown("adding a forward on a port a local program uses", intoProgram.message);
    assert.equal((await rowOn("m2", 45710))?.local, 45711, "box2's forward is untouched");
    assert.equal(await rowOn("m2", 45722), undefined, "nothing was added");
    // "Adding" a forward that already exists, with a free local port, moves it there.
    const move = await act({ machine: "m2", op: "save", dest: null, to: "localhost:45710", local: 45712 });
    assert.ok(move.ok, move.message);
    await waitFor(async () => (await rowOn("m2", 45710))?.local === 45712, "adding an existing forward moves it");

    // 4. All 20 local ports from 45730 up taken: a clear problem on the row, everything else keeps working.
    const releaseRange = await holdPorts(Array.from({ length: 20 }, (_, i) => 45730 + i));
    docker("exec", "-d", "-u", "dev", name2, "python3", "-m", "http.server", "45730");
    const busy = await waitFor(async () => { const r = await rowOn("m2", 45730); return r?.state === "busy" ? r : null; }, "box2's 45730 can't be forwarded");
    assert.match(busy.note, /^localhost:45730-45749 are all in use \(45730: node \(pid \d+\) on this computer\)$/);
    shown("every port from 45730 to 45749 is taken", busy.note);
    assert.ok(await reaches("http://localhost:45712/"), "other forwards keep working");
    releaseRange();
    releaseOne();
  } finally {
    setMachines([machineEntry(true)]);
    try { docker("rm", "-f", name2); } catch {}
  }
  await waitFor(async () => (await status())?.machines.length === 1, "second machine removed");
});

test("herdr integration (S) sets up both sides, keeps the indicator fresh, and undoes exactly", { timeout: 60_000 }, async () => {
  const sh = (/** @type {string} */ cmd) => docker("exec", "-u", "dev", name, "sh", "-c", cmd);
  const none = await act({ op: "shortcut", on: true });
  assert.equal(none.ok, false, "a machine without herdr is reported");
  assert.match(none.message, /box: herdr isn't installed on this machine/);
  await act({ op: "shortcut", on: false });

  // A stand-in herdr on the machine, enough for the setup script (real herdr is checked by hand).
  const fake = `#!/bin/sh
case "$1 $2" in
"plugin list") [ -f "$HOME/.fake-linked" ] && printf '{"plugin_root":"%s"}\\n' "$(cat "$HOME/.fake-linked")" ;;
"plugin link") echo "$3" >"$HOME/.fake-linked" ;;
"plugin unlink") rm -f "$HOME/.fake-linked" ;;
"config check") echo "config: ok" ;;
"server reload-config") : ;;
*) exit 1 ;;
esac
`;
  execFileSync("docker", ["exec", "-i", name, "sh", "-c", "cat >/usr/local/bin/herdr && chmod +x /usr/local/bin/herdr"], { input: fake });

  const on = await act({ op: "shortcut", on: true });
  assert.ok(on.ok, on.message);
  assert.match(on.message, /prefix\+f and the ports indicator are set up on this computer, box/);
  const config = fs.readFileSync(env.HERDR_CONFIG_PATH, "utf8");
  assert.match(config, /command = "autofwd.ports"/);
  assert.ok(config.includes(`${tmp}/state/status`), "this computer's indicator reads the daemon's status file");
  assert.match(sh("cat ~/.config/herdr/config.toml"), /autofwd\.ports[\s\S]*tab_bar_right/);
  assert.equal(sh("cat ~/.fake-linked").trim(), "/home/dev/.local/share/herdr-autofwd/companion");
  assert.equal(sh("ls ~/.local/share/herdr-autofwd/companion").trim().split("\n").sort().join(" "), "herdr-plugin.toml ui.sh");

  const localIndicator = () => { try { return fs.readFileSync(`${tmp}/state/status`, "utf8"); } catch { return ""; } };
  await waitFor(() => /^⇄ .*45690/.test(localIndicator()), "this computer's indicator text"); // written shortly after changes
  // Run the indicator exactly as herdr would on the machine.
  const indicator = /command = '([^']*)'/.exec(sh("cat ~/.config/herdr/config.toml"))?.[1] ?? "";
  await waitFor(() => { try { return /^⇄ .*45690/.test(sh(indicator)); } catch { return false; } }, "the machine's indicator shows the forwards");

  const off = await act({ op: "shortcut", on: false });
  assert.ok(off.ok, off.message);
  assert.equal(fs.readFileSync(env.HERDR_CONFIG_PATH, "utf8"), "onboarding = false\n", "this computer's config restored exactly");
  const left = sh("ls -d ~/.config/herdr/config.toml ~/.fake-linked ~/.local/share/herdr-autofwd ~/.cache/herdr-autofwd/status 2>/dev/null || true").trim();
  assert.equal(left, "", "nothing left on the machine");
  assert.equal(fs.existsSync(`${tmp}/state/status`), false, "indicator gone here too");
});

test("daemon exits with herdr and cleans up", { timeout: 60_000 }, async () => {
  fakeHerdr.close(); // the herdr server goes away
  await waitFor(async () => !(await status()), "daemon exits with herdr", 20_000);
  assert.equal(await reaches("http://localhost:45690/"), false, "forwards closed on exit");
  await new Promise((r) => setTimeout(r, 1500)); // remote watcher dies on its next heartbeat write
  assert.throws(() => docker("exec", name, "pgrep", "-u", "dev", "-fx", "sh -s"), "remote watcher gone");
});
