#!/usr/bin/env node
// @ts-check
// Builds the browser demo into one self-contained page: page.html with page.js and every module it
// imports (the real Ports panel among them) inlined, plus xterm's stylesheet. One file opens from disk,
// and can be published anywhere that only allows inline code.
// Run: node demo/web/build.js [out.html]   (default: demo/web/dist/autofwd-demo.html)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = path.resolve(process.argv[2] ?? path.join(here, "dist", "autofwd-demo.html"));
// ponytail: handles the import/export forms this repo uses (named and namespace imports, `export`
// declarations and `export { a, b }`); anything fancier needs a real bundler.
const IMPORT = /^import\s+(\{[^}]*\}|\*\s+as\s+\w+)\s+from\s+"(\.[^"]+)";$/gm;

/** file -> code that defines it, dependencies first @type {Map<string, string>} */
const modules = new Map();

/** @param {string} file */
function add(file) {
  if (modules.has(file)) return;
  modules.set(file, ""); // placeholder, so an import cycle stops here
  const id = JSON.stringify(path.relative(root, file));
  /** @type {string[]} */
  const names = [];
  const src = fs
    .readFileSync(file, "utf8")
    .replace(IMPORT, (_, what, spec) => {
      const dep = path.resolve(path.dirname(file), spec);
      add(dep);
      const ref = `__m[${JSON.stringify(path.relative(root, dep))}]`;
      return what.startsWith("*") ? `const ${what.split(/\s+/).pop()} = ${ref};` : `const ${what.replace(/\s+as\s+/g, ": ")} = ${ref};`;
    })
    .replace(/^export (async function|function|class|const|let) (\w+)/gm, (_, kind, name) => (names.push(name), `${kind} ${name}`))
    .replace(/^export \{([^}]*)\};$/gm, (_, list) => (names.push(...list.split(",").map((/** @type {string} */ s) => s.trim()).filter(Boolean)), ""));
  modules.delete(file); // re-insert after its dependencies
  modules.set(file, `__m[${id}] = await (async () => {\n${src}\nreturn { ${names.join(", ")} };\n})();`);
}

add(path.join(here, "page.js"));
const script = `const __m = {};\n${[...modules.values()].join("\n")}`.replaceAll("</script", "<\\/script");
const html = fs
  .readFileSync(path.join(here, "page.html"), "utf8")
  .replace("/* xterm.css */", () => fs.readFileSync(path.join(here, "xterm.css"), "utf8"))
  .replace("<!-- page.js -->", () => `<script type="module">\n${script}\n</script>`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${path.relative(process.cwd(), out)} (${Math.round(html.length / 1024)} KB, ${modules.size} modules)`);
