// @ts-check
// The Ports panel's "herdr integration" (S): on this computer and on each SSH machine it binds prefix+f
// to the panel and adds a ports indicator to herdr's tab row. herdr takes both from the machine you're
// viewing, so each machine needs its own copy; SSH machines also get the companion plugin (companion/).
// Config text is edited here, by one function, for every machine; each edit is checked with
// `herdr config check` and undone if herdr rejects it. Nothing runs until asked.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HERDR } from "./common.js";
import { printable } from "./forwarder.js";

export const KEY = "prefix+f";
export const REMOTE_STATUS = "$HOME/.cache/herdr-autofwd/status";
const BEGIN = "# autofwd:begin";
const END = "# autofwd:end";
const STATUS_BEGIN = "# autofwd:status:begin";
const STATUS_END = "# autofwd:status:end";
const KEYBINDING = `[[keys.command]]
key = "${KEY}"
type = "plugin_action"
command = "autofwd.ports"
description = "Ports panel (autofwd)"
`;
const SCRIPTS = ["ui.sh"];
const COMPANION = ["herdr-plugin.toml", ...SCRIPTS].map((f) => [f, fs.readFileSync(new URL(`../companion/${f}`, import.meta.url), "utf8")]);

/**
 * herdr runs this every 2 seconds and shows its output in the tab row. The file is only shown while the
 * daemon keeps it fresh, so a stopped or disconnected autofwd doesn't leave a stale list behind.
 * @param {string} file path, may start with $HOME
 */
export const statusCommand = (file) => `f="${file}"; [ -n "$(find "$f" -mmin -1 2>/dev/null)" ] && cat "$f"`;

/**
 * Add (on) or remove our blocks in herdr config text. Removing restores the original text exactly.
 * @param {string} text @param {boolean} on @param {string} command the indicator's status command
 * @returns {{text: string, note: string}} note: something that was left out, and why
 */
