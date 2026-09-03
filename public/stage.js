// Simulated stage: all six fixtures in their real physical arrangement.
//
// Geometry is built in PIXELS at draw time rather than in a normalised box.
// That matters because the rig is full of 45-degree runs, and an angle only
// looks like 45 degrees if its horizontal and vertical spans are equal in
// pixels -- normalised coordinates would skew every slope with the window.
//
// LED order follows wiring, so index -> position matches the flat array the
// controllers stream.

export const GROUP_OF = { tubeL: 'tubeR', trussR: 'tubeR', trussL: 'tubeR' };
export const groupLeader = (id) => GROUP_OF[id] ?? id;
export const groupMembers = (leader) =>
  [leader, ...Object.keys(GROUP_OF).filter((k) => GROUP_OF[k] === leader)];

/**
 * Cross proportions, matched to the real one: uniform limb thickness, and an
 * arm overhang equal to the tube square so the tubes sit in its pocket.
 *
 * Frozen deliberately. Stage geometry describes physical reality, not a user
 * preference, so it is not editable from the UI -- change it here and the
 * dependent fixtures re-derive.
 */
export const CROSS_GEO = Object.freeze({
  height: 0.70,   // fraction of canvas height
  aspect: 0.40,   // total width / total height
  limb: 0.11,     // limb thickness as a fraction of total width
  dropY: 0.21,    // run above the crossbar, fraction of height
  flip: false,    // reverse LED order along the outline
  bottom: false,  // light the bottom edge (the two runs meet at the top instead)
});

export const FIXTURES = [
  { id: 'trussL', label: 'Left Truss',  leds: 78,  kind: 'slopes', slopes: 6, side: 'left'  },
  // Two stacked tubes per side physically. Note the left controller carries 71
  // LEDs against the right's 142 -- see the README; one left tube may be undriven.
  { id: 'tubeL',  label: 'Tube Left',   leds: 71,  kind: 'slopes', slopes: 2, side: 'left'  },
  { id: 'drum',   label: 'Drums',       leds: 69,  kind: 'peak'                             },
  { id: 'cross',  label: 'Cross',       leds: 662, kind: 'cross'                            },
  { id: 'tubeR',  label: 'Tube Right',  leds: 142, kind: 'slopes', slopes: 2, side: 'right' },
  { id: 'trussR', label: 'Right Truss', leds: 78,  kind: 'slopes', slopes: 6, side: 'right' },
];

/**
 * Default stage arrangement, congregation's view, as fractions of canvas width.
 * Drums sit right of centre and immediately left of the cross; the cross is
 * right of centre with the tubes and trusses further out on both sides.
 */
/**
 * Fixtures are deliberately small against a mostly-empty frame -- a real stage
 * seen from the congregation is far more darkness than light, and matching that
 * is what makes the preview read as the room rather than as a diagram.
 */
export const LAYOUT = {
  // tubeR has no entry here: it is positioned from the cross's pocket, so it
  // travels with the cross automatically.
  trussL: 0.050, tubeL: 0.170, drum: 0.740, cross: 0.830, trussR: 0.955,

  // The two long tubes per side sit as parallel 45-degree runs offset
  // perpendicular to each other, so the PAIR fills a square.
  //
  // The square's size is fixed here; the CROSS is sized to suit it. Its arm
  // overhang works out at roughly this same value, so the square tucks into the
  // pocket where the arm's underside meets the trunk. If you resize the cross,
  // check `armOverhang` still lands near `tubeSquare * W`.
  tubeSquare: 0.062,     // square side, fraction of canvas width
  tubePocketInset: 0.10, // clearance from the inner corner, fraction of the side
  tubePocketDrop: 0.38,  // how far below the arm the square hangs, fraction of the side
  tubeFill: 0.66,        // run length as a fraction of the square's side

  trussRun: 0.125,        // truss slope length as a fraction of a tube run (~1/8)
  trussHeightVsTube: 2.0, // truss column is twice the tube square's height...
  // ...and shares its vertical centre, so the two read as one plane.

  // Drums: two separate bars, steeper than the tubes, not meeting at the apex.
  drumHalf: 0.042,  // half the total span, fraction of width
  drumRise: 0.105,  // height of the peak, fraction of height
  drumGapTop: 0.010, // opening between the two bars at the top, fraction of width
  drumLift: 0.045,  // how far the feet sit above the floor, fraction of height

  baseY: 0.66,      // where the tube/truss stacks bottom out, fraction of height
  floorY: 0.86,     // stage floor: the foot of the cross stands here
};

