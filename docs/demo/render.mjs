#!/usr/bin/env node
// Turn tmux `capture-pane -e -p` captures into ONE looping, CSS-animated SVG slideshow.
// The output has no JavaScript, so it plays inside an <img> (e.g. a GitHub README).
//
// Usage: node docs/demo/render.mjs <spec.json> <out.svg>
//        node docs/demo/render.mjs --check        (self-check of parser, styles and timeline)
// spec.json: { "title"?: "...", "cols": 120, "rows": 34,
//              "frames": [{ "file": "01.ansi", "caption": "...", "seconds": 3.5 }] }
// Frame files are resolved relative to the spec file's directory.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const CW = 8.4, LH = 18, BASELINE = 13, FADE = 0.25; // cell width, line height, text baseline, crossfade (s)
const PX = 16, TB = 32, PY = 12, CAP = 48; // window side padding, title bar, grid padding, caption bar
const FG = '#cdd6f4', BG = '#1e1e2e', CHROME = '#181825', LINE = '#313244', MUTED = '#a6adc8';
// Catppuccin Mocha terminal palette (ANSI 0-15).
const PALETTE = ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
  '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'];
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono",monospace';
const SANS = '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif';
const RESET = Object.freeze({ fg: null, bg: null, b: false, d: false, i: false, u: false, v: false });

const byte = (v) => Math.min(255, Math.max(0, Math.trunc(Number(v)) || 0));
const hex = (r, g, b) => '#' + [r, g, b].map((v) => byte(v).toString(16).padStart(2, '0')).join('');
const num = (v) => +v.toFixed(2);
const esc = (s) => s.replace(/[\0-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function color256(n) {
  n = byte(n);
  if (n < 16) return PALETTE[n];
  if (n >= 232) { const g = 8 + (n - 232) * 10; return hex(g, g, g); }
  const lv = [0, 95, 135, 175, 215, 255];
  n -= 16;
  return hex(lv[Math.floor(n / 36)], lv[Math.floor(n / 6) % 6], lv[n % 6]);
}

// Apply one SGR parameter string ("1;38;2;10;20;30", "4:3", "" = reset) and return the new style.
// ponytail: blink/hidden/strike (5/8/9...) and underline colour (58) are ignored; add cases if a capture needs them.
function sgr(style, params) {
  const s = { ...style };
  const ps = params === '' ? ['0'] : params.split(';');
  for (let k = 0; k < ps.length; k++) {
    const sub = ps[k].split(':');
    const p = Number(sub[0]) || 0;
    if (p === 38 || p === 48 || p === 58) {
      let c = null;
      if (sub.length > 1) { // colon form: 38:5:n, 38:2:r:g:b or 38:2:<colourspace>:r:g:b
        const o = sub.length > 5 ? 3 : 2;
        c = sub[1] === '5' ? color256(sub[2]) : sub[1] === '2' ? hex(sub[o], sub[o + 1], sub[o + 2]) : null;
      } else if (ps[k + 1] === '5') { c = color256(ps[k + 2]); k += 2; }
      else if (ps[k + 1] === '2') { c = hex(ps[k + 2], ps[k + 3], ps[k + 4]); k += 4; }
      if (c && p === 38) s.fg = c;
      else if (c && p === 48) s.bg = c;
      continue;
    }
    if (p === 0) Object.assign(s, RESET);
    else if (p === 1) s.b = true;
    else if (p === 2) s.d = true;
    else if (p === 3) s.i = true;
    else if (p === 4) s.u = sub[1] !== '0'; // 4:0 = off, 4:1..4:5 = underline styles
    else if (p === 7) s.v = true;
    else if (p === 22) s.b = s.d = false;
    else if (p === 23) s.i = false;
    else if (p === 24) s.u = false;
    else if (p === 27) s.v = false;
    else if (p >= 30 && p <= 37) s.fg = PALETTE[p - 30];
    else if (p >= 90 && p <= 97) s.fg = PALETTE[p - 82];
    else if (p >= 40 && p <= 47) s.bg = PALETTE[p - 40];
    else if (p >= 100 && p <= 107) s.bg = PALETTE[p - 92];
    else if (p === 39) s.fg = null;
    else if (p === 49) s.bg = null;
  }
  return s;
}

// Escape sequence starting at line[i] (ESC) -> [index after it, SGR params or null if not SGR].
function escapeAt(line, i) {
  const t = line[i + 1];
  if (t === '[') {
    let j = i + 2;
    while (j < line.length && !/[@-~]/.test(line[j])) j++;
    const params = line.slice(i + 2, j);
    return [j + 1, line[j] === 'm' && /^[\d;:]*$/.test(params) ? params : null];
  }
  if (t && ']P_^X'.includes(t)) { // OSC (e.g. hyperlinks), DCS, ...: skip to BEL or ST
    let j = i + 2;
    while (j < line.length && line[j] !== '\x07' && !(line[j] === '\x1b' && line[j + 1] === '\\')) j++;
    return [j + (line[j] === '\x07' ? 1 : 2), null];
  }
  return [i + 2, null];
}

// One capture -> rows x cols grid of { ch, s } cells. SGR state carries across lines (tmux emits diffs).
// ponytail: every character is one cell, so wide CJK/emoji would shift the rest of their line.
function parseCapture(text, cols, rows, name = 'capture') {
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > rows) console.warn(`warning: ${name}: ${lines.length} lines, only the first ${rows} are shown`);
  let style = RESET, wide = false;
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const line = lines[r] ?? '', cells = [];
    for (let i = 0; i < line.length;) {
      const ch = String.fromCodePoint(line.codePointAt(i)), cp = ch.codePointAt(0);
      if (cp === 0x1b) {
        const [next, params] = escapeAt(line, i);
        if (params !== null) style = sgr(style, params);
        i = next;
        continue;
      }
      i += ch.length;
      if (cp === 9) { do cells.push({ ch: ' ', s: style }); while (cells.length % 8); continue; }
      if (cp < 0x20 || cp === 0x7f) continue;
      if (/\p{M}/u.test(ch) && cells.length) { cells.at(-1).ch += ch; continue; } // combining mark: same cell
      cells.push({ ch, s: style });
    }
    if (cells.length > cols) { wide = true; cells.length = cols; }
    while (cells.length < cols) cells.push({ ch: ' ', s: RESET });
    grid.push(cells);
  }
  if (wide) console.warn(`warning: ${name}: some lines are wider than ${cols} columns and were cut`);
  return grid;
}

