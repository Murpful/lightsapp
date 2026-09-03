// Measures what an effect really does, rather than inferring it from its name
// or from WLED's metadata (which cannot answer the colour question -- Flow
// declares no colour slots yet renders whatever primary you give it, because a
// Default palette is built from the segment colours).
//
// For each effect it answers two things empirically:
//
//   1. Does it impose its OWN colour?  Feed it pure white. If the output comes
//      back grey, the effect honours our colour and belongs in the picker. If
//      it comes back saturated, the colour is baked in and we cannot control it.
//
//   2. How does the speed slider map to real motion?  Record at several sx
//      values and measure the dominant temporal period of each. That yields a
//      fitted rate(sx) instead of assuming playback scales proportionally.
//
// Usage:  node tools/profile-effects.mjs [host] [fx,fx,...]

import { writeFile, readFile } from 'node:fs/promises';
import { captureDevice } from '../lib/capture.js';

const HOST = process.argv[2] || '192.168.0.160';
const FX = (process.argv[3] || '110,112,80,28,0,145,101').split(',').map(Number);
const SPEEDS = [64, 128, 192];
const FRAMES = 48;
const REPEATS = 3;   // averaged: the WiFi link drops frames, so one run is noisy
const OUT = 'data/fx-profiles.json';

/**
 * WLED marks audio-reactive effects with a music note. They follow live sound,
 * so a recording captures whatever was playing in the room rather than the
 * effect -- there is no fixed motion to record. They are flagged instead, and
 * the UI says the preview is unavailable rather than showing a fiction.
 */
const AUDIO_NOTE = /[♪♫♬♩]/u;

const post = (b) => fetch(`http://${HOST}/json/state`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexToRgb = (h) => { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
/** 0 = grey, 1 = fully saturated. */
const sat = ([r, g, b]) => { const mx = Math.max(r, g, b); return mx ? (mx - Math.min(r, g, b)) / mx : 0; };

const rms = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s / a.length); };

/**
 * How fast the pattern changes, measured three ways so that static, periodic
 * and scrolling effects are each handled honestly.
 *
 * The first attempt autocorrelated mean brightness, which failed: mean
 * brightness is near-constant for most effects, so it locked onto lag 2 noise
 * and reported a period for a static Solid. Shape distance from frame 0 is
 * robust because it uses the whole strip, and every measure is gated on the
 * pattern actually having changed at all.
 */
function analyse(env) {
  const F = env.length, n = env[0].length;

  // Change rate: mean RMS difference between consecutive frames.
  let churn = 0;
  for (let f = 1; f < F; f++) churn += rms(env[f], env[f - 1]);
  churn /= Math.max(1, F - 1);

  // Nothing moving at all -- Solid must land here.
  const spread = Math.max(...env.map((f) => rms(f, env[0])));
  if (spread < 0.02 && churn < 0.005) return { static: true, period: null, drift: 0, churn: +churn.toFixed(4) };

  // Period: the lag at which the strip most resembles frame 0 again, ignoring
  // trivially small lags and requiring it to be a real return, not noise.
  const d0 = env.map((f) => rms(f, env[0]));
  const far = Math.max(...d0);
  let period = null, bestD = far * 0.35;
  for (let lag = 3; lag < F; lag++) {
    if (d0[lag] < bestD && d0[lag - 1] > d0[lag] && (lag + 1 >= F || d0[lag + 1] > d0[lag])) { bestD = d0[lag]; period = lag; }
  }

  // Drift: per-frame spatial shift, accepted only when the alignment has a
  // genuine minimum. A uniform strip matches equally well at every shift, which
  // is what produced the nonsensical -6 on Solid.
  let total = 0, votes = 0;
  for (let f = 1; f < F; f++) {
    const errs = [];
    for (let s = -8; s <= 8; s++) {
      let e = 0;
      for (let p = 0; p < n; p++) { const d = env[f][(p + s + n) % n] - env[f - 1][p]; e += d * d; }
      errs.push({ s, e });
    }
    const lo = Math.min(...errs.map((x) => x.e));
    const hi = Math.max(...errs.map((x) => x.e));
    if (hi <= 0 || (hi - lo) / hi < 0.15) continue; // ambiguous: no real alignment
    total += errs.find((x) => x.e === lo).s;
    votes++;
  }
  return {
    static: false,
    period,
    drift: votes ? +(total / votes).toFixed(3) : 0,
    driftConfidence: +(votes / Math.max(1, F - 1)).toFixed(2),
    churn: +churn.toFixed(4),
  };
}