/* -------------------------------------------------------------- geometry */

/**
 * Latin cross outline with UNIFORM limb thickness -- trunk and both arms are
 * the same width, which is how the real one is built. Returned in pixels.
 *
 * `height` is the full height in px; `aspect` is total width / total height;
 * `limb` is limb thickness as a fraction of total width.
 */
export function crossPoints({ cx, cy, height, aspect, limb, dropY, flip, bottom }) {
  const H = height;
  const W = H * aspect;
  const t = W * limb;              // limb thickness, identical on every limb
  const x0 = cx - W / 2, y0 = cy - H / 2;
  const mx = cx;
  const l = mx - t / 2, r = mx + t / 2;
  const top = y0 + H * dropY;      // top edge of the crossbar
  const bot = top + t;             // uniform thickness makes this t, not a free value

  const p = [
    { x: l,      y: y0 + H }, { x: l,      y: bot },
    { x: x0,     y: bot },    { x: x0,     y: top },
    { x: l,      y: top },    { x: l,      y: y0 },
    { x: r,      y: y0 },     { x: r,      y: top },
    { x: x0 + W, y: top },    { x: x0 + W, y: bot },
    { x: r,      y: bot },    { x: r,      y: y0 + H },
  ];
  if (bottom) p.push({ x: l, y: y0 + H });
  return flip ? p.reverse() : p;
}

/** Spreads `n` points evenly along a polyline by arc length. */
export function ledPositions(pts, n) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    segs.push({ a: pts[i - 1], b: pts[i], len });
    total += len;
  }
  const out = new Float32Array(n * 2);
  let seg = 0, walked = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / Math.max(1, n - 1)) * total;
    while (seg < segs.length - 1 && walked + segs[seg].len < target) { walked += segs[seg].len; seg++; }
    const s = segs[seg];
    const t = s.len ? Math.min(1, (target - walked) / s.len) : 0;
    out[i * 2] = s.a.x + (s.b.x - s.a.x) * t;
    out[i * 2 + 1] = s.a.y + (s.b.y - s.a.y) * t;
  }
  return out;
}

/**
 * A stack of parallel 45-degree runs. The high end points toward stage centre,
 * so right-side fixtures fall away to the right and left-side ones to the left.
 * Runs are chained head-to-tail in LED order.
 */
function slopeStack({ cx, topY, run, count, gap, side }) {
  const out = [];
  const dir = side === 'right' ? 1 : -1; // which way the run descends
  for (let k = 0; k < count; k++) {
    const y = topY + k * gap;
    // Equal horizontal and vertical span == a true 45 degrees on screen.
    const xHigh = cx - (dir * run) / 2;
    const xLow = cx + (dir * run) / 2;
    out.push([{ x: xHigh, y }, { x: xLow, y: y + run }]);
  }
  return out;
}

/**
 * Parallel 45-degree runs offset along their perpendicular, so the group fills
 * a square. With two runs at fill 0.66 the pair spans the full square in both
 * axes while staying clearly separate — which is how the long tubes hang.
 */
function slopeSquare({ cx, bottomY, size, count, fill, side }) {
  const run = size * fill;
  const spread = size - run;
  const step = count > 1 ? spread / (count - 1) : 0;
  const left = cx - size / 2;
  const top = bottomY - size;
  const mirror = (pt) => ({ x: 2 * cx - pt.x, y: pt.y });

  const out = [];
  for (let i = 0; i < count; i++) {
    const o = i * step;
    const a = { x: left + o, y: top + spread - o };   // high end
    const b = { x: a.x + run, y: a.y + run };          // low end
    out.push(side === 'right' ? [a, b] : [mirror(a), mirror(b)]);
  }
  return out;
}

/**
 * Drums: two separate bars rising toward each other but stopping short, so the
 * apex stays open rather than meeting in a point.
 */
function drumBars({ cx, baseY, halfWidth, rise, gapTop }) {
  return [
    [{ x: cx - halfWidth, y: baseY }, { x: cx - gapTop / 2, y: baseY - rise }],
    [{ x: cx + gapTop / 2, y: baseY - rise }, { x: cx + halfWidth, y: baseY }],
  ];
}

