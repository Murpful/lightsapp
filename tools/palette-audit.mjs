// Audits EVERY effect for palette behaviour, on real hardware.
//
// Two questions per effect:
//   1. Does it accept a user-defined colour at all?  Feed it flat white through
//      "* Color 1". Colour in the output can only be the effect's own, so a
//      saturated result means the operator cannot control it -> blacklist.
//   2. Which palettes actually do something?  Feed it red/green/blue under each
//      candidate palette and fingerprint the output. Palettes that produce an
//      indistinguishable result are dead entries in the menu.
//
// WLED's own metadata cannot answer either -- it declares Flow as using no
// palette and no colours, when Flow is entirely palette-driven.
//
// Usage:  node tools/palette-audit.mjs <host> <fxStart> <fxEnd> <outSuffix>

import { writeFile } from 'node:fs/promises';
import { decodeFrame } from '../lib/capture.js';

const HOST = process.argv[2];
// Either a range ("96 142") or an explicit comma-separated list, so the
// leftovers from interrupted runs can be spread thinly across controllers.
const LIST = String(process.argv[3] ?? '').includes(',')
  ? process.argv[3].split(',').map(Number)
  : null;
const FROM = LIST ? 0 : Number(process.argv[3] ?? 0);
const TO = LIST ? 0 : Number(process.argv[4] ?? 189);
const SUFFIX = (LIST ? process.argv[4] : process.argv[5]) ?? 'a';

const CANDIDATES = [0, 2, 3, 4, 5];   // Default, * Color 1, * Colors 1&2, * Color Gradient, * Colors Only
const FRAMES = 10;                    // a fingerprint needs very few frames
const SETTLE = 700;
const AUDIO_NOTE = /[♪♫♬♩]/u;

