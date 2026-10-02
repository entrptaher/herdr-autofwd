// @ts-check
// What the Ports panel does on this computer: open a forwarded address in the browser, copy it.
import { spawn } from "node:child_process";

/** Open in the system browser. @param {string} url @param {(message: string) => void} onError */
export function openUrl(url, onError) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).on("error", () => onError(`Couldn't run ${opener}`)).unref();
}

/** Copy to this computer's clipboard; calls fallback when no clipboard tool exists. @param {string} text @param {() => void} fallback */
export function copyText(text, fallback) {
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