/**
 * Builds pixel positions for every fixture.
 * Returns { devId: { leds: Float32Array(x,y pairs), bounds: {x,y,w,h} } }.
 */
export function buildLayout(W, H, crossGeo, layout = LAYOUT) {
  const out = {};
  const baseY = layout.baseY * H;

  // --- Cross first: everything on the right side is measured off it. ---
  const crossH = crossGeo.height * H;
  const crossW = crossH * crossGeo.aspect;
  const limbT = crossW * crossGeo.limb;            // one thickness for every limb
  const armOverhang = (crossW - limbT) / 2;        // how far an arm reaches past the trunk
  const crossCx = layout.cross * W;
  const crossCy = Math.max(crossH / 2 + H * 0.02, layout.floorY * H - crossH / 2);
  const barTop = crossCy - crossH / 2 + crossH * crossGeo.dropY;
  const barBot = barTop + limbT;                   // underside of the arms
  const trunkRight = crossCx + limbT / 2;          // side of the trunk

  // Tube size is fixed; the cross is proportioned so its pocket suits it.
  const tubeSize = layout.tubeSquare * W;
  const inset = tubeSize * layout.tubePocketInset;
  const tubeRun = tubeSize * layout.tubeFill;
  const trussRun = tubeRun * layout.trussRun;

  // Where each side's tube square bottoms out; the trusses centre on these.
  const tubeBottom = {
    tubeR: barBot + inset + tubeSize * layout.tubePocketDrop + tubeSize,
    tubeL: baseY,
  };
  const tubeCx = {
    tubeR: trunkRight + inset + tubeSize / 2,
    tubeL: layout.tubeL * W,
  };
  const tubeCentreY = {
    trussR: tubeBottom.tubeR - tubeSize / 2,
    trussL: tubeBottom.tubeL - tubeSize / 2,
  };

  for (const f of FIXTURES) {
    let polylines;

    if (f.kind === 'cross') {
      polylines = [crossPoints({
        cx: crossCx,
        cy: crossCy,
        height: crossH,
        aspect: crossGeo.aspect,
        limb: crossGeo.limb,
        dropY: crossGeo.dropY,
        flip: crossGeo.flip,
        bottom: crossGeo.bottom,
      })];
    } else if (f.kind === 'peak') {
      polylines = drumBars({
        // Just above the floor line the cross stands on.
        cx: layout.drum * W, baseY: (layout.floorY - layout.drumLift) * H,
        halfWidth: layout.drumHalf * W,
        rise: layout.drumRise * H,
        gapTop: layout.drumGapTop * W,
      });
    } else if (f.slopes === 6) {
      // Trusses stay a stacked column of short runs rather than a filled square.
      // Spacing is derived from the target height rather than set directly, so
      // the column stays locked to twice its own side's tube square and centred
      // on it however the cross is resized.
      const stackH = tubeSize * layout.trussHeightVsTube;
      const g = (stackH - trussRun) / (f.slopes - 1);
      polylines = slopeStack({
        cx: layout[f.id] * W,
        topY: tubeCentreY[f.id] - stackH / 2,
        run: trussRun, count: f.slopes, gap: g, side: f.side,
      });
    } else {
      polylines = slopeSquare({
        cx: tubeCx[f.id], bottomY: tubeBottom[f.id],
        size: tubeSize, count: f.slopes, fill: layout.tubeFill, side: f.side,
      });
    }

    // Chain the runs head-to-tail and distribute this fixture's LEDs across them.
    const perRun = Math.max(1, Math.floor(f.leds / polylines.length));
    const chunks = [];
    let used = 0;
    for (let i = 0; i < polylines.length; i++) {
      const n = i === polylines.length - 1 ? f.leds - used : perRun;
      chunks.push(ledPositions(polylines[i], n));
      used += n;
    }
    const leds = new Float32Array(f.leds * 2);
    let o = 0;
    for (const c of chunks) { leds.set(c, o); o += c.length; }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < leds.length; i += 2) {
      if (leds[i] < minX) minX = leds[i];
      if (leds[i] > maxX) maxX = leds[i];
      if (leds[i + 1] < minY) minY = leds[i + 1];
      if (leds[i + 1] > maxY) maxY = leds[i + 1];
    }
    // Draw at most this many dots per fixture; beyond it the screen cannot
    // resolve them and the cost is wasted.
    const MAX_DOTS = 200;
    const stride = Math.max(1, Math.ceil(f.leds / MAX_DOTS));

    out[f.id] = { leds, stride, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
  }
  return out;
}