const post = (b) => fetch(`http://${HOST}/json/state`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (h) => { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const sat = ([r, g, b]) => { const mx = Math.max(r, g, b); return mx ? (mx - Math.min(r, g, b)) / mx : 0; };

/**
 * ONE live-view socket held open for the whole run.
 *
 * Opening a fresh WebSocket per capture -- six per effect, hundreds across a
 * run -- exhausts the ESP32's sockets and heap and reboots it. That is what
 * killed the first attempt: the controllers were not refusing the work, they
 * were resetting under it, and the tool saw the dropped connection as an error.
 */
class LiveTap {
  constructor(host) { this.host = host; this.ws = null; this.frames = []; }

  async open() {
    await this.close();
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${this.host}/ws`);
      ws.binaryType = 'arraybuffer';
      const done = setTimeout(resolve, 4000);
      ws.addEventListener('open', () => { ws.send(JSON.stringify({ lv: true })); clearTimeout(done); resolve(); });
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') return;
        const px = decodeFrame(new Uint8Array(ev.data));
        if (px) { this.frames.push(px); if (this.frames.length > 400) this.frames.shift(); }
      });
      ws.addEventListener('error', () => { clearTimeout(done); resolve(); });
      ws.addEventListener('close', () => { this.ws = null; });
      this.ws = ws;
    });
  }

  get alive() { return this.ws && this.ws.readyState === 1; }

  /** Collects the next `n` frames that arrive, reconnecting only if dropped. */
  async grab(n = FRAMES, timeout = 3000) {
    if (!this.alive) await this.open();
    this.frames.length = 0;
    const started = Date.now();
    while (this.frames.length < n && Date.now() - started < timeout) await sleep(60);
    return this.frames.slice(0, n);
  }

  async close() {
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    await sleep(120);
  }
}

const tap = new LiveTap(HOST);
const grab = () => tap.grab();

/** Which of our three colours appear, and how much colour that is not ours. */
function fingerprint(frames) {
  const px = frames.flat().map(hex).filter((c) => lum(c) > 0.10);
  if (!px.length) return null;
  let r = 0, g = 0, b = 0, other = 0;
  for (const [R, G, B] of px) {
    const sum = R + G + B || 1;
    if (Math.max(R, G, B) < 25) continue;
    if (R / sum > 0.55) r++;
    else if (G / sum > 0.55) g++;
    else if (B / sum > 0.55) b++;
    else other++;
  }
  const n = r + g + b + other || 1;
  return { r: +(r / n).toFixed(3), g: +(g / n).toFixed(3), b: +(b / n).toFixed(3), other: +(other / n).toFixed(3) };
}
const dist = (a, z) => !a || !z ? 1
  : Math.abs(a.r - z.r) + Math.abs(a.g - z.g) + Math.abs(a.b - z.b) + Math.abs(a.other - z.other);

const before = await (await fetch(`http://${HOST}/json/state`)).json();
const info = await (await fetch(`http://${HOST}/json/info`)).json();
const effects = (await (await fetch(`http://${HOST}/json/eff`)).json()).map((s) => String(s).split('@')[0]);

const out = {};
console.log(`${info.name}: effects ${FROM}..${TO}  (single persistent live-view socket)`);
await tap.open();

const TARGETS = LIST ?? Array.from({ length: TO - FROM + 1 }, (_, k) => FROM + k);

for (const fx of TARGETS) {
  if (fx >= effects.length) continue;
  const name = effects[fx];

  if (AUDIO_NOTE.test(name)) {
    out[fx] = { name, audioReactive: true, usable: [], selfColoured: false };
    continue;
  }

  // One flaky capture must not end the run. The weaker-linked controllers threw
  // partway through and lost everything measured up to that point.
  try {

  // 1. Colour control test: flat white through "* Color 1".
  await post({ on: true, bri: 255,
    seg: [{ id: 0, fx, pal: 2, sx: 128, ix: 128, col: [[255, 255, 255], [0, 0, 0], [0, 0, 0]] }] });
  await sleep(SETTLE);
  const white = (await grab()).flat().map(hex).filter((c) => lum(c) > 0.15);
  const meanSat = white.length ? white.reduce((a, c) => a + sat(c), 0) / white.length : 0;
  const selfColoured = meanSat > 0.25;

  // 2. Palette fingerprints with three unmistakable colours.
  const prints = {};
  for (const pal of CANDIDATES) {
    await post({ on: true, bri: 255,
      seg: [{ id: 0, fx, pal, sx: 128, ix: 128, col: [[255, 0, 0], [0, 255, 0], [0, 0, 255]] }] });
    await sleep(SETTLE);
    prints[pal] = fingerprint(await grab());
  }

  const ref = prints[2];
  const kept = [];
  for (const pal of CANDIDATES) {
    if (!prints[pal]) continue;
    if (pal === 2) { kept.push(pal); continue; }
    // Keep only palettes that differ from everything already kept.
    if (kept.every((k) => dist(prints[pal], prints[k]) > 0.12)) kept.push(pal);
  }

  out[fx] = {
    name, selfColoured, meanSat: +meanSat.toFixed(3),
    usable: selfColoured ? [] : kept,
    ignoresPalette: kept.length <= 1,
    prints,
  };
    const mark = selfColoured ? 'SELF-COLOURED (blacklist)' : `${kept.length} palette(s)`;
    console.log(`fx ${String(fx).padEnd(4)} ${name.slice(0, 22).padEnd(23)} sat=${meanSat.toFixed(2)}  ${mark}`);
  } catch (e) {
    console.log(`fx ${String(fx).padEnd(4)} ${name.slice(0, 22).padEnd(23)} ERROR: ${e.message} - skipped`);
  }

  // Save as we go, so a later failure cannot discard everything measured.
  if (fx % 5 === 0) await writeFile(`data/fx-audit-${SUFFIX}.json`, JSON.stringify(out), 'utf8');

  // Breathing room. These are small microcontrollers and the point is to
  // measure them, not to see how hard they can be pushed.
  await sleep(250);
}
await tap.close();

await post({ on: before.on, bri: before.bri,
  seg: [{ id: 0, fx: before.seg[0].fx, pal: before.seg[0].pal, sx: before.seg[0].sx, ix: before.seg[0].ix, col: before.seg[0].col }] });
await writeFile(`data/fx-audit-${SUFFIX}.json`, JSON.stringify(out), 'utf8');
console.log(`\ndone: ${Object.keys(out).length} effects -> data/fx-audit-${SUFFIX}.json`);