const before = await (await fetch(`http://${HOST}/json/state`)).json();
const info = await (await fetch(`http://${HOST}/json/info`)).json();
const effects = (await (await fetch(`http://${HOST}/json/eff`)).json()).map((s) => String(s).split('@')[0]);
console.log(`profiling on ${info.name} (${info.leds.count} LEDs), speeds ${SPEEDS.join('/')}\n`);

const profiles = JSON.parse(await readFile(OUT, 'utf8').catch(() => '{}'));
const report = [];

/**
 * Picks the most typical run rather than averaging them.
 *
 * Averaging the FRAMES was wrong: separate runs start at different points in
 * the effect's cycle, so frame 5 of each catches a different phase. Averaging
 * them blurs the motion out -- Dancing Shadows' measured churn halved, and
 * Twinklefox's dark gaps filled in until it no longer looked like a sparkle.
 *
 * Noise is instead reduced by measuring each run separately and taking the
 * median, which leaves the phase intact.
 */
function representativeRun(runs) {
  const good = runs.filter((r) => r.length >= 8);
  if (!good.length) return null;
  const churn = good.map((r) => {
    let c = 0;
    for (let f = 1; f < r.length; f++) {
      let s = 0;
      for (let i = 0; i < r[f].length; i++) { const d = r[f][i] - r[f - 1][i]; s += d * d; }
      c += Math.sqrt(s / r[f].length);
    }
    return c / Math.max(1, r.length - 1);
  });
  const order = churn.map((c, i) => ({ c, i })).sort((a, b) => a.c - b.c);
  return good[order[Math.floor(order.length / 2)].i];
}