/* -------------------------------------------------------------- simulator */

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const lerp = (a, b, t) => a + (b - a) * t;
const mixRgb = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function hsv(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const r = [v, q, p, p, t, v][i % 6], g = [t, v, v, q, p, p][i % 6], b = [p, p, t, v, v, q][i % 6];
  return [r * 255, g * 255, b * 255];
}

function paletteColor(p, cfg) {
  const [c0, c1, c2] = cfg.colors;
  const name = cfg.palLower;
  if (name.includes('color 1') || name === 'default') return c0;
  if (name.includes('colors 1&2')) return mixRgb(c0, c1, p);
  if (name.includes('color gradient')) return p < 0.5 ? mixRgb(c0, c1, p * 2) : mixRgb(c1, c2, (p - 0.5) * 2);
  // Guard the top of the range: at p === 1 a bare floor(p*3) indexes past the
  // end. `%` also binds tighter than `|`, so the obvious one-liner is wrong.
  if (name.includes('colors only')) return [c0, c1, c2][Math.min(2, Math.floor(p * 3))];
  if (name.includes('rainbow') || name.includes('party') || name.includes('spectrum')) return hsv(p, 1, 1);
  if (name.includes('ocean')) return hsv(0.5 + p * 0.15, 0.9, 1);
  if (name.includes('forest')) return hsv(0.28 + p * 0.12, 0.9, 1);
  if (name.includes('lava') || name.includes('fire') || name.includes('heat')) return hsv(p * 0.12, 1, 1);
  if (name.includes('sunset')) return hsv(0.02 + p * 0.12, 0.85, 1);
  if (name.includes('cloud')) return hsv(0.58, 0.35, 0.6 + p * 0.4);
  return mixRgb(c0, c1, p);
}

const hash = (i) => { const x = Math.sin(i * 127.1) * 43758.5453; return x - Math.floor(x); };

/* ------------------------------------------------- recorded effect profiles */

/**
 * Motion envelopes captured from the real controllers by tools/record-effects.mjs.
 *
 * Each is brightness over position and time, recorded with a white primary on
 * black so it carries no colour of its own. Replaying one reproduces exactly
 * what the fixture does; the colours come from the operator's choice, applied
 * on top. Effects without a recording still fall back to the name-keyword
 * approximation below, which is a guess and looks like one.
 */
let FX_MODELS = {};
export const setProfiles = (m) => { FX_MODELS = m ?? {}; };
export const modelFor = (fx) => FX_MODELS[fx] ?? null;

/**
 * WLED prefixes every sound-reactive effect's name with a music note, which is
 * the only marker that covers all of them: the 'audio' archetype is set during
 * recording, and audio effects are precisely the ones we never recorded (they
 * respond to the room, not to us), so it is present on almost none of them.
 * Names come from the controller, so this needs them injected.
 */
let FX_NAMES = [];
export const setEffectNames = (n) => { FX_NAMES = n ?? []; };
const AUDIO_MARK = /[♩♪♫♬♭♮♯]/;
export const isAudioReactive = (fx) =>
  AUDIO_MARK.test(FX_NAMES[fx] ?? '') || FX_MODELS[fx]?.archetype === 'audio';

/**
 * Converts the measured change-per-frame into a cycle rate.
 *
 * `rate` is RMS brightness change per frame at the ~40fps the controllers
 * stream at. Effects measured between 0.005 and 0.15 look, by eye, like
 * something between a slow drift and a couple of cycles a second, which puts
 * the constant here around 12.
 */
const RATE_TO_HZ = 12;


/**
 * Perceptual brightness curve for the preview.
 *
 * Scaling the preview linearly by the brightness setting was badly wrong: the
 * eye responds roughly to the 1/2.2 power, so a strip at 25% reads far brighter
 * in the room than 25% of full does on screen. Linear scaling crushed the
 * bottom of the range to near-black -- a quarter brightness looked like off.
 *
 * This is a display curve only. The value SENT to the controllers is always the
 * raw setting; nothing here changes what the lights actually do.
 */