export function editConfig(text, on, command) {
  let out = text
    .replace(/\n?# autofwd:begin[^\n]*\n[\s\S]*?# autofwd:end\n?/g, "")
    .replace(/\n# autofwd:status:begin\n[\s\S]*?\n# autofwd:status:end/g, "");
  if (!on) return { text: out, note: "" };
  let note = "";
  let block = out.includes("autofwd.ports") ? "" : KEYBINDING; // already bound by hand: leave it
  const indicator = `tab_bar_right = [{ type = "command", command = '${command}', interval_seconds = 2, timeout_seconds = 2 }]`;
  const uiHeader = /^\[ui\][ \t]*(?:#[^\n]*)?$/m;
  if (/^[ \t]*tab_bar_right[ \t]*=/m.test(out)) note = "tab_bar_right is already set, so the ports indicator was left out";
  else if (uiHeader.test(out)) out = out.replace(uiHeader, (header) => `${header}\n${STATUS_BEGIN}\n${indicator}\n${STATUS_END}`);
  else block += `[ui]\n${indicator}\n`;
  if (block) out += `${out && !out.endsWith("\n") ? "\n" : ""}${out ? "\n" : ""}${BEGIN} (added by the autofwd plugin; remove it with S in the Ports panel)\n${block}${END}\n`;
  return { text: out, note };
}

/** @param {string} bin @param {string[]} args @returns {Promise<{ok: boolean, out: string}>} */
function run(bin, args) {
  return new Promise((resolve) =>
    execFile(bin, args, { timeout: 15_000 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() })),
  );
}

/** herdr's own complaint about its config, without the "issues found" header. @param {string} out */
const complaint = (out) => out.split("\n").filter((l) => l && !/^config: /i.test(l)).pop() ?? out;

/**
 * Set up (on) or remove the integration in this computer's herdr config.
 * @param {boolean} on @param {string} statusFile where the daemon keeps this computer's indicator text
 * @returns {Promise<{error: string, note: string}>}
 */
export async function local(on, statusFile) {
  const file = process.env.HERDR_CONFIG_PATH || path.join(os.homedir(), ".config", "herdr", "config.toml");
  /** @type {string | null} */
  let before = null;
  try {
    before = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") return { error: /** @type {Error} */ (err).message, note: "" };
  }
  const { text, note } = editConfig(before ?? "", on, statusCommand(statusFile));
  if (text === (before ?? "")) return { error: "", note };
  if (on) {
    const pre = await run(HERDR, ["config", "check"]);
    if (!pre.ok) return { error: `your herdr config already has a problem: ${complaint(pre.out)}`, note };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (text) fs.writeFileSync(file, text);
  else fs.rmSync(file, { force: true }); // nothing left but what we added
  const post = await run(HERDR, ["config", "check"]);
  if (!post.ok) {
    if (before === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before);
    return { error: complaint(post.out), note };
  }
  await run(HERDR, ["server", "reload-config"]);
  return { error: "", note };
}

/** First step on an SSH machine: which herdr, is the companion linked, and the current config text. */
const PROBE = `set -u
H=
for p in /proc/[0-9]*; do # prefer the herdr that is running here: its version owns the plugin registry
  [ -O "$p" ] && [ "$(cat "$p/comm" 2>/dev/null)" = herdr ] && H=$(readlink "$p/exe") && break
done
[ -x "$H" ] || H=$(command -v herdr 2>/dev/null) || :
for c in "$HOME/.local/bin/herdr" /home/linuxbrew/.linuxbrew/bin/herdr "$HOME/.nix-profile/bin/herdr"; do
  [ -x "$H" ] || H=$c # where herdr's own setup and package managers put it
done
[ -x "$H" ] || { echo "=err herdr isn't installed on this machine"; exit 0; }
cfg="\${HERDR_CONFIG_PATH:-$HOME/.config/herdr/config.toml}"
echo "=herdr $H"
echo "=root $("$H" plugin list --plugin autofwd --json 2>/dev/null | grep -o '"plugin_root":"[^"]*"' | cut -d'"' -f4)"
echo "=dir $HOME/.local/share/herdr-autofwd/companion"
echo "=cfg $cfg"
if [ -e "$cfg" ]; then echo "=config $(base64 <"$cfg" | tr -d '\\n')"; else echo "=noconfig"; fi
`;

/** @param {string} s */
const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Second step: install or remove the companion and write the new config, undoing the config if herdr
 * rejects it. Prints "=ok" or "=err REASON"; reloads herdr there only when something changed.
 * @param {boolean} on @param {Record<string, string>} m probe results @param {string | null} before @param {string | null} after
 */
function applyScript(on, m, before, after) {
  const files = COMPANION.map(([name, body]) => `cat >"$tmp/${name}" <<'AUTOFWD_EOF'\n${body}AUTOFWD_EOF\n`).join("");
  const b64 = (/** @type {string} */ s) => Buffer.from(s).toString("base64");
  const writeConfig = before === after ? "" : `
mkdir -p "\${cfg%/*}"
${after ? `printf %s ${sq(b64(after))} | base64 -d >"$cfg"` : `rm -f "$cfg" # nothing left but what we added`}
if ! out=$("$H" config check 2>&1); then
  ${before === null ? `rm -f "$cfg"` : `printf %s ${sq(b64(before))} | base64 -d >"$cfg"`}
  fail "$(echo "$out" | tail -n 1)"
fi
changed=1`;
  return `set -u
fail() { echo "=err $*"; exit 0; }
H=${sq(m.herdr)}
root=${sq(m.root ?? "")}
dir=${sq(m.dir)}
cfg=${sq(m.cfg)}
changed=0
if [ ${on ? 1 : 0} = 1 ]; then
  [ -z "$root" ] || [ "$root" = "$dir" ] || fail "another autofwd plugin is installed there ($root)"
  mkdir -p "$dir" && tmp=$(mktemp -d) || fail "can't write $dir"
${files}  for f in ${SCRIPTS.join(" ")}; do
    cmp -s "$tmp/$f" "$dir/$f" || { cp "$tmp/$f" "$dir/$f"; changed=1; }
  done
  for f in "$dir"/*; do # files an earlier version shipped
    case "\${f##*/}" in herdr-plugin.toml${SCRIPTS.map((s) => `|${s}`).join("")}) ;; *) rm -f "$f"; changed=1 ;; esac
  done
  if ! cmp -s "$tmp/herdr-plugin.toml" "$dir/herdr-plugin.toml"; then
    cp "$tmp/herdr-plugin.toml" "$dir/herdr-plugin.toml"
    changed=1
    # herdr keeps the manifest it saw at link time, so a new one needs a fresh link
    [ -z "$root" ] || { "$H" plugin unlink autofwd >/dev/null 2>&1; root=; }
  fi
  rm -rf "$tmp"
  if [ -z "$root" ]; then "$H" plugin link "$dir" >/dev/null 2>&1 || fail "herdr plugin link failed"; changed=1; fi
  ${before === after ? "" : `out=$("$H" config check 2>&1) || fail "herdr config there already has a problem: $(echo "$out" | tail -n 1)"`}
  ${writeConfig}
else
  # Unregister first: unlink needs herdr running there, and deleting the files of a still-registered
  # plugin would leave herdr with a broken entry.
  if [ "$root" = "$dir" ]; then
    "$H" plugin unlink autofwd >/dev/null 2>&1 || fail "couldn't unregister the companion; is herdr running there?"
    changed=1
  fi
  ${writeConfig}
  rm -rf "$dir" "${REMOTE_STATUS}"
  rmdir "\${dir%/*}" "\${HOME}/.cache/herdr-autofwd" 2>/dev/null # our folders, only if now empty
fi
[ "$changed" = 0 ] || "$H" server reload-config >/dev/null 2>&1
echo "=ok"
`;
}

/**
 * Run a script on a machine over its existing connection; resolves with its stdout.
 * @param {import("./forwarder.js").Forwarder} f @param {string} script
 */
function remoteRun(f, script) {
  return new Promise((resolve) => {
    const child = f.session("sh -s");
    let out = "";
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout?.on("data", (d) => (out += d));
    child.stdin?.on("error", () => {});
    child.stdin?.end(script);
    child.on("close", () => (clearTimeout(timer), resolve(out)));
  });
}

/**
 * Set up (on) or remove the integration on an SSH machine.
 * @param {import("./forwarder.js").Forwarder} f @param {boolean} on @returns {Promise<{error: string, note: string}>}
 */
export async function remote(f, on) {
  /** @type {Record<string, string>} */
  const m = {};
  for (const line of String(await remoteRun(f, PROBE)).split("\n")) {
    const hit = /^=(\w+)(?: (.*))?$/.exec(line);
    if (hit) m[hit[1]] = hit[2] ?? "";
  }
  if (m.err !== undefined) return { error: printable(m.err), note: "" };
  if (!m.herdr || !m.cfg || !m.dir) return { error: "no answer from the machine", note: "" };
  const before = m.config !== undefined ? Buffer.from(m.config, "base64").toString("utf8") : null;
  const { text: after, note } = editConfig(before ?? "", on, statusCommand(REMOTE_STATUS));
  // An absent config that stays empty is unchanged: null on both sides.
  const out = String(await remoteRun(f, applyScript(on, m, before, before === null && after === "" ? null : after)));
  const line = out.split("\n").find((l) => l === "=ok" || l.startsWith("=err ")) ?? "=err no answer from the machine";
  return { error: line === "=ok" ? "" : printable(line.slice(5)), note };
}
