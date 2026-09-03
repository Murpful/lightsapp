// Derives global presets ("scenes") from the preset names already stored on the
// controllers.
//
// The naming convention in use is "<song> <date>", and the same song+date pair
// is kept in sync across controllers even though the preset NUMBERS differ
// wildly (the 08/09/26 blood song is 105 on the cross, 237 on the drums and 71
// on the tubes). So song+date is the join key, and the preset number is the
// per-device payload.

const STOPWORDS = /\b(the|a|an|of|is|it|to|in|for|and|our|my|this|that)\b/g;

// Abbreviations observed in the existing preset lists. Matches derived through
// this table are deliberately NOT auto-imported -- ambiguous initialisms like
// "TIG" (This Is our God / Trust In God) and "WMS" are excluded for that
// reason. Anything expanded here lands in the review queue instead.
const ALIASES = {
  kok: 'king kings',
  bfi: 'believe',
  pya: 'praise you anywhere',
  stn: 'speak name',
  hotl: 'house lord',
  grat: 'gratitude',
  bb: 'battle belongs',
  isj: 'i speak jesus',
  btl: 'back life',
  lof: 'let faith',
  da: 'death arrested',
  lal: 'lion lamb',
  ag: 'amazing grace',
};

const pad = (n) => String(Number(n)).padStart(2, '0');

/** Pulls the service date out of a preset name, normalised to MM/DD[/YY]. */
export function extractDate(name) {
  const s = String(name);
  let m = s.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2,4})/);
  if (m) return `${pad(m[1])}/${pad(m[2])}/${m[3].slice(-2)}`;
  m = s.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (m) return `${pad(m[1])}/${pad(m[2])}`;
  return null;
}

/** Reduces a preset name to a comparable song key. */
export function normalize(name) {
  let t = String(name).toLowerCase();
  t = t.replace(/\d{1,2}\s*\/\s*\d{1,2}(\s*\/\s*\d{2,4})?/g, ' '); // dates
  t = t.replace(/'\d{2}/g, ' '); // '24
  t = t.replace(/^\s*(0a|aa|zzz|00\d?|0\d\d?|\d{3})\b/, ' '); // leading sort codes
  t = t.replace(/\bsong\s*\d+\b/g, ' ');
  t = t.replace(/[^a-z0-9 ]/g, ' ');
  t = t.replace(STOPWORDS, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

const slug = (s) => s.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * @param presetsByDevice {Record<deviceId, WledPresetsJson>}
 * @returns proposals sorted strongest-first
 */
export function buildScenes(presetsByDevice) {
  const rows = [];
  for (const [devId, presets] of Object.entries(presetsByDevice)) {
    for (const [pid, p] of Object.entries(presets || {})) {
      const presetId = Number(pid);
      if (!p || !p.n || !Number.isFinite(presetId) || presetId <= 0) continue;
      let song = normalize(p.n);
      let viaAlias = false;
      if (ALIASES[song]) {
        song = ALIASES[song];
        viaAlias = true;
      }
      if (song.length < 3) continue;
      rows.push({ devId, presetId, raw: p.n.trim(), song, date: extractDate(p.n), viaAlias });
    }
  }

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.song}|${r.date ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const proposals = [];
  for (const [key, members] of groups) {
    const byDevice = new Map();
    const conflicts = [];
    for (const m of members) {
      if (byDevice.has(m.devId)) conflicts.push(m);
      else byDevice.set(m.devId, m);
    }

    const entries = {};
    for (const [devId, m] of byDevice) entries[devId] = m.presetId;

    const deviceCount = byDevice.size;
    const viaAlias = members.some((m) => m.viaAlias);
    const [song, date] = key.split('|');

    // Longest raw name is reliably the most descriptive spelling in the group.
    const displayName = members
      .map((m) => m.raw)
      .sort((a, b) => b.length - a.length)[0];

    let confidence = 'low';
    if (deviceCount >= 3 && !conflicts.length && !viaAlias && date) confidence = 'high';
    else if (deviceCount >= 2 && !conflicts.length) confidence = 'medium';

    proposals.push({
      id: slug(key) || slug(displayName),
      name: displayName,
      song,
      date: date || null,
      entries,
      deviceCount,
      confidence,
      viaAlias,
      conflicts: conflicts.map((c) => ({ devId: c.devId, presetId: c.presetId, raw: c.raw })),
      variants: members.map((m) => ({ devId: m.devId, presetId: m.presetId, raw: m.raw })),
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  proposals.sort(
    (a, b) => rank[a.confidence] - rank[b.confidence] || b.deviceCount - a.deviceCount || a.name.localeCompare(b.name)
  );
  return proposals;
}