const GAMMA = 2.2;
const perceived = (bri) => Math.pow(Math.max(0, Math.min(255, bri)) / 255, 1 / GAMMA);

/**
 * Generates the effect from its fitted equation.
 *
 * Each archetype is a closed form driven by parameters measured off the real
 * controller: how fast it changes with the speed slider, its spatial
 * wavelength, its mean level and how much of the strip is lit. That beats
 * replaying a recording -- it loops seamlessly, scales to any LED count,
 * responds continuously to speed, and is a handful of numbers instead of
 * kilobytes of frames.
 */
function simulateFromModel(tMs, cfg, n, out, model) {
  const sx = cfg.sx ?? 128;
  const ix = cfg.ix ?? 128;
  // rateScale and ampScale are calibrated by the fitter until the generated
  // animation reproduces the recording's own statistics. Without them the
  // model was consistently several times too slow and too dim.
  const hz = Math.max(0, (model.rate.a * sx + model.rate.b)) * RATE_TO_HZ * (model.rateScale ?? 1);
  const t = (tMs / 1000) * hz;
  const bri = perceived(cfg.bri);

  const base = Math.min(0.95, Math.max(0.05, model.duty || 0.5));
  const amp = Math.min(1, Math.min(base, 1 - base) * (model.ampScale ?? 1));
  const lam = Math.max(0.03, model.wavelength || 0.25);
  const dir = model.drift < 0 ? -1 : 1;
  // Intensity widens or narrows the moving feature.
  const dens = 0.15 + (ix / 255) * 0.7;

  for (let i = 0; i < n; i++) {
    const p = n > 1 ? i / (n - 1) : 0;
    let v;

    switch (model.archetype) {
      case 'static':
        v = base + amp;
        break;

      case 'gradient':
        // Fixed spatial ramp, no motion.
        v = base + amp * Math.cos(Math.PI * p);
        break;

      case 'pulse':
        // Whole strip rising and falling together.
        v = base + amp * Math.sin(2 * Math.PI * t);
        break;

      case 'sparkle': {
        // Each LED twinkles on its own fixed phase, so it shimmers rather than
        // flickering as one.
        const phase = hash(i) * 6.2832 + t * 6.2832;
        const s = 0.5 + 0.5 * Math.sin(phase);
        v = s > 1 - dens * 0.9 ? base + amp * 1.6 : base * 0.12;
        break;
      }

      case 'chase': {
        // A narrow band running along the strip with a soft tail.
        const width = 0.03 + dens * 0.22;
        let d = Math.abs(((p - dir * t) % 1 + 1) % 1);
        d = Math.min(d, 1 - d);
        v = base * 0.1 + (base + amp) * Math.exp(-(d * d) / (2 * width * width));
        break;
      }

      case 'noise': {
        // Two incommensurate waves make a smooth, non-repeating shimmer.
        const a = Math.sin(2 * Math.PI * (p / lam + t * 0.6));
        const b = Math.sin(2 * Math.PI * (p / (lam * 1.7) - t * 0.37));
        v = base + amp * 0.6 * (a * 0.6 + b * 0.4);
        break;
      }

      case 'wave':
      default:
        v = base + amp * Math.sin(2 * Math.PI * (p / lam - dir * t));
        break;
    }

    const col = paletteColor(p, cfg);
    const m = Math.max(0, Math.min(1, v)) * bri;
    out[i * 3] = clamp(col[0] * m);
    out[i * 3 + 1] = clamp(col[1] * m);
    out[i * 3 + 2] = clamp(col[2] * m);
  }
  return out;
}

/**
 * Approximates a WLED effect, chosen by name keyword. Writes into a caller-owned
 * buffer to avoid allocating megabytes per second at 60fps.
 */