// Grid -> SVG background rects + text runs (grid-local coordinates). `cls` maps a colour to a CSS class.
function drawGrid(grid, cls) {
  const rects = [], texts = [];
  grid.forEach((row, r) => {
    const cells = row.map(({ ch, s }) => {
      let fg = s.fg ?? FG, bg = s.bg ?? BG;
      if (s.v) [fg, bg] = [bg, fg];
      const key = [fg !== FG && cls(fg), s.b && 'b', s.d && 'd', s.i && 'i', s.u && 'u'].filter(Boolean).join(' ');
      // Non-ASCII glyphs other than box drawing may come from a fallback font: give each its own cell box.
      return { ch, key, bg: bg === BG ? null : bg, blank: ch === ' ' && !s.u, odd: /[^\x20-\x7e─-▟]/.test(ch) };
    });
    const n = cells.length;
    for (let c = 0; c < n;) {
      let e = c + 1;
      while (e < n && cells[e].bg === cells[c].bg) e++;
      if (cells[c].bg) rects.push(`<rect x="${num(c * CW)}" y="${r * LH}" width="${num((e - c) * CW)}" height="${LH}" class="${cls(cells[c].bg)}"/>`);
      c = e;
    }
    for (let c = 0; c < n;) {
      if (cells[c].blank) { c++; continue; }
      // Same-style cells form one run; a single space may join two words, wider gaps end the run.
      const same = (k) => k < n && cells[k].key === cells[c].key && !cells[k].odd;
      let e = c + 1;
      if (!cells[c].odd) while (same(e) && (!cells[e].blank || (same(e + 1) && !cells[e + 1].blank))) e++;
      const key = cells[c].key, chars = cells.slice(c, e).map((x) => x.ch).join('');
      texts.push(`<text x="${num(c * CW)}" y="${r * LH + BASELINE}" textLength="${num((e - c) * CW)}" lengthAdjust="spacingAndGlyphs"${key ? ` class="${key}"` : ''}>${esc(chars)}</text>`);
      c = e;
    }
  });
  return (rects.length ? `<g shape-rendering="crispEdges">\n${rects.join('\n')}\n</g>\n` : '') + texts.join('\n');
}