for (const fx of FX) {
  const fxName = effects[fx] ?? `fx ${fx}`;

  if (AUDIO_NOTE.test(fxName)) {
    profiles[fx] = { name: fxName, audioReactive: true, env: null,
      note: 'Follows live audio; there is no fixed motion to record.' };
    console.log(`fx ${String(fx).padEnd(4)} ${fxName.padEnd(22)} AUDIO-REACTIVE - not recordable, flagged`);
    continue;
  }

  const perSpeed = {};
  let selfColour = 0;

  for (const sx of SPEEDS) {
    // White-to-black through "* Colors 1&2" (palette 3).
    //
    // Two conditions matter and they pull in opposite directions. The colour
    // test needs ONE flat colour, so any tint in the output must be the
    // effect's own -- that is done separately below through "* Color 1".
    // The MOTION capture needs contrast: recorded through a single flat colour,
    // a palette-cycling effect like Flow paints the strip uniformly and reads
    // as completely static. White-to-black keeps the recording greyscale, so it
    // is still a pure motion envelope, while giving movement something to be
    // visible against.
    //
    // "Default" is used for neither: it means the effect's own palette, not ours.
    await post({ on: true, bri: 255,
      seg: [{ id: 0, fx, pal: 3, sx, ix: 128, col: [[255, 255, 255], [0, 0, 0], [0, 0, 0]] }] });
    await sleep(1200);

    // Several independent passes; the median one is kept. The WiFi link drops
    // frames, so one run alone is unreliable -- but the runs must not be
    // blended, only compared.
    const runs = [];
    for (let r = 0; r < REPEATS; r++) {
      const frames = await captureDevice(HOST, { frames: FRAMES, timeout: 10000 });
      if (frames.length >= 8) runs.push(frames.map((f) => f.map((h) => +lum(hexToRgb(h)).toFixed(3))));
      await sleep(150);
    }
    const env = representativeRun(runs);
    if (!env) continue;
    perSpeed[sx] = { ...analyse(env), frames: env.length, runs: runs.length, env };
  }

  if (!Object.keys(perSpeed).length) { console.log(`fx ${fx}: no frames`); continue; }

  // Separate colour test: ONE flat white through "* Color 1". Any saturation in
  // the output cannot have come from us, so it is the effect's own.
  await post({ on: true, bri: 255,
    seg: [{ id: 0, fx, pal: 2, sx: 128, ix: 128, col: [[255, 255, 255], [0, 0, 0], [0, 0, 0]] }] });
  await sleep(1200);
  const colRuns = [];
  for (let r = 0; r < REPEATS; r++) {
    colRuns.push(...await captureDevice(HOST, { frames: 40, timeout: 9000 }));
    await sleep(120);
  }
  const bright = colRuns.flat().map(hexToRgb).filter((c) => lum(c) > 0.15);
  selfColour = bright.length ? bright.reduce((a, c) => a + sat(c), 0) / bright.length : 0;

  // Fit rate(sx). Churn is the most broadly applicable rate proxy: it is
  // defined for periodic and scrolling effects alike and is zero when static.
  const pts = SPEEDS.filter((s) => perSpeed[s] && !perSpeed[s].static)
    .map((s) => ({ sx: s, rate: perSpeed[s].churn }))
    .filter((p) => p.rate > 0);

  let model = null;
  if (pts.length >= 2) {
    // Least-squares line rate = a*sx + b.
    const n = pts.length;
    const sx̄ = pts.reduce((a, p) => a + p.sx, 0) / n;
    const rȳ = pts.reduce((a, p) => a + p.rate, 0) / n;
    const num = pts.reduce((a, p) => a + (p.sx - sx̄) * (p.rate - rȳ), 0);
    const den = pts.reduce((a, p) => a + (p.sx - sx̄) ** 2, 0);
    const a = den ? num / den : 0;
    const b = rȳ - a * sx̄;
    // Proportional would mean b === 0; report how far off that is.
    model = { a: +a.toExponential(3), b: +b.toFixed(4), atRef: +(a * 128 + b).toFixed(4) };
  }

  const ref = perSpeed[128] ?? perSpeed[SPEEDS[0]];
  profiles[fx] = {
    name: effects[fx], samples: ref.env[0].length, frames: ref.env.length,
    sx: 128, ix: 128, env: ref.env,
    selfColoured: selfColour > 0.25, meanSaturation: +selfColour.toFixed(3),
    speedModel: model,
    measured: Object.fromEntries(SPEEDS.filter((s) => perSpeed[s]).map((s) => [s, {
      period: perSpeed[s].period, drift: perSpeed[s].drift,
      driftConfidence: perSpeed[s].driftConfidence, churn: perSpeed[s].churn, static: perSpeed[s].static,
    }])),
    // Keep every speed's raw envelope so the maths can be reworked offline
    // without driving the lights again.
    raw: Object.fromEntries(SPEEDS.filter((s) => perSpeed[s]).map((s) => [s, perSpeed[s].env])),
  };

  const p = profiles[fx];
  report.push(p);
  console.log(
    `fx ${String(fx).padEnd(4)} ${p.name.padEnd(20)} sat=${String(p.meanSaturation).padEnd(6)}` +
    `${p.selfColoured ? 'SELF-COLOUR ' : 'honours ours'}  ` +
    `churn=${SPEEDS.map((s) => perSpeed[s]?.churn ?? '-').join('/')}  ` +
    `drift=${SPEEDS.map((s) => perSpeed[s] ? `${perSpeed[s].drift}@${perSpeed[s].driftConfidence ?? 0}` : '-').join(' ')}`
  );
}

await post({ on: before.on, bri: before.bri,
  seg: [{ id: 0, fx: before.seg[0].fx, pal: before.seg[0].pal, sx: before.seg[0].sx, ix: before.seg[0].ix, col: before.seg[0].col }] });
await writeFile(OUT, JSON.stringify(profiles), 'utf8');
console.log(`\nrestored ${info.name}; ${report.length} profile(s) -> ${OUT}`);
console.log(`self-coloured (should be blacklisted): ${report.filter((p) => p.selfColoured).map((p) => p.name).join(', ') || 'none'}`);