export function simulate(tMs, cfg, n, out) {
  if (!out || out.length !== n * 3) out = new Uint8Array(n * 3);
  // Lowercase once per call, NOT per LED -- that was the hot path. It must not
  // be memoised on the config: the editor mutates fxName/palName in place, and
  // a cached copy would silently freeze the preview on the first effect chosen.
  const name = (cfg.fxName ?? '').toLowerCase();
  cfg.palLower = (cfg.palName ?? '').toLowerCase();

  // Prefer the fitted equation over the name-keyword guess whenever we have one.
  const model = FX_MODELS[cfg.fx];
  if (model && model.archetype !== 'audio') return simulateFromModel(tMs, cfg, n, out, model);
  if (model?.archetype === 'audio') { out.fill(0); return out; } // no honest preview
  const t = (tMs / 1000) * (0.15 + (cfg.sx / 255) * 2.2);
  const dens = cfg.ix / 255;
  const briScale = perceived(cfg.bri);

  const mode =
    name.includes('solid') && !name.includes('glitter') ? 0
    : name.includes('breath') || name.includes('fade') || name.includes('pulse') ? 1
    : name.includes('rainbow') || name.includes('colorloop') || name.includes('cycle') ? 2
    : name.includes('wipe') || name.includes('sweep') ? 3
    : name.includes('chase') || name.includes('running') || name.includes('scan') ||
      name.includes('comet') || name.includes('theater') || name.includes('sine') ||
      name.includes('dancing') || name.includes('shadow') ? 4
    : name.includes('twinkle') || name.includes('sparkle') || name.includes('glitter') ||
      name.includes('star') || name.includes('fireworks') ? 5
    : name.includes('noise') || name.includes('fire') || name.includes('lava') ||
      name.includes('plasma') || name.includes('aurora') ? 6
    : name.includes('blink') || name.includes('strobe') ? 7
    : 8;

  // Values constant across the whole strip, hoisted out of the per-LED loop.
  const breathe = 0.15 + 0.85 * (0.5 + 0.5 * Math.sin(t * 2));
  const head = mode === 3 ? (t * 0.25) % 1 : (t * 0.22) % 1;
  const width = 0.04 + dens * 0.25;
  const twinkleGate = 1 - (0.15 + dens * 0.6);
  const blink = Math.sin(t * 4) > 0 ? 1 : 0.03;

  for (let i = 0; i < n; i++) {
    const p = n > 1 ? i / (n - 1) : 0;
    let col, k = 1;
    switch (mode) {
      case 0: col = paletteColor(p, cfg); break;
      case 1: col = paletteColor(p, cfg); k = breathe; break;
      case 2: col = hsv(p * (0.2 + dens) + t * 0.15, 1, 1); break;
      case 3: col = paletteColor(p, cfg); k = p <= head ? 1 : 0.04; break;
      case 4: {
        let d = Math.abs(p - head); if (d > 0.5) d = 1 - d;
        col = paletteColor(p, cfg); k = Math.max(0.03, 1 - d / width); break;
      }
      case 5: col = paletteColor(p, cfg); k = Math.sin(hash(i) * 6.28 + t * 1.6) > twinkleGate ? 1 : 0.05; break;
      case 6: {
        const v = 0.5 + 0.5 * Math.sin(p * 9 + t * 1.1) * Math.sin(p * 4.3 - t * 0.7);
        col = paletteColor((p + t * 0.05) % 1, cfg); k = 0.2 + 0.8 * v; break;
      }
      case 7: col = paletteColor(p, cfg); k = blink; break;
      default: col = paletteColor((p + t * 0.08) % 1, cfg); k = 0.75 + 0.25 * Math.sin(t * 1.3 + p * 3);
    }
    const m = k * briScale;
    out[i * 3] = clamp(col[0] * m);
    out[i * 3 + 1] = clamp(col[1] * m);
    out[i * 3 + 2] = clamp(col[2] * m);
  }
  return out;
}

/* --------------------------------------------------------------- renderer */