// Per-frame opacity stops [seconds, opacity]. Frame i is fully shown on [start, end - fade] and crossfades
// into frame i+1 during [end - fade, end]; the last frame fades into frame 0 at the loop seam, so frame 0
// is fully visible at t = 0.
function timeline(secs, fade) {
  const total = secs.reduce((a, b) => a + b, 0);
  let start = 0;
  return secs.map((d, i) => {
    const end = start + d;
    const st = i === 0
      ? [[0, 1], [end - fade, 1], [end, 0], [total - fade, 0], [total, 1]]
      : [[0, 0], [start - fade, 0], [start, 1], [end - fade, 1], [end, 0], [total, 0]];
    start = end;
    return st.filter((p, k) => k === 0 || p[0] !== st[k - 1][0]);
  });
}

function render(spec, texts) {
  const { cols, rows, frames } = spec;
  const N = frames.length, secs = frames.map((f) => f.seconds), total = secs.reduce((a, b) => a + b, 0);
  const W = Math.ceil(cols * CW + 2 * PX), gridY = TB + PY, capTop = gridY + rows * LH + PY, H = capTop + CAP;
  const capY = capTop + CAP / 2 + 6, dotY = capTop + CAP / 2;
  const dotsRight = W - PX - `${N} / ${N}`.length * 8 - 14, dotX = (k) => num(dotsRight - (N - 1 - k) * 12);
  const capMax = dotX(0) - PX - 16;
  const colors = new Map(), cls = (c) => colors.get(c) ?? (colors.set(c, `k${colors.size}`), `k${colors.size - 1}`);

  const body = frames.map((f, i) => {
    const caption = f.caption ?? '';
    if (caption && caption.length * 8.5 > capMax) console.warn(`warning: frame ${i + 1} caption may not fit (~${Math.round(capMax)}px available)`);
    const grid = parseCapture(texts[i], cols, rows, f.file);
    return `<g class="f a${i}"${i ? ' opacity="0"' : ''}>
<g transform="translate(${PX},${gridY})">
${drawGrid(grid, cls)}
</g>
<text class="cap" x="${PX}" y="${capY}">${esc(caption)}</text>
<text class="n" x="${W - PX}" y="${capY}" text-anchor="end">${i + 1} / ${N}</text>
<circle cx="${dotX(i)}" cy="${dotY}" r="3.5" fill="#89b4fa"/>
</g>`;
  });

  const fade = Math.min(FADE, Math.min(...secs) / 2), pct = (t) => `${+(t / total * 100).toFixed(3)}%`;
  const anim = N < 2 ? '' : `.f{animation:${num(total)}s linear infinite}\n` + timeline(secs, fade).map((st, i) =>
    `.a${i}{animation-name:a${i}}@keyframes a${i}{${st.map(([t, o]) => `${pct(t)}{opacity:${o}}`).join('')}}`).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" xml:space="preserve">
<title>${esc(spec.title ?? 'Demo')}</title>
<style>
text{font-family:${MONO};font-size:14px;fill:${FG};white-space:pre}
.b{font-weight:700}.i{font-style:italic}.u{text-decoration:underline}.d{opacity:.55}
.cap{font-family:${SANS};font-size:16px}.n{font-size:13px;fill:${MUTED}}
${[...colors].map(([c, k]) => `.${k}{fill:${c}}`).join('')}
${anim}
</style>
<rect width="${W}" height="${H}" rx="10" fill="${CHROME}"/>
<rect y="${TB}" width="${W}" height="${capTop - TB}" fill="${BG}"/>
<path d="M0 ${TB + 0.5}H${W}M0 ${capTop - 0.5}H${W}" stroke="${LINE}"/>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="9.5" fill="none" stroke="${LINE}"/>
<circle cx="20" cy="${TB / 2}" r="6" fill="${PALETTE[1]}"/><circle cx="40" cy="${TB / 2}" r="6" fill="${PALETTE[3]}"/><circle cx="60" cy="${TB / 2}" r="6" fill="${PALETTE[2]}"/>
${frames.map((_, k) => `<circle cx="${dotX(k)}" cy="${dotY}" r="3.5" fill="${PALETTE[8]}"/>`).join('')}
${body.join('\n')}
</svg>
`;
}

function check() {
  assert.deepEqual(sgr(sgr(RESET, '1;38;2;10;20;300'), '48;5;196;7'),
    { fg: '#0a14ff', bg: '#ff0000', b: true, d: false, i: false, u: false, v: true });
  assert.deepEqual(sgr(RESET, '38:2::1:2:3;4:3;2'), { ...RESET, fg: '#010203', u: true, d: true });
  assert.deepEqual(sgr(sgr(RESET, '1;2;4;7;31;42'), '22;24;27;39;49'), RESET);
  assert.deepEqual(sgr(sgr(RESET, '93;104'), ''), RESET);
  assert.equal(color256(244), '#808080');
  assert.equal(color256(21), '#0000ff');
  const g = parseCapture('a\x1b[4mb\x1b]8;;http://x\x1b\\c\x1b[m\x1b[?25ld\t|\n\x1b[31mx', 12, 3);
  assert.equal(g[0].map((c) => c.ch).join(''), 'abcd    |   ');
  assert.deepEqual(g[0].map((c) => c.s.u), [false, true, true, false, false, false, false, false, false, false, false, false]);
  assert.equal(g[1][0].s.fg, PALETTE[1]); // state carries across lines
  assert.equal(g[1][1].s, RESET); // padding uses the default style
  assert.equal(g[2].map((c) => c.ch).join(''), ' '.repeat(12));
  const svg = render({ cols: 8, rows: 1, frames: [{ file: 't', seconds: 1 }] }, ['<&> \x1b[7m \x1b[0m']);
  assert.match(svg, />&lt;&amp;&gt;</);
  const inv = svg.match(/<rect x="33.6" y="0" width="8.4" height="18" class="(k\d+)"\/>/); // inverse space
  assert.ok(inv && svg.includes(`.${inv[1]}{fill:${FG}}`));
  const secs = [3, 1, 2], tl = timeline(secs, 0.25), T = 6;
  const at = (st, t) => { const k = st.findIndex((p) => p[0] >= t); if (k <= 0) return st[0][1]; const [t0, o0] = st[k - 1], [t1, o1] = st[k]; return o0 + (o1 - o0) * (t - t0) / (t1 - t0); };
  for (let k = 0; k <= 240; k++) assert.ok(Math.abs(tl.reduce((a, st) => a + at(st, k * T / 240), 0) - 1) < 1e-9);
  assert.deepEqual(tl.map((st) => at(st, 0)), [1, 0, 0]);
  assert.deepEqual(tl.map((st) => at(st, 3.5)), [0, 1, 0]);
  assert.deepEqual(tl.map((st) => at(st, 5)), [0, 0, 1]);
  console.log('render.mjs self-check ok');
}

function main([specPath, outPath]) {
  if (!specPath || !outPath) throw new Error('usage: node docs/demo/render.mjs <spec.json> <out.svg>');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const { cols, rows, frames } = spec;
  if (![cols, rows].every((v) => Number.isInteger(v) && v > 0)) throw new Error('spec: "cols" and "rows" must be positive integers');
  if (!Array.isArray(frames) || !frames.length) throw new Error('spec: "frames" must be a non-empty array');
  frames.forEach((f, i) => {
    if (typeof f?.file !== 'string' || !(Number.isFinite(f.seconds) && f.seconds > 0)) throw new Error(`spec: frames[${i}] needs a "file" string and "seconds" > 0`);
  });
  const base = dirname(resolve(specPath));
  const svg = render(spec, frames.map((f) => readFileSync(resolve(base, f.file), 'utf8')));
  writeFileSync(outPath, svg);
  console.log(`${outPath}: ${frames.length} frames, ${Buffer.byteLength(svg)} bytes`);
}

try {
  if (process.argv[2] === '--check') check();
  else main(process.argv.slice(2));
} catch (e) {
  if (e instanceof assert.AssertionError) throw e;
  console.error(`render.mjs: ${e.message}`);
  process.exit(1);
}
