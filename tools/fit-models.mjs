// Turns the recordings into EQUATIONS.
//
// Replaying a recording has real drawbacks: it is noisy, it is a fixed-length
// loop that does not join back on itself, it is tied to the one intensity it
// was captured at, and it costs ~4KB per effect per speed. A fitted model is a
// handful of numbers, animates smoothly forever, scales to any LED count, and
// interpolates speed properly.
//
// So the recording is used as EVIDENCE: measure what the effect does, classify
// it, fit the parameters, then generate it analytically.
//
// Offline: reads data/fx-profiles.json, writes data/fx-models.json.

import { readFile, writeFile } from 'node:fs/promises';

const IN = 'data/fx-profiles.json';
const OUT = 'data/fx-models.json';
const SPEEDS = [64, 128, 192];

const rms = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s / a.length); };
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

/** Descriptive statistics for one envelope: what the effect does, numerically. */
function stats(env) {
  const F = env.length, n = env[0].length;
  const flat = env.flat();

  // How much any given LED changes over time.
  let churn = 0;
  for (let f = 1; f < F; f++) churn += rms(env[f], env[f - 1]);
  churn /= Math.max(1, F - 1);

  // How much neighbouring LEDs differ: fine detail vs broad washes.
  let spatial = 0;
  for (const f of env) {
    let d = 0;
    for (let p = 1; p < n; p++) d += Math.abs(f[p] - f[p - 1]);
    spatial += d / (n - 1);
  }
  spatial /= F;

  // Does the WHOLE strip brighten and dim together? That is a pulse, not motion.
  const perFrame = env.map(mean);
  const uniformSwing = Math.max(...perFrame) - Math.min(...perFrame);

  // Spatial travel: best alignment shift between consecutive frames.
  let drift = 0, votes = 0;
  for (let f = 1; f < F; f++) {
    const errs = [];
    for (let s = -10; s <= 10; s++) {
      let e = 0;
      for (let p = 0; p < n; p++) { const d = env[f][(p + s + n) % n] - env[f - 1][p]; e += d * d; }
      errs.push({ s, e });
    }
    const lo = Math.min(...errs.map((x) => x.e)), hi = Math.max(...errs.map((x) => x.e));
    if (hi > 0 && (hi - lo) / hi > 0.15) { drift += errs.find((x) => x.e === lo).s; votes++; }
  }
  drift = votes ? drift / votes : 0;

  // Dominant spatial wavelength, by autocorrelation across the strip.
  const row = env[Math.floor(F / 2)];
  const m = mean(row), dev = row.map((v) => v - m);
  const energy = dev.reduce((a, v) => a + v * v, 0);
  let wavelength = 0;
  if (energy > 1e-6) {
    let best = 0.25;
    for (let lag = 2; lag < n / 2; lag++) {
      let s = 0;
      for (let i = 0; i + lag < dev.length; i++) s += dev[i] * dev[i + lag];
      const score = s / energy;
      if (score > best) { best = score; wavelength = lag / n; }
    }
  }

  return {
    churn: +churn.toFixed(4),
    spatial: +spatial.toFixed(4),
    uniformSwing: +uniformSwing.toFixed(4),
    drift: +drift.toFixed(3),
    wavelength: +wavelength.toFixed(3),
    lit: +(flat.filter((v) => v > 0.08).length / flat.length).toFixed(3),
    duty: +mean(flat).toFixed(3),
  };
}

/**
 * Picks the archetype that explains the measurements.
 * Ordered most-specific first; the thresholds come from the measured spread
 * across the effects actually in use, not from guesswork.
 */
function classify(s) {
  // Nothing changing at all.
  if (s.churn < 0.004 && s.uniformSwing < 0.02) {
    return s.spatial < 0.02 ? 'static' : 'gradient';
  }
  // The whole strip rising and falling together: change is almost entirely in
  // the average level, with little structure along the strip.
  if (s.uniformSwing > 3 * s.churn && s.spatial < 0.05) return 'pulse';
  // Sparse and finely detailed: individual LEDs winking rather than a shape
  // sliding past. Sparkle has high spatial detail relative to how much is lit.
  if (s.lit < 0.6 && s.spatial > 0.04 && Math.abs(s.drift) < 0.25) return 'sparkle';
  // Sparse but clearly travelling: a band running along the strip.
  if (s.lit < 0.7 && Math.abs(s.drift) >= 0.25) return 'chase';
  // Mostly lit and clearly travelling.
  if (Math.abs(s.drift) >= 0.15) return 'wave';
  // Mostly lit, always changing, but no coherent direction.
  if (s.lit > 0.85 && s.spatial < 0.08) return 'noise';
  return 'wave';
}

/** rate = a·sx + b, least squares over the measured speeds. */
function fitRate(points) {
  const pts = points.filter((p) => p.rate > 0);
  if (pts.length < 2) return { a: 0, b: pts.length ? pts[0].rate : 0, r2: 0 };
  const n = pts.length;
  const mx = mean(pts.map((p) => p.sx)), my = mean(pts.map((p) => p.rate));
  const num = pts.reduce((a, p) => a + (p.sx - mx) * (p.rate - my), 0);
  const den = pts.reduce((a, p) => a + (p.sx - mx) ** 2, 0);
  const a = den ? num / den : 0;
  const b = my - a * mx;
  const ssTot = pts.reduce((s, p) => s + (p.rate - my) ** 2, 0);
  const ssRes = pts.reduce((s, p) => s + (p.rate - (a * p.sx + b)) ** 2, 0);
  return { a: +a.toExponential(4), b: +b.toFixed(5), r2: ssTot ? +(1 - ssRes / ssTot).toFixed(3) : 0 };
}