export function makeRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let layout = {};
  let dpr = 1;
  let fps = 0, frames = 0, lastFps = 0;

  function resize() {
    // Capping the pixel ratio is the single biggest win on a large display: the
    // whole canvas is repainted every frame, so fill cost scales with the
    // SQUARE of this. At 1.0 a 2280-wide canvas is already ~2M pixels a frame;
    // 1.5 would be 4.5M for detail invisible on glowing dots.
    dpr = Math.min(window.devicePixelRatio || 1, 1);
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(r.width * dpr));
    canvas.height = Math.max(1, Math.floor(r.height * dpr));
  }

  const setGeometry = (crossGeo) => { layout = buildLayout(canvas.width, canvas.height, crossGeo); };

  function hitTest(cssX, cssY) {
    const x = cssX * dpr, y = cssY * dpr;
    let best = null, bestD = Infinity;
    for (const f of FIXTURES) {
      const b = layout[f.id]?.bounds;
      if (!b) continue;
      const pad = 22 * dpr;
      if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) {
        const d = Math.hypot(x - (b.x + b.w / 2), y - (b.y + b.h / 2));
        if (d < bestD) { bestD = d; best = f.id; }
      }
    }
    return best;
  }

  function draw(colorsByDev, { selected = null, now = 0 } = {}) {
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#07090e';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.lineWidth = dpr;
    const floorY = H * LAYOUT.floorY;
    ctx.beginPath(); ctx.moveTo(0, floorY); ctx.lineTo(W, floorY); ctx.stroke();

    // `selected` may be one fixture or several -- Auto highlights every fixture
    // it is about to roll, which by default is all of them.
    const chosen = Array.isArray(selected) ? selected : selected ? [selected] : [];
    const highlight = new Set(chosen.flatMap((id) => groupMembers(groupLeader(id))));

    for (const f of FIXTURES) {
      const geo = layout[f.id];
      const rgb = colorsByDev[f.id];
      if (!geo) continue;
      const b = geo.bounds;
      const sel = highlight.has(f.id);

      if (sel) {
        ctx.strokeStyle = 'rgba(76,141,255,.8)';
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.strokeRect(b.x - 12 * dpr, b.y - 12 * dpr, b.w + 24 * dpr, b.h + 24 * dpr);
        ctx.setLineDash([]);
      }
      ctx.fillStyle = sel ? 'rgba(200,220,255,.9)' : 'rgba(255,255,255,.26)';
      ctx.font = `${10 * dpr}px system-ui`;
      ctx.fillText(f.label, b.x, b.y - 16 * dpr);

      const pts = geo.leds;
      // Decimation: 662 dots on a shape a few hundred pixels tall is far more
      // than the screen can resolve, and live mode lights nearly all of them at
      // once. Drawing every Nth keeps the look identical and the cost bounded.
      const stride = geo.stride;
      const core = Math.max(1, 1.6 * dpr * (stride > 1 ? 1.35 : 1));
      const glow = core * 2.6;

      // Ghost pass: every drawn position shown faintly whether lit or not, so a
      // powered-off fixture still reads as being there. One constant fillStyle.
      const ghost = Math.max(0.7, core * 0.5);
      ctx.fillStyle = sel ? 'rgba(150,185,255,.20)' : 'rgba(255,255,255,.11)';
      for (let j = 0; j < pts.length; j += 2 * stride) {
        ctx.fillRect(pts[j] - ghost, pts[j + 1] - ghost, ghost * 2, ghost * 2);
      }

      if (!rgb) continue;

      // Flat fills only -- no shadowBlur (re-filters a sprite per dot) and no
      // arc() (path setup per dot). Both dominated the frame; squares at this
      // size are indistinguishable once the glow layer is over them.
      ctx.globalCompositeOperation = 'lighter';

      ctx.globalAlpha = 0.16;
      for (let i = 0, j = 0; j < pts.length; i += 3 * stride, j += 2 * stride) {
        if (rgb[i] + rgb[i + 1] + rgb[i + 2] < 12) continue;
        ctx.fillStyle = `rgb(${rgb[i]},${rgb[i + 1]},${rgb[i + 2]})`;
        ctx.fillRect(pts[j] - glow, pts[j + 1] - glow, glow * 2, glow * 2);
      }

      ctx.globalAlpha = 1;
      for (let i = 0, j = 0; j < pts.length; i += 3 * stride, j += 2 * stride) {
        if (rgb[i] + rgb[i + 1] + rgb[i + 2] < 12) continue;
        ctx.fillStyle = `rgb(${rgb[i]},${rgb[i + 1]},${rgb[i + 2]})`;
        ctx.fillRect(pts[j] - core, pts[j + 1] - core, core * 2, core * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    frames++;
    if (now - lastFps > 500) { fps = Math.round((frames * 1000) / (now - lastFps)); frames = 0; lastFps = now; }
    return fps;
  }

  return { resize, setGeometry, draw, hitTest, get fps() { return fps; } };
}
