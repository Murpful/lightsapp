// Works out which palettes each effect can ACTUALLY use.
//
// WLED's own metadata is not trustworthy for this -- it declares Flow as not
// using palettes, yet Flow is entirely palette-driven. So each effect is fed
// three unmistakable colours (pure red, green, blue) under every candidate
// palette, and the output is measured.
//
// An effect that ignores the palette produces identical output whichever is
// selected; offering the others would be a menu of choices that do nothing.
//
// Usage:  node tools/palette-support.mjs [host] [fx,fx,...]

import { writeFile, readFile } from 'node:fs/promises';
import { captureDevice } from '../lib/capture.js';

const HOST = process.argv[2] || '192.168.0.160';
const OUT = 'data/fx-palettes.json';
const REPEATS = 2;

// Only the palettes the app offers.
const CANDIDATES = [0, 2, 3, 4, 5];

const post = (b) => fetch(`http://${HOST}/json/state`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (h) => { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * Fingerprint: how much of each of our three colours shows up, plus how much
 * colour appears that is NOT ours. Two palettes producing the same fingerprint
 * are indistinguishable in practice.
 */
function fingerprint(frames) {
  const px = frames.flat().map(hex).filter((c) => lum(c) > 0.10);
  if (!px.length) return { r: 0, g: 0, b: 0, other: 0, n: 0 };
  let r = 0, g = 0, b = 0, other = 0;
  for (const [R, G, B] of px) {
    const mx = Math.max(R, G, B), sum = R + G + B || 1;
    const fr = R / sum, fg = G / sum, fb = B / sum;
    if (mx < 25) continue;
    if (fr > 0.55) r++;
    else if (fg > 0.55) g++;
    else if (fb > 0.55) b++;
    else other++;
  }
  const n = r + g + b + other || 1;
  return { r: +(r / n).toFixed(3), g: +(g / n).toFixed(3), b: +(b / n).toFixed(3), other: +(other / n).toFixed(3), n };
}

const dist = (a, z) =>
  Math.abs(a.r - z.r) + Math.abs(a.g - z.g) + Math.abs(a.b - z.b) + Math.abs(a.other - z.other);

const before = await (await fetch(`http://${HOST}/json/state`)).json();
const effects = (await (await fetch(`http://${HOST}/json/eff`)).json()).map((s) => String(s).split('@')[0]);
const palettes = await (await fetch(`http://${HOST}/json/pal`)).json();
const FX = (process.argv[3] || '110,112,80,28,0,117,102,2,46,73,83').split(',').map(Number);

const out = JSON.parse(await readFile(OUT, 'utf8').catch(() => '{}'));
console.log(`palette support on ${HOST}\n`);

for (const fx of FX) {
  const name = effects[fx] ?? `fx ${fx}`;
  const prints = {};
  for (const pal of CANDIDATES) {
    await post({ on: true, bri: 255,
      seg: [{ id: 0, fx, pal, sx: 128, ix: 128, col: [[255, 0, 0], [0, 255, 0], [0, 0, 255]] }] });
    await sleep(1200);
    const frames = [];
    for (let r = 0; r < REPEATS; r++) frames.push(...await captureDevice(HOST, { frames: 30, timeout: 8000 }));
    prints[pal] = fingerprint(frames);
  }

  // "* Color 1" is the reference: it can only ever show colour 1.
  const ref = prints[2];
  const usable = [];
  for (const pal of CANDIDATES) {
    const p = prints[pal];
    if (!p.n) continue;
    // Keep the reference, plus any palette that visibly differs from it.
    if (pal === 2 || dist(p, ref) > 0.12) usable.push(pal);
  }
  // Drop palettes that duplicate one already kept.
  const kept = [];
  for (const pal of usable) {
    if (kept.every((k) => dist(prints[pal], prints[k]) > 0.12)) kept.push(pal);
  }

  out[fx] = {
    name,
    usable: kept,
    usableNames: kept.map((p) => palettes[p]),
    ignoresPalette: kept.length === 1,
    prints: Object.fromEntries(Object.entries(prints).map(([k, v]) => [k, v])),
  };
  console.log(
    `fx ${String(fx).padEnd(4)} ${name.padEnd(20)} ${kept.length === 1 ? 'IGNORES palette  ' : 'uses palette     '}` +
    `usable: ${kept.map((p) => palettes[p]).join(', ')}`
  );
}

await post({ on: before.on, bri: before.bri,
  seg: [{ id: 0, fx: before.seg[0].fx, pal: before.seg[0].pal, sx: before.seg[0].sx, ix: before.seg[0].ix, col: before.seg[0].col }] });
await writeFile(OUT, JSON.stringify(out, null, 1), 'utf8');
console.log(`\nrestored; ${Object.keys(out).length} effect(s) -> ${OUT}`);