// The renderer itself, so a fitted model can be checked against the recording
// it came from. Without this the fit is unfalsifiable -- it would produce
// numbers whether or not it resembles the real effect.
const stage = await import('../public/stage.js');

/**
 * Generates from the model and measures it the same way the recording was
 * measured. Close statistics mean the equation reproduces the effect.
 */
function validate(model, measured, samples = 48, frames = 40) {
  stage.setProfiles({ 0: model });
  const cfg = {
    fx: 0, fxName: model.name, pal: 3, palName: '* Colors 1&2',
    colors: [[255, 255, 255], [0, 0, 0], [0, 0, 0]], bri: 255, sx: 128, ix: 128,
  };
  const env = [];
  for (let f = 0; f < frames; f++) {
    const out = stage.simulate((f / 40) * 1000, cfg, samples, new Uint8Array(samples * 3));
    const row = [];
    for (let i = 0; i < samples; i++) {
      row.push(+((0.2126 * out[i * 3] + 0.7152 * out[i * 3 + 1] + 0.0722 * out[i * 3 + 2]) / 255).toFixed(3));
    }
    env.push(row);
  }
  const got = stats(env);
  const err = (a, b) => (Math.abs(a) + Math.abs(b) < 1e-6 ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 0.02));
  return {
    got,
    churnErr: +err(got.churn, measured.churn).toFixed(2),
    litErr: +err(got.lit, measured.lit).toFixed(2),
    dutyErr: +err(got.duty, measured.duty).toFixed(2),
  };
}

const profiles = JSON.parse(await readFile(IN, 'utf8'));
const models = {};

console.log('fx    name                 archetype   rate(sx)              r2     wavelen  lit   drift');
for (const [fx, p] of Object.entries(profiles)) {
  if (p.audioReactive) {
    models[fx] = { name: p.name, archetype: 'audio', note: p.note };
    console.log(`${String(fx).padEnd(5)} ${String(p.name).padEnd(20)} audio-reactive - no model, preview unavailable`);
    continue;
  }
  const raw = p.raw ?? {};
  const perSpeed = {};
  for (const sx of SPEEDS) if (raw[sx]?.length > 3) perSpeed[sx] = stats(raw[sx]);
  if (!Object.keys(perSpeed).length) continue;

  const ref = perSpeed[128] ?? Object.values(perSpeed)[0];
  const archetype = classify(ref);
  const rate = fitRate(Object.entries(perSpeed).map(([sx, s]) => ({ sx: +sx, rate: s.churn })));

  models[fx] = {
    name: p.name,
    archetype,
    rate,                                   // churn per frame as a function of sx
    wavelength: ref.wavelength || 0.25,
    lit: ref.lit,
    duty: ref.duty,
    drift: ref.drift,
    spatial: ref.spatial,
    selfColoured: Boolean(p.selfColoured),
    measured: perSpeed,
  };
  // Calibrate the two free gains until the generated animation reproduces the
  // recording's own statistics. Open-loop guessing left every model several
  // times too slow and too dim; this closes the loop against the evidence.
  models[fx].rateScale = 1;
  models[fx].ampScale = 1;
  for (let iter = 0; iter < 24; iter++) {
    const got = validate(models[fx], ref).got;
    const rNeed = got.churn > 1e-5 ? ref.churn / got.churn : 1;
    const aNeed = got.lit > 1e-5 ? ref.lit / got.lit : 1;
    // Damped so the two gains, which interact, settle instead of oscillating.
    models[fx].rateScale = Math.min(60, Math.max(0.05, models[fx].rateScale * Math.pow(rNeed, 0.5)));
    models[fx].ampScale = Math.min(6, Math.max(0.2, models[fx].ampScale * Math.pow(aNeed, 0.35)));
    if (Math.abs(rNeed - 1) < 0.05 && Math.abs(aNeed - 1) < 0.05) break;
  }
  models[fx].rateScale = +models[fx].rateScale.toFixed(3);
  models[fx].ampScale = +models[fx].ampScale.toFixed(3);

  const v = validate(models[fx], ref);
  models[fx].fitQuality = { churnErr: v.churnErr, litErr: v.litErr, dutyErr: v.dutyErr };
  const worst = Math.max(v.churnErr, v.litErr, v.dutyErr);
  console.log(
    `${String(fx).padEnd(5)} ${String(p.name).padEnd(20)} ${archetype.padEnd(9)} ` +
    `r2=${String(rate.r2).padEnd(6)} lit ${String(ref.lit).padEnd(5)}->${String(v.got.lit).padEnd(5)} ` +
    `churn ${String(ref.churn).padEnd(7)}->${String(v.got.churn).padEnd(7)} ` +
    `${worst <= 0.35 ? 'good' : worst <= 0.6 ? 'fair' : 'POOR'}`
  );
}

await writeFile(OUT, JSON.stringify(models, null, 1), 'utf8');
console.log(`\n${Object.keys(models).length} model(s) -> ${OUT}`);
const byType = {};
for (const m of Object.values(models)) byType[m.archetype] = (byType[m.archetype] ?? 0) + 1;
console.log('archetypes: ' + Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', '));
