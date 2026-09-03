// Records what WLED effects ACTUALLY do, instead of guessing from their names.
//
// Each effect is pushed to a controller with a white primary on black, so the
// captured frames are a pure motion envelope: brightness over position and
// time, with no colour of its own. The simulator replays that envelope and
// tints it with whatever colours the operator has chosen.
//
// Usage:  node tools/record-effects.mjs [host] [fx,fx,fx...]

import { writeFile, readFile } from 'node:fs/promises';
import { captureDevice } from '../lib/capture.js';

const HOST = process.argv[2] || '192.168.0.160';
const FX = (process.argv[3] || '110,112,80,28,0').split(',').map(Number);
const OUT = 'data/fx-profiles.json';

const FRAMES = 36;   // ~1s at the controller's ~40fps
const SAMPLES = 48;  // matches the capture resolution

const post = (body) =>
  fetch(`http://${HOST}/json/state`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Frames of "#rrggbb" become a 0..1 brightness envelope. */
function toEnvelope(frames) {
  return frames.map((f) =>
    f.map((hex) => {
      const v = parseInt(hex.slice(1), 16);
      const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
      // Perceptual luminance: a white source means this is purely intensity.
      return Math.round(((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * 1000) / 1000;
    })
  );
}

/** Cheap descriptors so the result can be sanity-checked without eyeballing it. */
function describe(env) {
  const flat = env.flat();
  const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
  const lit = flat.filter((v) => v > 0.08).length / flat.length;
  // How much any one position changes over time -> is it animated at all?
  let motion = 0;
  for (let p = 0; p < SAMPLES; p++) {
    let mn = 1, mx = 0;
    for (const f of env) { if (f[p] < mn) mn = f[p]; if (f[p] > mx) mx = f[p]; }
    motion += mx - mn;
  }
  motion /= SAMPLES;
  // How much neighbouring positions differ within a frame -> spatial structure.
  let spatial = 0;
  for (const f of env) {
    let d = 0;
    for (let p = 1; p < SAMPLES; p++) d += Math.abs(f[p] - f[p - 1]);
    spatial += d / (SAMPLES - 1);
  }
  spatial /= env.length;
  return {
    meanBrightness: +mean.toFixed(3),
    litFraction: +lit.toFixed(3),
    temporalMotion: +motion.toFixed(3),
    spatialDetail: +spatial.toFixed(3),
  };
}

const before = await (await fetch(`http://${HOST}/json/state`)).json();
const info = await (await fetch(`http://${HOST}/json/info`)).json();
const effects = (await (await fetch(`http://${HOST}/json/eff`)).json()).map((s) => String(s).split('@')[0]);
console.log(`recording on ${info.name} (${info.leds.count} LEDs)\n`);

const profiles = JSON.parse(await readFile(OUT, 'utf8').catch(() => '{}'));

for (const fx of FX) {
  // White on black, mid speed and intensity: the reference conditions the
  // simulator assumes when it replays this envelope.
  await post({
    on: true, bri: 255,
    seg: [{ id: 0, fx, pal: 0, sx: 128, ix: 128, col: [[255, 255, 255], [0, 0, 0], [0, 0, 0]] }],
  });
  await sleep(1100); // let the transition finish so frame 0 is the real effect

  const frames = await captureDevice(HOST, { frames: FRAMES, timeout: 9000 });
  if (frames.length < 4) { console.log(`fx ${fx} ${effects[fx]}: only ${frames.length} frames, skipped`); continue; }

  const env = toEnvelope(frames);
  const stats = describe(env);
  profiles[fx] = { name: effects[fx], samples: SAMPLES, frames: env.length, sx: 128, ix: 128, env, stats };
  console.log(
    `fx ${String(fx).padEnd(4)} ${effects[fx].padEnd(20)} frames=${String(env.length).padEnd(3)} ` +
    `lit=${stats.litFraction}  motion=${stats.temporalMotion}  spatial=${stats.spatialDetail}`
  );
}

await post({
  on: before.on, bri: before.bri,
  seg: [{ id: 0, fx: before.seg[0].fx, pal: before.seg[0].pal, sx: before.seg[0].sx, ix: before.seg[0].ix, col: before.seg[0].col }],
});
await writeFile(OUT, JSON.stringify(profiles), 'utf8');
console.log(`\nrestored ${info.name}; wrote ${Object.keys(profiles).length} profile(s) to ${OUT}`);
