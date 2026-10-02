// @ts-check
// Pure helpers shared by the daemon, the Ports panel and the browser demo (no Node APIs here).

/** @param {unknown} n */
export const isPort = (n) => Number.isInteger(n) && /** @type {number} */ (n) >= 1 && /** @type {number} */ (n) <= 65535;

/**
 * A forward's destination ("dest") is "host:port" as seen from the machine: "localhost:3000",
 * "db.internal:5432", "[fd00::1]:80". "3000" -> "localhost:3000"; anything else is null. The host check
 * also keeps dests safe inside an ssh -L spec.
 * @param {string} text @returns {string | null}
 */
export function parseDest(text) {
  const m = /^(?:(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):)?(\d{1,5})$/.exec(String(text).trim());
  return m && isPort(Number(m[2])) ? `${m[1] ?? "localhost"}:${Number(m[2])}` : null;
}

/** @param {string} dest */
export const destPort = (dest) => Number(dest.slice(dest.lastIndexOf(":") + 1));
/** @param {string} dest */
export const destHost = (dest) => dest.slice(0, dest.lastIndexOf(":"));
/** How a dest is shown: just the port when it's the machine's own. @param {string} dest */
export const showDest = (dest) => (destHost(dest) === "localhost" ? String(destPort(dest)) : dest);

/**
 * Text from the machine (process names, SSH errors and banners) is drawn in your terminal, so it must
 * not carry escape sequences: a process could otherwise name itself to rewrite the screen or clipboard.
 * @param {string} text
 */
export function printable(text) {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** "⇄ 3000 5173→5174" for herdr's tab row. @param {{remote: string, local: number | null}[]} rows */
export function indicator(rows) {
  const parts = rows.filter((r) => r.local !== null).map((r) => (r.remote === String(r.local) ? r.remote : `${r.remote}→${r.local}`));
  if (!parts.length) return "⇄ no ports";
  const text = `⇄ ${parts.join(" ")}`;
  return text.length <= 40 ? text : `⇄ ${parts.length} ports`;
}
