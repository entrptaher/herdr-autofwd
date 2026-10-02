// @ts-check
// The herdr config edits behind the panel's S: exact undo, idempotent, and accepted by herdr itself
// (`herdr config check`, when herdr is installed).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { editConfig, statusCommand } from "../src/integration.js";

const command = statusCommand("$HOME/.cache/herdr-autofwd/status");
const OLD_BLOCK = `# autofwd:begin (added by the autofwd plugin; remove it from the Ports panel with S)
[[keys.command]]
key = "prefix+f"
type = "plugin_action"
command = "autofwd.ports"
description = "Ports panel (autofwd)"
# autofwd:end
`;
const configs = {
  empty: "",
  plain: "onboarding = false\n",
  "existing [ui] table": 'onboarding = false\n\n[ui]\nagent_panel_scope = "all"\n\n[update]\nchannel = "preview"\n',
  "[ui] header with a comment": '[ui] # mine\nagent_panel_sort = "spaces"\n',
  "no trailing newline": "onboarding = false",
  "tab_bar_right already set": '[ui]\ntab_bar_right = [{ type = "hostname" }]\n',
  "own binding for the panel": '[[keys.command]]\nkey = "prefix+o"\ntype = "plugin_action"\ncommand = "autofwd.ports"\n',
};

/** herdr's verdict on a config text, or null when herdr isn't installed. @param {string} text */
function herdrCheck(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afw-cfg-"));
  try {
    fs.writeFileSync(path.join(dir, "config.toml"), text);
    execFileSync("herdr", ["config", "check"], { env: { ...process.env, HERDR_CONFIG_PATH: path.join(dir, "config.toml") }, stdio: "pipe" });
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT" ? null : false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [name, text] of Object.entries(configs)) {
  test(`config edit: ${name}`, () => {
    const on = editConfig(text, true, command);
    assert.equal(editConfig(on.text, true, command).text, on.text, "setting up twice changes nothing");
    const off = editConfig(on.text, false, command).text;
    if (name === "no trailing newline") assert.equal(off, text + "\n", "only a final newline is added");
    else assert.equal(off, text, "removing restores the original exactly");
    assert.equal(on.text.match(/autofwd\.ports/g)?.length, 1, "exactly one binding for the panel");
    if (name === "tab_bar_right already set") {
      assert.match(on.note, /tab_bar_right is already set/);
      assert.ok(!on.text.includes("herdr-autofwd/status"), "an existing tab row is left alone");
    } else {
      assert.equal(on.note, "");
      assert.equal(on.text.match(/tab_bar_right/g)?.length, 1, "one indicator");
    }
    const verdict = herdrCheck(on.text);
    if (verdict !== null) assert.equal(verdict, true, `herdr accepts it:\n${on.text}`);
  });
}

test("the default socket dir leaves room for ssh's control socket", () => {
  // The default, as herdr starts the daemon (no AUTOFWD_RUN_DIR): ssh refuses socket paths over 103 bytes.
  const env = { ...process.env, AUTOFWD_RUN_DIR: "", HERDR_PLUGIN_STATE_DIR: path.join(os.homedir(), ".local/state/herdr/plugins/autofwd") };
  const out = execFileSync(process.execPath, ["-e", 'import("./src/common.js").then((m) => console.log(m.RUN_DIR, m.SOCKET_ROOM))'], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."), env, encoding: "utf8",
  }).trim().split(" ");
  assert.ok(out[0].length + Number(out[1]) <= 103, `${out[0]} is too long for a unix socket path`);
});

test("config edit: a setup from an earlier version is replaced, not doubled", () => {
  const text = `onboarding = false\n\n${OLD_BLOCK}`;
  const on = editConfig(text, true, command).text;
  assert.equal(on.match(/autofwd:begin/g)?.length, 1);
  assert.equal(editConfig(on, false, command).text, "onboarding = false\n");
});
