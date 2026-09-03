// LightsApp front end.
//
// Safety rule that shapes the whole UI: a controller is only ever written to by
// an explicit, unambiguous action -- the NEXT/Back transport, a play button, or
// Blackout. Clicking or dragging a row never sends anything to the lights, so a
// stray click mid-service cannot change what the congregation sees.

import {
  FIXTURES, CROSS_GEO, groupLeader, groupMembers,
  simulate, makeRenderer, connectLive, setProfiles, setEffectNames, hasProfile, isAudioReactive, modelFor,
} from '/stage.js';

const S = {
  devices: [],
  scenes: [],
  queue: { items: [], position: -1 },
  presetIndex: {},
  previews: {},
  fxPalettes: {},      // fx -> palettes that effect can actually use
  status: [],
  sort: 'name',        // 'name' | 'date'
  filter: '',
  expanded: new Set(), // song folders currently showing their older versions
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

let toastTimer;
function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

/* --------------------------------------------------------------- previews */

const isBlack = (c) => !c || (c[0] === 0 && c[1] === 0 && c[2] === 0);
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** CSS background for a preset's colour set. */
function gradientOf(preset) {
  const cols = (preset?.col ?? []).filter((c) => Array.isArray(c) && !isBlack(c));
  if (!cols.length) return '#232733';
  if (cols.length === 1) return rgb(cols[0]);
  return `linear-gradient(90deg, ${cols.map(rgb).join(', ')})`;
}

const presetOf = (devId, presetId) => S.presetIndex[devId]?.find((p) => p.id === Number(presetId));

// Mirrors the server's FOLLOWS map: framing controllers that used to trail
// Tubes Right over UDP sync and are now driven explicitly.
const FOLLOWS = { tubeL: 'tubeR', trussR: 'tubeR', trussL: 'tubeR' };

const isMirror = (v) => Boolean(v) && typeof v === 'object' && Boolean(v.mirror);

/** Resolves an entry to the preset actually being rendered, following mirrors. */
function resolvePreset(devId, entries) {
  const v = entries?.[devId];
  if (v == null || v === 'off') return null;
  if (isMirror(v)) return presetOf(v.mirror, entries[v.mirror]);
  return presetOf(devId, v);
}

/** A captured frame is 48 real LED colours; CSS spaces the stops evenly. */
const frameToGradient = (frame) => `linear-gradient(90deg, ${frame.join(',')})`;

/**
 * One thin bar per controller the scene touches.
 *
 * If the scene has been captured from the live rig, the bar shows real recorded
 * output and is animated by the loop below. Otherwise it falls back to the
 * preset's stored colours, so a never-yet-played scene is still never blank.
 */
function swatchHtml(entries, sceneId) {
  const cap = sceneId ? S.previews[sceneId]?.devices : null;
  const bars = S.devices
    .filter((d) => entries?.[d.id] != null)
    .map((d) => {
      const frames = cap?.[d.id];
      const bg = frames?.length ? frameToGradient(frames[0]) : gradientOf(resolvePreset(d.id, entries));
      const live = frames?.length ? ` data-scene="${esc(sceneId)}" data-dev="${d.id}"` : '';
      return `<i${live} style="background:${bg}"></i>`;
    })
    .join('');
  return `<div class="swatch${cap ? ' live' : ''}">${bars}</div>`;
}

// Steps every captured swatch through its recorded frames (~8fps).
let frameTick = 0;
setInterval(() => {
  const bars = document.querySelectorAll('.swatch i[data-scene]');
  if (!bars.length) return;
  frameTick++;
  bars.forEach((el) => {
    const frames = S.previews[el.dataset.scene]?.devices?.[el.dataset.dev];
    if (frames?.length > 1) el.style.background = frameToGradient(frames[frameTick % frames.length]);
  });
}, 120);

/* ------------------------------------------------------------------ render */

function renderDevices() {
  $('devStrip').innerHTML = S.devices
    .map((d) => {
      const st = S.status.find((s) => s.id === d.id);
      return `<span class="chip${st?.online ? ' online' : ''}"><span class="dot"></span>${esc(d.name)}</span>`;
    })
    .join('');

  const online = S.status.filter((s) => s.online).length;
  $('onlineCount').textContent = S.status.length ? `${online}/${S.devices.length} online` : '—';

  $('deviceCards').innerHTML = S.devices
    .map((d) => {
      const st = S.status.find((s) => s.id === d.id);
      if (!st?.online) {
        return `<div class="dev"><div class="dev-top"><span class="dev-name">${esc(d.name)}</span>
          <span class="dev-offline">offline</span></div>
          <div class="dev-meta">${esc(d.mdns ?? d.host)}</div></div>`;
      }
      const p = presetOf(d.id, st.ps);
      const label = st.ps > 0 ? (p?.name ?? `preset ${st.ps}`) : 'live / unsaved';
      const grad = gradientOf({ col: st.colors });
      const pct = Math.round((st.bri / 255) * 100);
      return `<div class="dev">
        <div class="dev-top">
          <span class="dev-name">${esc(d.name)}</span>
          <span class="dev-meta">${st.on ? `${pct}%` : 'off'}</span>
        </div>
        <div class="dev-meta">${esc(label)}</div>
        <div class="dev-bar" style="background:${grad};opacity:${st.on ? 1 : 0.25}"></div>
      </div>`;
    })
    .join('');
}

const titleOf = (s) => s.title ?? s.name ?? '';

/**
 * The songs in play. Archived ones are deliberately absent -- including from
 * search, so looking for a name never turns up something you retired.
 */
function visibleScenes() {
  const live = S.scenes.filter((s) => !s.archived);
  const f = S.filter.trim().toLowerCase();
  if (!f) return live;
  return live.filter((s) => titleOf(s).toLowerCase().includes(f) || (s.song ?? '').includes(f));
}

const archivedScenes = () => S.scenes.filter((s) => s.archived);

// Key for the Archive's open/shut state. Prefixed so it can never collide with
// a real song title in the same set.
const ARCHIVE_KEY = '__archive__';

const prettyDate = (iso) => {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const actionSummary = (entries) => {
  const vals = Object.values(entries ?? {});
  const off = vals.filter((v) => v === 'off').length;
  const on = vals.length - off;
  return [on ? `${on} on` : '', off ? `${off} off` : ''].filter(Boolean).join(' · ');
};

/**
 * Groups versions under one folder per song, newest version first within each.
 * Folder order follows the sort toggle: alphabetical, or most recently created.
 */
function groupBySong(scenes) {
  const folders = new Map();
  for (const s of scenes) {
    const t = titleOf(s);
    if (!folders.has(t)) folders.set(t, []);
    folders.get(t).push(s);
  }
  for (const versions of folders.values()) {
    versions.sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
  }
  const list = [...folders.entries()];
  if (S.sort === 'date') {
    // Newest first, by the freshest version in each folder. Undated songs sink
    // to the bottom rather than jumbling in among dated ones.
    return list.sort((a, b) =>
      String(b[1][0].created ?? '').localeCompare(String(a[1][0].created ?? '')) ||
      a[0].localeCompare(b[0]));
  }
  return list.sort((a, b) => a[0].localeCompare(b[0]));
}

// "Edit" opens the simulated designer; "Map" is the lower-level per-controller
// preset assignment, which the designer cannot express (leave-alone, mirrors).
//
// @param withEdit  this row is one editable song, so it may be designed, copied
//                  and deleted. False for the utility scenes and for a folder
//                  head standing in for several versions.
// @param playable  this row resolves to exactly ONE set of settings, so it can
//                  be sent to the lights. A folder of several versions does not:
//                  firing it would silently pick one. Open it and choose.
//                  Pinning stays available either way -- pinning a whole song
//                  to the top is a perfectly sensible thing to want.
const rowButtons = (id, withEdit = true, pinned = false, playable = true) =>
  `<button class="mini pin${pinned ? ' on' : ''}" data-act="pin" data-scene="${esc(id)}"
           title="${pinned ? 'Unpin' : 'Pin to the top'}">${pinned ? '★' : '☆'}</button>
   ${withEdit ? `<button class="mini" data-act="edit" data-scene="${esc(id)}" title="Design this song on the stage">Edit</button>
                 <button class="mini" data-act="dup" data-scene="${esc(id)}" title="Start a new version dated today, leaving this one untouched">Duplicate</button>` : ''}
   ${playable ? `<button class="mini" data-act="queue" data-scene="${esc(id)}" title="Add to queue">+ Queue</button>
                 <button class="mini" data-act="fire" data-scene="${esc(id)}" title="Send to the lights now">&#9654;</button>` : ''}
   ${withEdit ? `<button class="mini danger" data-act="archive" data-scene="${esc(id)}"
                         title="Move to the Archive at the bottom — you can bring it back">Archive</button>` : ''}`;

/** Buttons for a row inside the Archive, where deletion is for real. */
const archiveRowButtons = (id) =>
  `<button class="mini" data-act="unarchive" data-scene="${esc(id)}"
           title="Put this back in the song list">Unarchive</button>
   <button class="mini danger" data-act="del" data-scene="${esc(id)}"
           title="Delete permanently — this cannot be undone">Delete forever</button>`;

function renderScenes() {
  const list = visibleScenes();
  const pinned = list.filter((s) => s.pinned);
  const folders = groupBySong(list.filter((s) => !s.pinned));
  $('sceneCount').textContent = `${folders.length} songs`;

  const pinnedHtml = pinned.length
    ? `<div class="group-label">Pinned</div>` +
      pinned
        .map(
          (s) => `<div class="item pinned-row" data-scene="${esc(s.id)}">
            ${swatchHtml(s.entries, s.id)}
            <div class="item-main">
              <div class="item-name">${esc(titleOf(s))}</div>
              <div class="item-sub">${actionSummary(s.entries)}</div>
            </div>
            ${rowButtons(s.id, s.source !== 'utility', true)}
          </div>`
        )
        .join('')
    : '';

  // Folder actions target the NEWEST version -- the overwhelmingly common case.
  // Older versions live behind the chevron.
  const foldersHtml = folders.length
    ? `<div class="group-label">Songs</div>` +
      folders
        .map(([title, versions]) => {
          const newest = versions[0];
          const open = S.expanded.has(title);
          const sub = versions.length > 1
            ? `${versions.length} versions &middot; newest ${prettyDate(newest.created)} &middot; open to play one`
            : prettyDate(newest.created) || actionSummary(newest.entries);
          const versionRows = open
            ? `<div class="versions">${versions
                .map(
                  (v) => `<div class="item version" data-scene="${esc(v.id)}">
                    ${swatchHtml(v.entries, v.id)}
                    <div class="item-main">
                      <div class="item-name">${esc(prettyDate(v.created) || 'undated')}</div>
                      <div class="item-sub">${actionSummary(v.entries)}${S.previews[v.id] ? ' &middot; captured' : ''}</div>
                    </div>
                    ${rowButtons(v.id, true, Boolean(v.pinned))}
                  </div>`
                )
                .join('')}</div>`
            : '';
          return `<div class="folder-wrap">
            <div class="item folder" data-song="${esc(title)}">
              <button class="chev${open ? ' open' : ''}" data-act="toggle" title="Show versions">&#9656;</button>
              ${swatchHtml(newest.entries, newest.id)}
              <div class="item-main">
                <div class="item-name">${esc(title)}</div>
                <div class="item-sub">${sub}</div>
              </div>
              ${rowButtons(newest.id, versions.length === 1, Boolean(newest.pinned), versions.length === 1)}
            </div>
            ${versionRows}
          </div>`;
        })
        .join('')
    : '';

  /**
   * The Archive, always last and always shut until asked for.
   *
   * Hidden entirely while searching: a search is a question about the songs you
   * actually use, and retired ones should not answer it. It carries a box icon
   * rather than a colour swatch, so it never reads as another song.
   */
  const archived = archivedScenes();
  const archiveOpen = S.expanded.has(ARCHIVE_KEY);
  const archiveHtml = (archived.length && !S.filter.trim())
    ? `<div class="folder-wrap archive-wrap">
        <div class="item folder archive-head" data-song="${ARCHIVE_KEY}">
          <button class="chev${archiveOpen ? ' open' : ''}" data-act="toggle" title="Show archived songs">&#9656;</button>
          <span class="archive-icon" aria-hidden="true">&#128230;</span>
          <div class="item-main">
            <div class="item-name">Archive</div>
            <div class="item-sub">${archived.length} song${archived.length > 1 ? 's' : ''} &middot; kept out of the way</div>
          </div>
        </div>
        ${archiveOpen ? `<div class="versions">${archived
          .slice()
          .sort((a, b) => titleOf(a).localeCompare(titleOf(b)))
          .map((s) => `<div class="item version" data-scene="${esc(s.id)}">
            ${swatchHtml(s.entries, s.id)}
            <div class="item-main">
              <div class="item-name">${esc(titleOf(s))}</div>
              <div class="item-sub">${esc(prettyDate(s.created) || actionSummary(s.entries))}</div>
            </div>
            ${archiveRowButtons(s.id)}
          </div>`).join('')}</div>` : ''}
      </div>`
    : '';

  $('sceneList').innerHTML =
    pinnedHtml + foldersHtml + archiveHtml ||
    `<div class="empty">${S.scenes.length ? 'No match.' : 'No songs yet.'}</div>`;
}

function renderQueue() {
  const { items, position } = S.queue;
  const cur = items[position];
  const nxt = items[position + 1];
  const sceneOf = (it) => S.scenes.find((s) => s.id === it?.sceneId);
  const nameOf = (it) => (it && sceneOf(it) ? titleOf(sceneOf(it)) : '—');
  $('nowName').textContent = cur ? nameOf(cur) : '—';
  $('nextName').textContent = nxt ? nameOf(nxt) : '—';

  $('queueList').innerHTML = items.length
    ? items
        .map((it, i) => {
          const scene = S.scenes.find((s) => s.id === it.sceneId);
          const cls = i === position ? ' current' : i < position ? ' played' : '';
          return `<div class="item${cls}" draggable="true" data-idx="${i}">
            <span class="idx">${i + 1}</span>
            ${swatchHtml(scene?.entries ?? {}, scene?.id)}
            <div class="item-main">
              <div class="item-name">${esc(scene ? titleOf(scene) : '(missing scene)')}</div>
              <div class="item-sub">${scene && !scene.pinned ? esc(prettyDate(scene.created)) : ''}</div>
            </div>
            <button class="mini" data-act="jump" title="Send this now">&#9654;</button>
            <button class="mini" data-act="remove" title="Remove">&#10005;</button>
          </div>`;
        })
        .join('')
    : `<div class="empty">Add scenes from the library.</div>`;
}

const renderAll = () => { renderScenes(); renderQueue(); renderDevices(); };

/* ----------------------------------------------------------------- actions */

const saveQueue = () => api('/api/queue', { method: 'PUT', body: JSON.stringify(S.queue) });

function reportFire(res) {
  const bad = (res.results ?? []).filter((r) => !r.ok);
  if (bad.length) toast(`${res.scene?.name ?? 'Fired'} — ${bad.length} controller(s) failed`, true);
  else toast(`${res.scene?.name ?? 'Fired'} → ${res.results.length} controllers`);
}

async function transport(path, body) {
  try {
    const res = await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
    S.queue.position = res.position;
    renderQueue();
    if (res.reset) {
      const bad = (res.results ?? []).filter((r) => !r.ok);
      const where = res.atEnd ? 'End of queue'
        : res.restarted ? 'Back to the start'
        : 'Queue reset';
      toast(bad.length
        ? `${where} — ${bad.length} controller(s) failed to go dark`
        : `${where} — all lights off`, bad.length > 0);
    } else {
      reportFire(res);
    }
    refreshStatus();
  } catch (e) {
    toast(e.message, true);
  }
}

async function refreshStatus() {
  try {
    S.status = await api('/api/status');
    renderDevices();
  } catch { /* transient network blip; keep the last known state on screen */ }
}

/* ------------------------------------------------------- auto generator */

/**
 * Builds a whole song from a colour palette instead of dialling in each fixture.
 *
 * Choices are random but constrained, so the result is usable rather than merely
 * random: effects must honour our colours (a fixed palette like Forest would
 * ignore the whole point of choosing them), blacklisted entries are excluded,
 * and each fixture gets its own character -- cross calmer, drums punchier.
 */
const AUTO = {
  // Each entry is { rgb, role }. Role only shifts how often a colour is drawn.
  palette: [
    { rgb: [255, 60, 0], role: 'primary' },
    { rgb: [0, 90, 255], role: 'secondary' },
    { rgb: [255, 255, 255], role: 'accent' },
  ],
  tempo: 45,
  energy: 50,
  selected: 0,
  // Restrict to effects whose palette behaviour was measured on the rig. Off by
  // default: the unmeasured ones still work, they are just less predictable,
  // and excluding them costs most of the variety.
  measuredOnly: false,
  recent: [],   // effects used by the last few generations, to avoid repeats
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Relative draw weight per colour slot.
 *
 * WLED slot 1 is the most visible, slot 3 the least, so the weighting shifts
 * across them: slot 1 leans primary, slot 2 secondary, slot 3 accent. A colour
 * is never barred from a slot -- an accent can still land in slot 1
 * occasionally, which is what stops every generated song looking the same.
 */
const SLOT_WEIGHTS = [
  { primary: 6, secondary: 3, accent: 1 },
  { primary: 2, secondary: 5, accent: 2 },
  { primary: 1, secondary: 2, accent: 5 },
];

/** Weighted draw, optionally avoiding colours already used in this fixture. */
function weightedPick(slot, exclude = []) {
  const weights = SLOT_WEIGHTS[Math.min(slot, SLOT_WEIGHTS.length - 1)];
  const pool = AUTO.palette.filter((c) => !exclude.includes(c));
  const from = pool.length ? pool : AUTO.palette;
  const total = from.reduce((a, c) => a + (weights[c.role] ?? 1), 0);
  let r = Math.random() * total;
  for (const c of from) {
    r -= weights[c.role] ?? 1;
    if (r <= 0) return c;
  }
  return from[from.length - 1];
}

/** Palettes that render FROM the segment colours, so our palette is honoured. */
function colourHonouringPalettes() {
  const out = [];
  (S.meta.palettes ?? []).forEach((name, i) => {
    // The generator sticks to "*" palettes: they honour colours for EVERY
    // effect, whereas Default depends on which effect it is paired with.
    const n = String(name).toLowerCase();
    if (n.startsWith('*') && !n.includes('random') && !isBlacklisted('palettes', name)) out.push(i);
  });
  return out.length ? out : [2]; // "* Color 1" is the safe fallback
}

/**
 * The colour-honouring palettes THIS effect actually responds to.
 *
 * Not every effect reads all four: some take colour 1 only, so offering the
 * others would generate a look the hardware never renders. Falls back to the
 * full set for the effects we never measured.
 */
function autoPalettesFor(fx, honouring) {
  const usable = palettesForEffect(fx);
  if (!usable) return honouring;
  const both = honouring.filter((p) => usable.has(p));
  return both.length ? both : honouring;
}

/**
 * Effects worth generating with: not blacklisted, one-dimensional, and never
 * sound-reactive -- those follow the room's audio rather than the design, so a
 * generated look means nothing on them. `measuredOnly` narrows to effects whose
 * palette behaviour we confirmed on hardware.
 */
function candidateEffects() {
  const caps = S.meta.fxCaps ?? [];
  const keep = (c, i, measured) => {
    if (!c) return false;
    const n = String(c.name);
    if (isBlacklisted('effects', n)) return false;
    if (n.startsWith('2D')) return false; // these strips are one-dimensional
    if (isAudioReactive(i)) return false;
    return measured ? Boolean(palettesForEffect(i)) : true;
  };
  const out = [];
  caps.forEach((c, i) => { if (keep(c, i, AUTO.measuredOnly)) out.push(i); });
  if (out.length) return out;
  caps.forEach((c, i) => { if (keep(c, i, false)) out.push(i); });
  return out;
}

/**
 * Three colours for one fixture, drawn by role weight and kept distinct where
 * the palette is large enough to allow it.
 *
 * @param leadPrimary force slot 1 to a primary, so the most visible fixture
 *                    anchors the song rather than opening on an accent.
 */
function tripleFor(leadPrimary = false) {
  const used = [];
  const primaries = AUTO.palette.filter((c) => c.role === 'primary');
  for (let slot = 0; slot < 3; slot++) {
    const c = (slot === 0 && leadPrimary && primaries.length) ? pick(primaries) : weightedPick(slot, used);
    used.push(c);
  }
  return used.map((c) => c.rgb.slice(0, 3));
}

/**
 * Distinct roles, so the rig reads as one song rather than three copies.
 * The cross leads with a primary; it is the fixture the room looks at.
 */
const AUTO_ROLES = [
  { id: 'cross', sx: 0.75, ix: 0.85, bri: 0.75, lead: true },
  { id: 'drum',  sx: 1.15, ix: 1.15, bri: 1.00, lead: false },
  { id: 'tubeR', sx: 0.95, ix: 1.00, bri: 0.90, lead: false },
];

/** What the next Generate will roll: every fixture, or just the selected one. */
const autoTargets = () => (ST.autoAll
  ? AUTO_ROLES
  : AUTO_ROLES.filter((r) => r.id === groupLeader(ST.sel)));

/** Keeps the button honest about what it is about to change. */
function syncAutoTarget() {
  const targets = autoTargets();
  const one = !ST.autoAll && targets.length === 1;
  $('autoGenerate').textContent = one ? `Reroll ${fixtureOf(targets[0].id).label}` : 'Generate all';
  $('autoScope').textContent = one
    ? 'Rerolling one fixture — click the empty background to go back to all.'
    : 'Rolling every fixture. Click one to reroll just that.';
}

async function generateAuto() {
  if (!AUTO.palette.length) return toast('Add at least one colour first', true);
  const fx = candidateEffects();
  const pals = colourHonouringPalettes();
  const targets = autoTargets().length ? autoTargets() : AUTO_ROLES;

  const tempo = AUTO.tempo / 100;
  const energy = AUTO.energy / 100;
  const clamp255 = (v) => Math.max(4, Math.min(255, Math.round(v)));
  // +/-12% wobble, so pressing Generate twice on the same sliders gives two
  // different takes rather than the same numbers with different effects.
  const jitter = (spread = 0.12) => 1 + (Math.random() * 2 - 1) * spread;
  const sxFor = (bias) => clamp255((0.15 + tempo * 0.8) * 255 * bias * jitter());
  const ixFor = (bias) => clamp255((0.2 + energy * 0.75) * 255 * bias * jitter());

  // When rerolling a single fixture, the effects already on the others still
  // count as taken -- otherwise a reroll can land on what its neighbour is using.
  const usedNow = AUTO_ROLES
    .filter((r) => !targets.includes(r) && ST.designs[r.id]?.on !== false)
    .map((r) => ST.designs[r.id]?.fx)
    .filter((f) => typeof f === 'number');

  for (const role of targets) {
    // Avoid repeating an effect within this song, and avoid the ones the last
    // couple of generations already used -- otherwise pressing Generate keeps
    // landing on the same handful and the feature feels stuck.
    const fresh = fx.filter((i) => !usedNow.includes(i) && !AUTO.recent.includes(i));
    const unused = fx.filter((i) => !usedNow.includes(i));
    const f = pick(fresh.length ? fresh : unused.length ? unused : fx);
    usedNow.push(f);
    const pal = pick(autoPalettesFor(f, pals));
    ST.designs[role.id] = {
      on: true,
      fx: f, fxName: S.meta.effects[f] ?? '',
      pal, palName: S.meta.palettes[pal] ?? '',
      colors: tripleFor(role.lead),
      bri: clamp255(255 * role.bri * jitter(0.08)),
      sx: sxFor(role.sx),
      ix: ixFor(role.ix),
    };
  }
  // Remember this round so the next one steers away from it, but keep the
  // memory short: with a small pool a long one would starve the choice.
  AUTO.recent = [...usedNow, ...AUTO.recent].slice(0, Math.min(9, Math.floor(fx.length / 3)));

  syncStageInputs();
  renderStage(performance.now());

  // Send every fixture that was just rolled. The debounced pushLive only sends
  // the SELECTED group, so generating all three used to change one of them on
  // the actual rig and leave the other two on the previous song.
  if (isLive()) for (const role of targets) await pushGroup(role.id);

  // Always report the whole song, not just what changed, so a single reroll is
  // still read in the context of the other two fixtures.
  const mix = $('autoSummary').dataset.mix ?? '';
  const summary = AUTO_ROLES
    .map((r) => `${fixtureOf(r.id).label}: ${ST.designs[r.id]?.fxName ?? '—'}`)
    .join(' · ');
  $('autoSummary').textContent = `${summary}${mix ? `  —  weighted ${mix}` : ''}`;
  toast(targets.length === 1
    ? `Rerolled ${fixtureOf(targets[0].id).label}`
    : 'Generated — hit Generate again for another take');
}

const ROLE_TAG = { primary: 'P', secondary: 'S', accent: 'A' };

function renderAutoSwatches() {
  $('autoSwatches').innerHTML = AUTO.palette
    .map((c, i) => `<button class="pal-chip role-${c.role}${i === AUTO.selected ? ' active' : ''}"
                      data-i="${i}" title="${c.role}" style="background:${rgb2hex(c.rgb)}">
                      <span>${ROLE_TAG[c.role] ?? '?'}</span></button>`)
    .join('');
  const sel = AUTO.palette[AUTO.selected];
  document.querySelectorAll('.rolebtn').forEach((b) =>
    b.classList.toggle('active', sel && b.dataset.role === sel.role));
  $('vTempo').textContent = `${AUTO.tempo}%`;
  $('vEnergy').textContent = `${AUTO.energy}%`;

  // Say plainly how the mix is weighted, so the result is not a black box.
  const n = (r) => AUTO.palette.filter((c) => c.role === r).length;
  $('autoSummary').dataset.mix =
    `${n('primary')} primary · ${n('secondary')} secondary · ${n('accent')} accent`;
}

async function openAuto() {
  await openStage({ fresh: true });
  ST.autoMode = true;                 // routes the colour wheel to the palette
  ST.autoAll = true;                  // a new Auto song rolls the whole rig
  $('autoPanel').classList.remove('hidden');
  $('stTitle').textContent = 'Auto song';
  // openStage already ran the visibility pass with autoMode still false, which
  // left the colour block (and the wheel inside it) hidden. Re-run it now.
  syncStageInputs();
  renderAutoSwatches();
  syncAutoTarget();
  syncColorUi();
  renderStage(performance.now()); // repaint with every fixture highlighted
  $('stName').focus();
}

/* ---------------------------------------------------------------- hidden */

/**
 * Manual control over what the effect and palette menus offer.
 *
 * Two kinds of hiding exist and the list says which is which. Entries YOU hide
 * are a plain list and can be put back with one click. Entries hidden by rule --
 * WLED's empty "Reserved" slots, and palettes that ignore your colours entirely
 * -- are not worth offering under any circumstance, so they are shown greyed
 * with the reason rather than pretending they are yours to toggle.
 *
 * Nothing here rewrites a song. A song already using something hidden keeps it;
 * this only governs what is offered when picking something new.
 */
const BL = { kind: 'effects', filter: '', onlyHidden: false };

/** Why this entry is hidden by rule, or null when it is yours to decide. */
function autoHiddenReason(kind, name) {
  if (kind === 'effects' && isDeadSlot(name)) return 'empty WLED slot';
  if (kind === 'palettes' && S.blacklist?.paletteColourHonouringOnly && !honoursOurColours(name)) {
    return 'ignores your colours';
  }
  return null;
}

const manuallyHidden = (kind, name) =>
  (S.blacklist?.[kind] ?? []).some((b) => norm(b) === norm(name));

function renderHidden() {
  const kind = BL.kind;
  const names = (kind === 'effects' ? S.meta.effects : S.meta.palettes) ?? [];
  const needle = BL.filter.trim().toLowerCase();

  const rows = names
    .map((name, i) => ({ name: String(name), i }))
    .filter((r) => r.name && (!needle || r.name.toLowerCase().includes(needle)))
    .map((r) => ({ ...r, auto: autoHiddenReason(kind, r.name), mine: manuallyHidden(kind, r.name) }))
    .filter((r) => !BL.onlyHidden || r.mine || r.auto);

  // Yours first, so restoring something is never a hunt through 190 entries.
  rows.sort((a, b) => (Number(Boolean(b.mine)) - Number(Boolean(a.mine))) || a.name.localeCompare(b.name));

  $('blList').innerHTML = rows.length
    ? rows.map((r) => `
        <div class="bl-row${r.mine || r.auto ? ' off' : ''}">
          <span class="bl-name">${esc(r.name)}</span>
          ${r.auto
            ? `<span class="bl-why">${esc(r.auto)}</span>`
            : `<button class="mini${r.mine ? '' : ' danger'}" data-bl="${esc(r.name)}">
                 ${r.mine ? 'Unhide' : 'Hide'}</button>`}
        </div>`).join('')
    : `<div class="bl-empty">Nothing matches “${esc(BL.filter)}”.</div>`;

  const mine = (S.blacklist?.[kind] ?? []).length;
  const auto = names.filter((n) => autoHiddenReason(kind, n)).length;
  $('blSummary').textContent =
    `${mine} hidden by you · ${auto} hidden automatically · ${names.length} ${kind} in total`;
}

async function toggleHidden(name) {
  const kind = BL.kind;
  const list = (S.blacklist?.[kind] ?? []).slice();
  const at = list.findIndex((b) => norm(b) === norm(name));
  if (at >= 0) list.splice(at, 1);
  else list.push(name);

  const prev = S.blacklist[kind];
  S.blacklist[kind] = list;   // optimistic: the list redraws instantly
  renderHidden();
  try {
    await api('/api/blacklist', { method: 'POST', body: JSON.stringify({ [kind]: list }) });
    // Menus elsewhere are built from this, so rebuild whatever is on screen.
    if (ST.open) syncStageInputs();
    toast(at >= 0 ? `“${name}” is available again` : `“${name}” hidden`);
  } catch (e) {
    S.blacklist[kind] = prev;  // put it back; the save did not land
    renderHidden();
    toast(e.message, true);
  }
}

const closeHidden = () => $('hiddenPanel').classList.add('hidden');

$('btnHidden').addEventListener('click', () => {
  BL.filter = '';
  $('blFilter').value = '';
  $('hiddenPanel').classList.remove('hidden');
  renderHidden();
  $('blFilter').focus();
});
$('blClose').addEventListener('click', closeHidden);
$('hiddenPanel').addEventListener('click', (e) => { if (e.target.id === 'hiddenPanel') closeHidden(); });

$('hiddenPanel').querySelector('.bl-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-kind]');
  if (!tab) return;
  BL.kind = tab.dataset.kind;
  document.querySelectorAll('.bl-tab').forEach((t) => t.classList.toggle('active', t === tab));
  renderHidden();
});

$('blFilter').addEventListener('input', (e) => { BL.filter = e.target.value; renderHidden(); });
$('blOnlyHidden').addEventListener('change', (e) => { BL.onlyHidden = e.target.checked; renderHidden(); });
$('blList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bl]');
  if (btn) toggleHidden(btn.dataset.bl);
});

/* ------------------------------------------------------------------ update */

/**
 * Tells the operator when a newer version has been published, and installs it
 * on request.
 *
 * Never installs on its own. The lights run live services and whoever is at
 * the desk may not be technical, so a bad release arriving unattended is the
 * one failure nobody there could recover from. Checking is silent: a booth PC
 * is offline more often than not, and that is not an error worth showing.
 */
let UPDATE = null;

async function checkForUpdate({ silent = false } = {}) {
  const wasDismissed = UPDATE?.dismissed;
  try {
    UPDATE = await api('/api/update/status');
  } catch {
    return; // offline, or the server is mid-restart. Say nothing.
  }
  UPDATE.dismissed = wasDismissed;
  // The pill says BETA outright when experimental features are unlocked -- this
  // machine is not in its normal state and nobody should have to go looking.
  $('btnVersion').textContent = UPDATE.beta
    ? `v${UPDATE.current?.version ?? '?'} ⚡ BETA`
    : `v${UPDATE.current?.version ?? '?'}`;
  applyBetaMode();

  // The corner button carries the news even after the banner is dismissed, so
  // an update is never lost just because someone pressed Later.
  $('btnUpdates').classList.toggle('available', Boolean(UPDATE.updateAvailable));
  $('updatesDot').hidden = !UPDATE.updateAvailable;

  const bar = $('updateBar');
  // `silent` is for checks the operator asked for from the About panel, which
  // reports there instead of also throwing a banner over the page.
  if (silent || !UPDATE.updateAvailable || UPDATE.dismissed) return bar.classList.add('hidden');

  $('updateTitle').textContent = `Version ${UPDATE.remote.version} is available`;
  // The lights being on is the usual reason this cannot run, and saying so is
  // more use than a disabled button with no explanation.
  const blocked = !UPDATE.safeToApply;
  $('updateNotes').textContent = blocked
    ? 'The lights are on — blackout first, or update between services.'
    : (UPDATE.remote.notes ?? '');
  bar.classList.toggle('blocked', blocked);
  $('updateApply').disabled = blocked;
  bar.classList.remove('hidden');
}

/* ------------------------------------------------------------ about panel */

/**
 * Version, updates and beta mode, behind the version number in the header.
 *
 * Everything the operator can do about updates lives here rather than being
 * spread around: what is running, check now, install, undo, and the testing
 * switch. Out of the way, but never more than one click from the version they
 * would be asked for over the phone.
 */
function renderAbout() {
  if (!UPDATE) return;
  const cur = UPDATE.current ?? {};
  $('btnVersion').textContent = `v${cur.version ?? '?'}`;
  $('aboutVersion').textContent = UPDATE.beta ? `v${cur.version ?? '?'} ⚡ beta` : `v${cur.version ?? '?'}`;
  $('aboutNotes').textContent = cur.notes ?? '';

  const up = UPDATE.updateAvailable;
  $('aboutUpdateTitle').textContent = up ? `Version ${UPDATE.remote.version} is available` : 'Updates';
  $('aboutUpdateSub').textContent = !UPDATE.reachable
    ? 'Could not reach the internet, so there is nothing to check against.'
    : up
      ? (UPDATE.safeToApply ? (UPDATE.remote.notes ?? '') : 'The lights are on — blackout first.')
      : 'This is the latest version.';
  $('aboutUpdate').classList.toggle('hidden', !up);
  $('aboutUpdate').disabled = !UPDATE.safeToApply;

  $('aboutBeta').checked = Boolean(UPDATE.beta);

  // Name what beta actually unlocks, so it is an informed choice rather than a
  // switch with mysterious consequences.
  const beta = betaFeatures();
  const list = $('betaList');
  list.classList.remove('hidden');
  list.textContent = beta.length
    ? (UPDATE.beta
        ? `Unlocked: ${beta.map((f) => f.label).join(' · ')}`
        : `Waiting behind this switch: ${beta.map((f) => f.label).join(' · ')}`)
    : 'Nothing experimental is shipping right now — this stays quiet until an update brings something new.';

  const backups = UPDATE.backups ?? [];
  $('aboutRollbackRow').classList.toggle('hidden', !backups.length);
  if (backups.length) {
    $('aboutRollbackSub').textContent = `Puts version ${backups[0].version} back.`;
  }
}

const closeAbout = () => $('aboutPanel').classList.add('hidden');

async function openAbout() {
  $('aboutPanel').classList.remove('hidden');
  renderAbout();
  await checkForUpdate({ silent: true });  // refresh the moment it is opened
  renderAbout();
}

$('btnVersion').addEventListener('click', openAbout);
$('btnUpdates').addEventListener('click', openAbout);
$('aboutClose').addEventListener('click', closeAbout);
$('aboutPanel').addEventListener('click', (e) => { if (e.target.id === 'aboutPanel') closeAbout(); });

$('aboutCheck').addEventListener('click', async () => {
  const btn = $('aboutCheck');
  btn.disabled = true;
  $('aboutUpdateSub').textContent = 'Checking…';
  await checkForUpdate({ silent: true });
  renderAbout();
  btn.disabled = false;
});

$('aboutBeta').addEventListener('change', async (e) => {
  const on = e.target.checked;
  try {
    await api('/api/update/settings', { method: 'POST', body: JSON.stringify({ beta: on }) });
    if (UPDATE) UPDATE.beta = on;
    applyBetaMode();
    renderAbout();
    const n = betaFeatures().length;
    toast(on
      ? (n ? `⚡ Beta mode on — ${n} experimental feature${n > 1 ? 's' : ''} unlocked` : '⚡ Beta mode on — nothing experimental is shipping just yet')
      : 'Beta mode off — back to the tested features only');
  } catch (err) {
    e.target.checked = !on;
    toast(err.message, true);
  }
});

$('aboutUpdate').addEventListener('click', () => { closeAbout(); $('updateApply').click(); });

$('aboutRollback').addEventListener('click', async () => {
  if (!confirm('Put the previous version back?\n\nYour songs, queue and settings are not affected.')) return;
  const btn = $('aboutRollback');
  btn.disabled = true;
  $('aboutRollbackSub').textContent = 'Rolling back and restarting…';
  try {
    await api('/api/update/undo', { method: 'POST', body: '{}' });
    await waitForServer();
    location.reload();
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
  }
});

/**
 * Whether a feature should be active right now.
 *
 * Unknown keys default to ON, so a feature that has been promoted and had its
 * entry deleted from features.json keeps working rather than silently
 * disappearing on the next update.
 */
function featureOn(key) {
  const stage = UPDATE?.features?.features?.[key]?.stage;
  if (stage === 'beta') return Boolean(UPDATE?.beta);
  return true;
}

/** Everything currently shipping as experimental, newest ideas included. */
const betaFeatures = () =>
  Object.entries(UPDATE?.features?.features ?? {})
    .filter(([, f]) => f?.stage === 'beta')
    .map(([key, f]) => ({ key, label: f.label ?? key, desc: f.desc ?? '' }));

/**
 * Shows or hides anything still marked experimental.
 *
 * A feature ships to the booth dormant and only appears once beta mode is on,
 * so a new idea can be delivered and tried on the real rig without changing how
 * the lights are run day to day.
 */
function applyBetaMode() {
  const on = Boolean(UPDATE?.beta);
  const flags = UPDATE?.features?.features ?? {};
  document.body.classList.toggle('beta-mode', on);
  document.querySelectorAll('[data-feature]').forEach((el) => {
    const stage = flags[el.dataset.feature]?.stage ?? 'stable';
    el.classList.toggle('hidden', stage === 'beta' && !on);
  });

}

$('updateLater').addEventListener('click', () => {
  if (UPDATE) UPDATE.dismissed = true;   // until the page is opened again
  $('updateBar').classList.add('hidden');
});

$('updateApply').addEventListener('click', async () => {
  const bar = $('updateBar');
  const btn = $('updateApply');
  btn.disabled = true;
  bar.classList.add('busy');
  $('updateTitle').textContent = 'Updating…';
  $('updateNotes').textContent = 'Downloading and restarting. This takes a few seconds.';
  try {
    const r = await api('/api/update/apply', { method: 'POST', body: '{}' });
    $('updateTitle').textContent = `Installed ${r.version}`;
    $('updateNotes').textContent = 'Restarting…';
    await waitForServer();
    location.reload();
  } catch (e) {
    bar.classList.remove('busy');
    $('updateTitle').textContent = 'Update failed';
    $('updateNotes').textContent = `${e.message} — the previous version is still running.`;
    btn.disabled = false;
  }
});

/** Polls until the restarted server answers again, then gives up gracefully. */
async function waitForServer(timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      await fetch('/api/update/status', { cache: 'no-store' });
      return true;
    } catch { /* still down */ }
  }
  $('updateNotes').textContent = 'It is taking longer than expected — start it from the desktop icon.';
  return false;
}

/* --------------------------------------------------------- feature request */

const closeRequest = () => $('requestPanel').classList.add('hidden');

/**
 * Opens the request form.
 *
 * @param kind preselects what sort of request it is. Coming from Help, someone
 *             is reporting a problem rather than asking for a feature, and
 *             having to set that themselves is a step they should not need.
 */
function openRequest(kind = null) {
  if (kind) $('reqKind').value = kind;
  $('requestPanel').classList.remove('hidden');
  $('reqBody').focus();
}

$('btnRequest').addEventListener('click', () => openRequest());
$('reqClose').addEventListener('click', closeRequest);
$('requestPanel').addEventListener('click', (e) => { if (e.target.id === 'requestPanel') closeRequest(); });

/**
 * Files the request through the server.
 *
 * The operator needs no account and no login: the server holds the Discord
 * webhook and does the sending. It is written to disk here before any network
 * call, so a request is never lost to being offline.
 */
$('reqSend').addEventListener('click', async () => {
  const detail = $('reqBody').value.trim();
  if (!detail) return toast('Describe what you need first', true);

  const btn = $('reqSend');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const r = await api('/api/request', {
      method: 'POST',
      body: JSON.stringify({ kind: $('reqKind').value, detail }),
    });
    $('reqBody').value = '';
    closeRequest();
    toast(r.sent ? 'Sent — thank you' : (r.note ?? 'Saved on this machine'), !r.sent);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
  }
});

/* -------------------------------------------------------------------- help */

const closeHelp = () => $('helpPanel').classList.add('hidden');
$('btnHelp').addEventListener('click', () => $('helpPanel').classList.remove('hidden'));

// Reporting a problem is the same journey as any other request, so it reuses
// the one form rather than being a second thing that can drift out of step.
$('helpReport').addEventListener('click', () => {
  closeHelp();
  openRequest('Something is broken');
});
$('helpClose').addEventListener('click', closeHelp);
$('helpPanel').addEventListener('click', (e) => { if (e.target.id === 'helpPanel') closeHelp(); });

$('btnAutoSong').addEventListener('click', openAuto);
$('autoGenerate').addEventListener('click', generateAuto);
$('autoMeasuredOnly').addEventListener('change', (e) => {
  AUTO.measuredOnly = e.target.checked;
  AUTO.recent = []; // a different pool deserves a clean slate
});
$('autoTempo').addEventListener('input', (e) => { AUTO.tempo = Number(e.target.value); renderAutoSwatches(); });
$('autoEnergy').addEventListener('input', (e) => { AUTO.energy = Number(e.target.value); renderAutoSwatches(); });

// Selecting a palette chip loads it into the fixture wheel for editing.
$('autoSwatches').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-i]');
  if (!chip) return;
  AUTO.selected = Number(chip.dataset.i);
  renderAutoSwatches();
  // Re-find the chip: renderAutoSwatches replaced the element we were handed.
  const fresh = $('autoSwatches').querySelector(`[data-i="${AUTO.selected}"]`) ?? chip;
  openColorPop(fresh);
});

document.querySelectorAll('.rolebtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const sel = AUTO.palette[AUTO.selected];
    if (!sel) return;
    sel.role = btn.dataset.role;
    renderAutoSwatches();
  });
});

$('autoAddCol').addEventListener('click', () => {
  if (AUTO.palette.length >= 8) return toast('Eight colours is plenty', true);
  const c = design();
  // New colours start as accents: adding one should not quietly displace the
  // primary that is setting the song's overall tone.
  AUTO.palette.push({ rgb: (c?.colors?.[0] ?? [255, 255, 255]).slice(0, 3), role: 'accent' });
  AUTO.selected = AUTO.palette.length - 1;
  renderAutoSwatches();
});

$('autoDelCol').addEventListener('click', () => {
  if (AUTO.palette.length <= 1) return toast('Keep at least one colour', true);
  AUTO.palette.splice(AUTO.selected, 1);
  AUTO.selected = Math.max(0, AUTO.selected - 1);
  renderAutoSwatches();
});

/* ------------------------------------------------------------------ events */

$('search').addEventListener('input', (e) => { S.filter = e.target.value; renderScenes(); });

document.querySelectorAll('.sortbtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sortbtn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    S.sort = btn.dataset.sort;
    renderScenes();
  });
});

/* ------------------------------------------------------------------ events */

const toggleFolder = (title) => {
  if (S.expanded.has(title)) S.expanded.delete(title);
  else S.expanded.add(title);
  renderScenes();
};

$('sceneList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  const act = btn?.dataset.act;

  if (act === 'toggle') return toggleFolder(btn.closest('.folder').dataset.song);

  // A multi-version folder head carries no play or queue button, because it
  // stands for several different settings. Clicking it anywhere opens the list
  // rather than doing nothing at all.
  if (!act) {
    const folder = e.target.closest('.item.folder');
    if (folder?.dataset.song) return toggleFolder(folder.dataset.song);
  }

  const id = btn?.dataset.scene ?? e.target.closest('[data-scene]')?.dataset.scene;
  if (!id) return;

  if (act === 'pin') {
    const sc = S.scenes.find((s) => s.id === id);
    if (!sc) return;
    try {
      // Send the whole record back with pinned flipped; the server preserves
      // source, so a pinned utility scene stays a utility scene.
      await api('/api/scenes', { method: 'POST', body: JSON.stringify({ ...sc, pinned: !sc.pinned }) });
      await init(false);
      toast(sc.pinned ? `Unpinned "${titleOf(sc)}"` : `Pinned "${titleOf(sc)}"`);
    } catch (err) { toast(err.message, true); }
    return;
  }

  // Edit opens the simulated stage with the song loaded, not a mapping dialog.
  if (act === 'edit') return openStage({ sceneId: id });

  /**
   * Copies the song to a new version dated today and opens it for designing.
   *
   * Nothing is sent to the controllers, so this is safe mid-service: the copy
   * starts from the original's settings, ready to be renamed or saved as it is.
   */
  /**
   * Retires a song without destroying it.
   *
   * No confirm: nothing is lost and it is one click to undo from the Archive,
   * so a dialog here would only be noise. It does leave the queue, since a
   * retired song should not still be scheduled to play.
   */
  if (act === 'archive' || act === 'unarchive') {
    const sc = S.scenes.find((s) => s.id === id);
    if (!sc) return;
    const archiving = act === 'archive';
    btn.disabled = true;
    try {
      await api('/api/scenes/archive', {
        method: 'POST',
        body: JSON.stringify({ sceneId: id, archived: archiving }),
      });
      const wasQueued = archiving && S.queue.items.some((it) => it.sceneId === id);
      if (wasQueued) {
        S.queue.items = S.queue.items.filter((it) => it.sceneId !== id);
        await saveQueue();
      }
      if (archiving) S.expanded.delete(titleOf(sc)); // its folder is gone now
      await init(false);
      toast(archiving
        ? `Archived "${titleOf(sc)}"${wasQueued ? ' and removed it from the queue' : ''}`
        : `"${titleOf(sc)}" is back in the song list`);
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
    }
    return;
  }

  /**
   * Permanent deletion, reachable only from inside the Archive.
   *
   * Even here the presets stay on the controllers: this removes the app's entry,
   * not the lighting itself, and the confirm says so rather than implying the
   * look is gone from the hardware.
   */
  if (act === 'del') {
    const sc = S.scenes.find((s) => s.id === id);
    if (!sc) return;
    const when = sc.created ? ` (${prettyDate(sc.created)})` : '';
    if (!confirm(`Permanently delete "${titleOf(sc)}"${when}?\n\nThis cannot be undone.\n\nThe presets stay on the controllers; only this entry is removed.`)) return;
    btn.disabled = true;
    try {
      await api(`/api/scenes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      S.queue.items = S.queue.items.filter((it) => it.sceneId !== id);
      await saveQueue();
      await init(false);
      toast(`Deleted "${titleOf(sc)}" for good`);
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
    }
    return;
  }

  if (act === 'dup') {
    // Nothing is created yet. The designer opens loaded with this song's
    // settings but not bound to it, so Save writes a NEW version dated today
    // and backing out leaves no trace.
    await openStage({ sceneId: id, asCopy: true });
    toast('New version — rename it or just save. Nothing is saved until you do.');
    return;
  }
  if (act === 'fire') {
    try { reportFire(await api('/api/fire', { method: 'POST', body: JSON.stringify({ sceneId: id }) })); refreshStatus(); }
    catch (err) { toast(err.message, true); }
    return;
  }

  // Clicking a folder's body opens it rather than queueing, so the row that
  // represents several versions never silently queues one of them.
  const folder = e.target.closest('.folder');
  if (folder && act !== 'queue') return toggleFolder(folder.dataset.song);

  // Everything else only queues -- never fires.
  S.queue.items.push({ sceneId: id });
  await saveQueue();
  renderQueue();
  toast('Added to queue');
});

$('queueList').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-idx]');
  if (!row) return;
  const idx = Number(row.dataset.idx);
  const act = e.target.dataset.act;
  if (act === 'jump') return transport('/api/queue/jump', { index: idx });
  if (act === 'remove') {
    S.queue.items.splice(idx, 1);
    if (S.queue.position >= idx) S.queue.position -= 1;
    await saveQueue();
    renderQueue();
  }
});

// Drag to reorder.
let dragFrom = null;
$('queueList').addEventListener('dragstart', (e) => {
  const row = e.target.closest('[data-idx]');
  if (!row) return;
  dragFrom = Number(row.dataset.idx);
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});
$('queueList').addEventListener('dragover', (e) => {
  e.preventDefault();
  const row = e.target.closest('[data-idx]');
  document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  if (row) row.classList.add('drop-target');
});
$('queueList').addEventListener('drop', async (e) => {
  e.preventDefault();
  const row = e.target.closest('[data-idx]');
  if (!row || dragFrom === null) return;
  const to = Number(row.dataset.idx);
  const currentId = S.queue.items[S.queue.position]?.sceneId;
  const [moved] = S.queue.items.splice(dragFrom, 1);
  S.queue.items.splice(to, 0, moved);
  // Keep "NOW" pointing at the scene that is actually live after a reorder.
  if (currentId) S.queue.position = S.queue.items.findIndex((it) => it.sceneId === currentId);
  dragFrom = null;
  await saveQueue();
  renderQueue();
});
$('queueList').addEventListener('dragend', () => {
  document.querySelectorAll('.dragging, .drop-target').forEach((el) => el.classList.remove('dragging', 'drop-target'));
  dragFrom = null;
});

$('btnNext').addEventListener('click', () => transport('/api/queue/next'));
$('btnPrev').addEventListener('click', () => transport('/api/queue/prev'));

// Distinct from Clear: the running order is kept, we just go dark and rewind
// so the next NEXT fires item 1 again.
$('btnRestart').addEventListener('click', () => transport('/api/queue/reset'));

$('btnClear').addEventListener('click', async () => {
  S.queue = { items: [], position: -1 };
  await saveQueue();
  renderQueue();
});

$('btnBlackout').addEventListener('click', async () => {
  if (!confirm('Turn OFF all six controllers?')) return;
  try { await api('/api/blackout', { method: 'POST' }); toast('Blackout sent'); refreshStatus(); }
  catch (e) { toast(e.message, true); }
});

$('btnRefresh').addEventListener('click', async () => {
  toast('Re-reading presets...');
  try {
    const r = await api('/api/refresh', { method: 'POST' });
    await init(false);
    toast(`Refreshed ${r.refreshed}/${r.of} controllers`);
  } catch (e) { toast(e.message, true); }
});

const anyModalOpen = () =>
  !$('stage').classList.contains('hidden') ||
  !$('hiddenPanel').classList.contains('hidden') ||
  !$('requestPanel').classList.contains('hidden') ||
  !$('aboutPanel').classList.contains('hidden') ||
  !$('helpPanel').classList.contains('hidden');

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (colorPopOpen()) return closeColorPop();
    if (!$('aboutPanel').classList.contains('hidden')) return closeAbout();
    if (!$('requestPanel').classList.contains('hidden')) return closeRequest();
    if (!$('hiddenPanel').classList.contains('hidden')) return closeHidden();
    if (!$('helpPanel').classList.contains('hidden')) return closeHelp();
    if (ST.open) return closeStage();
  }
  // Never let a shortcut fire the lights while a dialog or a field has focus.
  if (anyModalOpen() || e.target.matches('input, textarea, select')) return;
  if (e.code === 'Space' || e.code === 'ArrowRight') { e.preventDefault(); transport('/api/queue/next'); }
  if (e.code === 'ArrowLeft') { e.preventDefault(); transport('/api/queue/prev'); }
});

/* ------------------------------------------------------------ stage view */

// A new song starts with the whole rig dark: you switch on only what the song
// actually uses, rather than having to remember to turn things off.
const blankCfg = () => ({
  on: false,
  fx: 0, fxName: 'Solid', pal: 0, palName: 'Default',
  colors: [[255,255,255],[255,0,0],[0,0,0]], bri: 160, sx: 128, ix: 128,
});

const ST = {
  open: false,
  sel: 'cross',        // selected fixture (a group leader)
  designs: {},         // devId -> cfg, for every fixture being designed
  liveOut: false,      // true = edits are pushed to the controllers as you work
  liveTouched: false,  // we have changed the real rig, so Back must put it back
  autoAll: true,       // Auto rolls every fixture until you pick just one
  renderer: null,
  raf: 0,
  bufs: {},            // devId -> reused Uint8Array, so we do not allocate per frame
  allowBlacklisted: false,
  editingId: null,     // scene being edited, or null when designing a new song
};

const hex2rgb = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
const rgb2hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2,'0')).join('')}`;

/* ------------------------------------------------------------ colour wheel */

/**
 * WLED-style hue/saturation wheel: angle is hue, distance from centre is
 * saturation, with value on a separate slider. Replaces the browser's native
 * colour input, which opens an OS dialog and is unusable at a lighting desk.
 */
let wheelSlot = 0; // which of the three colour slots the wheel is editing

function hsv2rgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const r = [v, q, p, p, t, v][i % 6], g = [t, v, v, q, p, p][i % 6], b = [p, p, t, v, v, q][i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function rgb2hsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, max ? d / max : 0, max];
}

function drawWheel(value) {
  const c = $('wheel');
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height, cx = w / 2, cy = h / 2, R = Math.min(cx, cy) - 3;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy), i = (y * w + x) * 4;
      if (d > R) { img.data[i + 3] = 0; continue; }
      const hue = ((Math.atan2(dy, dx) / (2 * Math.PI)) + 1) % 1;
      const [r, g, b] = hsv2rgb(hue, Math.min(1, d / R), value / 255);
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b;
      // Feather the rim so the circle does not look jagged.
      img.data[i + 3] = d > R - 1 ? 150 : 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Marker on the current colour. It must read from the SAME place the wheel
  // writes to -- reading the fixture's colour meant the marker never moved
  // while editing an Auto palette, because that is not what was changing.
  const col = colorTarget()?.get();
  if (!col) return;
  const [hh, ss] = rgb2hsv(col);
  const mx = cx + Math.cos(hh * 2 * Math.PI) * ss * R;
  const my = cy + Math.sin(hh * 2 * Math.PI) * ss * R;
  ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(mx, my, 7, 0, 6.2832); ctx.stroke();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(mx, my, 7, 0, 6.2832); ctx.stroke();
}

/**
 * Where the colour wheel writes.
 *
 * In the Auto panel it edits the palette entry you have selected; otherwise it
 * edits the selected fixture's colour slot. Without this the wheel silently
 * edited the fixture while you were trying to build a palette, so the chips
 * never changed.
 */
function colorTarget() {
  if (ST.autoMode && AUTO.palette[AUTO.selected]) {
    return {
      get: () => AUTO.palette[AUTO.selected].rgb,
      set: (rgb) => { AUTO.palette[AUTO.selected].rgb = rgb; renderAutoSwatches(); },
    };
  }
  const c = design();
  if (!c) return null;
  return { get: () => c.colors[wheelSlot], set: (rgb) => { c.colors[wheelSlot] = rgb; } };
}

/** Refreshes the slot chips, value slider and hex readout from the design. */
function syncColorUi() {
  const c = design();
  if (!c) return;

  // In Auto the wheel belongs to the palette, so show that colour instead.
  if (ST.autoMode && AUTO.palette[AUTO.selected]) {
    const rgb = AUTO.palette[AUTO.selected].rgb;
    const v = Math.round(rgb2hsv(rgb)[2] * 255);
    $('ctlVal').value = v;
    $('vVal').textContent = `${Math.round((v / 255) * 100)}%`;
    $('hexOut').textContent = rgb2hex(rgb);
    drawWheel(v);
    return;
  }
  [0, 1, 2].forEach((i) => {
    const btn = $(`rowCol${i}`);
    if (!btn) return;
    const col = c.colors[i] ?? [0, 0, 0];
    const hex = rgb2hex(col);
    btn.querySelector('i').style.background = hex;
    // The digit itself carries the colour. Very dark picks would vanish against
    // the panel, so lift the text toward legibility while keeping the hue.
    const [h, s, v] = rgb2hsv(col);
    btn.querySelector('span').style.color = v < 0.35 ? rgb2hex(hsv2rgb(h, s, 0.55)) : hex;
    btn.classList.toggle('active', i === wheelSlot);
  });
  const v = Math.round(rgb2hsv(c.colors[wheelSlot] ?? [0, 0, 0])[2] * 255);
  $('ctlVal').value = v;
  $('vVal').textContent = `${Math.round((v / 255) * 100)}%`;
  $('hexOut').textContent = rgb2hex(c.colors[wheelSlot] ?? [0, 0, 0]);
  drawWheel(v);
}

/**
 * Opens the wheel as a popover anchored to the swatch being edited.
 *
 * It used to sit inline, far below the swatches, so the thing you clicked and
 * the thing that changed it were nowhere near each other. Anchoring it keeps
 * the colour you are editing next to the tool editing it.
 */
function openColorPop(anchor) {
  const pop = $('colorPop');
  pop.classList.remove('hidden');
  syncColorUi();                       // draw before measuring, so it has a size

  const a = anchor.getBoundingClientRect();
  const p = pop.getBoundingClientRect();
  const pad = 8;
  // Prefer directly below the swatch; flip above if that would run off-screen.
  let top = a.bottom + pad;
  if (top + p.height > window.innerHeight - pad) top = Math.max(pad, a.top - p.height - pad);
  // Keep it on screen horizontally, centred on the swatch where possible.
  let left = a.left + a.width / 2 - p.width / 2;
  left = Math.max(pad, Math.min(left, window.innerWidth - p.width - pad));

  pop.style.top = `${Math.round(top)}px`;
  pop.style.left = `${Math.round(left)}px`;
}

const closeColorPop = () => $('colorPop').classList.add('hidden');
const colorPopOpen = () => !$('colorPop').classList.contains('hidden');

function pickFromWheel(clientX, clientY) {
  const c = $('wheel');
  const r = c.getBoundingClientRect();
  // A hidden canvas measures zero, and the maths below would divide by it and
  // produce NaN colours. Bail rather than write garbage into the palette.
  if (!r.width || !r.height) return;
  const cx = c.width / 2, cy = c.height / 2, R = Math.min(cx, cy) - 3;
  const x = ((clientX - r.left) / r.width) * c.width - cx;
  const y = ((clientY - r.top) / r.height) * c.height - cy;
  const d = Math.hypot(x, y);
  const hue = ((Math.atan2(y, x) / (2 * Math.PI)) + 1) % 1;
  const sat = Math.min(1, d / R);
  const v = Number($('ctlVal').value) / 255;
  const target = colorTarget();
  if (!target) return;
  target.set(hsv2rgb(hue, sat, v));
  syncColorUi();
  touched();
  if (!ST.autoMode) pushLive(); // a palette edit is not a fixture change
}
const fixtureOf = (id) => FIXTURES.find((f) => f.id === id);
const isLive = () => ST.liveOut;

// Stage geometry is fixed physical description, not something the editor can
// change -- see CROSS_GEO and LAYOUT in stage.js.
const stageGeometry = () => ST.renderer.setGeometry(CROSS_GEO);

/* ------------------------------------------------------------- blacklist */

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * A palette honours our colours only when it builds itself from the segment
 * colours -- the "*" ones, excluding Random Cycle. "Default" does NOT qualify:
 * it means the effect's own palette, which is a rainbow on palette-driven
 * effects.
 */
const honoursOurColours = (name) => {
  const n = String(name ?? '').trim().toLowerCase();
  if (n === 'default') return true; // effect-dependent, but correct for most
  return n.startsWith('*') && !n.includes('random');
};

/** Default renders this effect's own palette instead of your colours. */
const defaultUnsafeFor = (fxName) =>
  (S.blacklist?.defaultPaletteUnsafe ?? []).some((e) => norm(e) === norm(fxName));

/**
 * Being phased out: withheld from new picks, but never taken away from a design
 * already using it. Distinct from blacklisted, which means "never useful here".
 */
const isDeprecated = (kind, name) =>
  kind === 'palettes' && (S.blacklist?.deprecatedPalettes ?? []).some((d) => norm(d) === norm(name));

/**
 * Palettes the CURRENT effect can actually use, measured on hardware.
 *
 * Many effects ignore the palette entirely and read colour 1 only; offering
 * the rest would be a menu of choices that change nothing. Returns null when
 * the effect has not been measured, in which case everything stays on offer
 * rather than hiding something that might work.
 */
function palettesForEffect(fx) {
  const entry = S.fxPalettes?.[fx];
  if (!entry?.usable?.length) return null;
  return new Set(entry.usable.map(Number));
}

/**
 * Empty placeholders in WLED's effect list ("Reserved0", "Reserved for
 * Twister"). They occupy real effect IDs and can be selected, but render
 * nothing -- so they are never a valid choice for a song or for Auto.
 */
const isDeadSlot = (name) => /^reserved\b|^reserved\d*$|^reserved for /i.test(String(name ?? '').trim());

const isBlacklisted = (kind, name) => {
  if ((S.blacklist?.[kind] ?? []).some((b) => norm(b) === norm(name))) return true;
  // Rule-based: everything that cannot take our colours is hidden as well.
  if (kind === 'palettes' && S.blacklist?.paletteColourHonouringOnly) return !honoursOurColours(name);
  if (kind === 'effects' && isDeadSlot(name)) return true;
  return false;
};

/**
 * Builds the effect/palette options, dropping blacklisted entries unless the
 * override is on. The currently selected value is always kept, even when
 * blacklisted -- an existing preset may legitimately use one, and removing it
 * would silently reassign the design.
 *
 * @returns how many entries were hidden, so the override can stay out of the
 *          way on panels where nothing is filtered.
 */
function fillFilteredOptions(selectId, names, kind, current, allowedIdx = null) {
  let hidden = 0;
  const opts = [];
  names.forEach((name, i) => {
    const blocked = isBlacklisted(kind, name);
    const legacy = isDeprecated(kind, name);
    // Measured as doing nothing for this effect.
    const unsupported = allowedIdx !== null && !allowedIdx.has(i);
    if (unsupported && !ST.allowBlacklisted && i !== current) { hidden++; return; }
    // Both are withheld from new picks; the CURRENT value always survives so a
    // design is never silently reassigned to whatever sits at that index.
    if ((blocked || legacy) && !ST.allowBlacklisted && i !== current) { hidden++; return; }
    const mark = legacy ? ' (legacy)' : blocked ? ' •' : '';
    opts.push(`<option value="${i}"${i === current ? ' selected' : ''}>${esc(name)}${mark}</option>`);
  });
  $(selectId).innerHTML = opts.join('');
  $(selectId).value = current;
  return hidden;
}

/**
 * Effect simulation is OFF, and tabled indefinitely.
 *
 * Reproducing 190 WLED effects faithfully turned out to be a much bigger job
 * than it looked, and a preview that is confidently wrong is worse than no
 * preview -- you can always look at the actual lights. The stage therefore
 * shows only which fixtures are lit and roughly what colour, with no motion.
 *
 * The fitted models and the recording tools are all still here, so this is
 * paused rather than abandoned: flip this to false and the animation returns.
 */
const SIM_DISABLED = true;

/**
 * Colours for one fixture. ALWAYS the simulation.
 *
 * The preview deliberately does not read back from the controllers, even while
 * live. Tapping six live-view sockets cost ~240 messages a second and made the
 * page stutter, and it meant the picture changed the moment you went live --
 * two different renderings of the same design. One source keeps the preview
 * stable and cheap; the recorded effect profiles are what make it accurate.
 */
function colorsFor(devId, now) {
  const f = fixtureOf(devId);
  const need = f.leds * 3;
  let buf = ST.bufs[devId];
  if (!buf || buf.length !== need) buf = ST.bufs[devId] = new Uint8Array(need);

  // Framing followers render their leader's design -- one setting, four sets.
  const cfg = ST.designs[groupLeader(devId)] ?? blankCfg();
  if (cfg.on === false) { buf.fill(0); return buf; }

  if (SIM_DISABLED) {
    // Flat wash in the fixture's primary colour: enough to read "this one is
    // on, roughly this colour", without pretending to know the effect.
    const [r, g, b] = cfg.colors?.[0] ?? [255, 255, 255];
    const k = 0.55;
    for (let i = 0; i < f.leds; i++) {
      buf[i * 3] = Math.round(r * k);
      buf[i * 3 + 1] = Math.round(g * k);
      buf[i * 3 + 2] = Math.round(b * k);
    }
    return buf;
  }
  return simulate(now, cfg, f.leds, buf);
}

const stageColors = {};
let shownFps = -1;
function renderStage(now) {
  for (const f of FIXTURES) stageColors[f.id] = colorsFor(f.id, now);
  // Auto highlights everything it is about to roll; elsewhere, just the fixture
  // whose controls are on screen.
  const selected = ST.autoMode && ST.autoAll ? AUTO_ROLES.map((r) => r.id) : ST.sel;
  const fps = ST.renderer.draw(stageColors, { selected, now });
  // Only touch the DOM when the number actually changes, not every frame.
  if (fps !== shownFps) {
    shownFps = fps;
    const el = $('stFps');
    if (el) el.textContent = fps ? `${fps} fps` : '';
  }
}

/**
 * Preview frame rate. A lighting preview reads fine at 30fps, and the whole
 * canvas is repainted each frame, so halving the rate halves the dominant cost.
 * The live stream arrives at ~40fps, so at 30 we are still showing nearly every
 * frame the controllers produce.
 */
const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;
let lastDraw = 0;

function stageFrame(now) {
  if (!ST.open) return;
  // rAF still fires at display rate; we simply skip the expensive part.
  if (now - lastDraw >= FRAME_MS) {
    lastDraw = now;
    renderStage(now);
  }
  ST.raf = requestAnimationFrame(stageFrame);
}

// requestAnimationFrame is suspended while the tab is in the background, so the
// canvas would otherwise sit blank until the tab is focused again.
document.addEventListener('visibilitychange', () => {
  if (ST.open && !document.hidden) {
    cancelAnimationFrame(ST.raf);
    ST.raf = requestAnimationFrame(stageFrame);
  }
});

/**
 * Mirrors the controls onto the real controllers while live.
 * Every member of a framing group gets the same patch sent individually --
 * never via WLED sync.
 */
const patchFor = (c) => (c.on === false
  ? { on: false }
  : { on: true, bri: c.bri, seg: [{ id: 0, fx: c.fx, pal: c.pal, sx: c.sx, ix: c.ix, col: c.colors }] });

/** Sends one group's design to every controller in it, individually. */
async function pushGroup(leader) {
  const c = ST.designs[leader];
  if (!c) return;
  ST.liveTouched = true; // the rig no longer shows what we found; Back restores it
  const patch = patchFor(c);
  await Promise.all(
    groupMembers(leader).map((devId) =>
      api('/api/fixture/state', { method: 'POST', body: JSON.stringify({ devId, patch }) })
        .catch((e) => toast(`${devId}: ${e.message}`, true))
    )
  );
}

const pushLive = debounce(async () => {
  if (!isLive()) return;
  await pushGroup(groupLeader(ST.sel));
}, 180);

/**
 * Sends EVERY fixture's design, not just the selected one.
 *
 * Going live with only the selected group pushed left the other fixtures
 * showing whatever happened to be on them, so the stage was a mix of the design
 * and the previous song -- which looked like the preview had gone haywire.
 */
async function pushAllLive() {
  if (!isLive()) return;
  for (const leader of ['cross', 'drum', 'tubeR']) await pushGroup(leader);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/**
 * Which colour slots a palette actually consumes.
 * Returns null when the palette defers to the effect (WLED's "Default"), and an
 * explicit triple otherwise. Palettes not prefixed "*" are fixed gradients that
 * ignore the segment colours entirely.
 */
function paletteColorSlots(palName) {
  const n = String(palName ?? '').trim();
  if (!n || n === 'Default') return null;
  if (!n.startsWith('*')) return [false, false, false];
  const l = n.toLowerCase();
  if (l.includes('random')) return [false, false, false];
  if (l.includes('color 1')) return [true, false, false];
  if (l.includes('colors 1&2')) return [true, true, false];
  if (l.includes('gradient') || l.includes('colors only')) return [true, true, true];
  return null;
}

/**
 * Hides controls that would do nothing for the current effect and palette, so
 * the panel only ever offers settings that actually change the output.
 */
function applyControlVisibility(cfg) {
  const caps = S.meta.fxCaps?.[cfg.fx];
  const model = modelFor(cfg.fx);
  const measured = S.fxPalettes?.[cfg.fx];
  const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };

  // A dark fixture has no look to configure, so hide the lot.
  //
  // The Auto palette is the exception: it belongs to the song, not to any one
  // fixture, and a new Auto song starts with everything switched off -- which
  // hid the colour block, and the wheel inside it, exactly when it was needed.
  const powered = cfg.on !== false;
  for (const id of ['rowPreset', 'rowFx', 'rowPal', 'rowBri', 'rowSx', 'rowIx',
                    'rowCol0', 'rowCol1', 'rowCol2']) {
    show(id, powered);
  }
  show('rowColors', powered || ST.autoMode);
  if (ST.autoMode) {
    // The wheel edits the PALETTE here; the per-fixture slot tabs are meaningless.
    [0, 1, 2].forEach((i) => show(`rowCol${i}`, false));
    if (!powered) return;
  }
  if (!powered) return;

  // fxCaps is NOT trusted for palettes or colours. It declares Flow as using
  // neither, which hid the palette and all three colour pickers on the most-used
  // effect in the library. Measurement on the actual hardware governs instead;
  // caps is only a fallback where nothing has been measured.
  const usesPalette = measured ? measured.usable.length > 1 : true;
  show('rowPal', usesPalette);

  if (!ST.autoMode) {
    // Which colour slots matter follows from the PALETTE, which is reliable:
    // "* Color 1" consumes one, "* Colors 1&2" two, the gradients all three.
    const palSlots = paletteColorSlots(cfg.palName) ?? [true, true, true];
    palSlots.forEach((on, i) => show(`rowCol${i}`, on));
    show('rowColors', palSlots.some(Boolean));
  }

  // Sliders: trust caps only when it agrees with the measurement that the
  // effect actually moves.
  const movesInModel = Boolean(model && model.archetype !== 'static' && model.archetype !== 'gradient');
  show('rowSx', caps ? caps.speed || movesInModel : true);
  show('rowIx', caps ? caps.intensity || movesInModel : true);
}

function syncStageInputs() {
  const leader = groupLeader(ST.sel);
  const c = ST.designs[leader] ?? (ST.designs[leader] = blankCfg());
  const members = groupMembers(leader);
  if (ST.autoMode) syncAutoTarget(); // keep Generate's label on the real target

  $('selName').textContent = members.length > 1 ? 'Framing lights' : fixtureOf(leader).label;
  $('selSub').textContent = members.length > 1
    ? `${members.map((m) => fixtureOf(m).label).join(', ')} — one setting, sent to each`
    : `${fixtureOf(leader).leds} LEDs`;

  $('ctlOn').checked = c.on !== false;

  const allowedPal = palettesForEffect(c.fx);
  const hidden = fillFilteredOptions('ctlFx', S.meta.effects ?? [], 'effects', c.fx)
               + fillFilteredOptions('ctlPal', S.meta.palettes ?? [], 'palettes', c.pal, allowedPal);
  // The override only appears where something is actually being withheld.
  $('rowAllowBlacklisted').classList.toggle('hidden', hidden === 0 && !ST.allowBlacklisted);
  $('blCount').textContent = hidden ? `(${hidden} hidden)` : '';
  $('ctlAllowBlacklisted').checked = ST.allowBlacklisted;
  $('ctlBri').value = c.bri; $('vBri').textContent = Math.round((c.bri/255)*100) + '%';
  $('ctlSx').value = c.sx;   $('vSx').textContent = c.sx;
  $('ctlIx').value = c.ix;   $('vIx').textContent = c.ix;
  syncColorUi();

  // Existing presets for this fixture, to start a design from.
  const presets = (S.presetIndex[leader] ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  $('ctlPreset').innerHTML = `<option value="">— start from scratch —</option>` +
    presets.map((p) => `<option value="${p.id}">${esc(p.name)} (#${p.id})</option>`).join('');

  applyControlVisibility(c);

  // Be honest about preview fidelity: a recorded effect replays real captured
  // motion, everything else is a name-based approximation.
  const onLegacy = isDeprecated('palettes', c.palName);
  const defaultClash = norm(c.palName) === 'default' && defaultUnsafeFor(c.fxName);
  const audio = isAudioReactive(c.fx);
  // With simulation off there is nothing to say about motion fidelity, so the
  // note carries only the things that still affect the real output.
  $('stNote').textContent = c.on === false
    ? 'This fixture is off. Nothing else applies to it.'
    : audio
      ? `"${c.fxName}" follows live audio — it reacts to the room, so its look changes with the music.`
    : defaultClash
      ? `"${c.fxName}" ignores your colours on the Default palette — it draws its own. Pick a "*" palette to control the colour.`
      : onLegacy
        ? `Still on the legacy "${c.palName}" palette. It keeps working, but a "*" palette is unambiguous — switch when you next revise this song.`
        : '';
  $('stNote').classList.toggle('note-warn', defaultClash || onLegacy || audio);

  $('stInfo').textContent = leader === 'cross'
    ? '662 LEDs · from bottom-left, around the outline'
    : `${fixtureOf(leader).leds} LEDs · bottom to top`;
  $('stMode').textContent = isLive() ? 'LIVE — sending to controllers' : 'preview only — nothing is being sent';
  $('stMode').classList.toggle('is-live', isLive());
}

/**
 * Seeds a fixture's design from the preset a saved song assigns it, so opening
 * a song for editing shows that song rather than whatever is on the rig.
 */
function designFromScene(devId, scene) {
  const cfg = blankCfg();
  const entry = scene.entries?.[devId];

  // Mirrors carry no preset of their own; show the look they inherit.
  const source = isMirror(entry) ? entry.mirror : devId;
  const value = isMirror(entry) ? scene.entries?.[entry.mirror] : entry;

  if (value === 'off' || value == null) { cfg.on = false; return cfg; }

  const p = presetOf(source, value);
  if (!p) { cfg.on = false; return cfg; }

  cfg.on = true;
  cfg.fx = p.fx ?? 0;
  cfg.pal = p.pal ?? 0;
  cfg.bri = p.bri ?? 255;
  if (p.col?.length) cfg.colors = p.col.slice(0, 3).map((c) => c.slice(0, 3));
  while (cfg.colors.length < 3) cfg.colors.push([0, 0, 0]);
  cfg.fxName = S.meta.effects[cfg.fx] ?? '';
  cfg.palName = S.meta.palettes[cfg.pal] ?? '';
  return cfg;
}

/** Seeds a fixture's design from whatever it is showing on the rig now. */
function seedDesign(devId) {
  const cfg = blankCfg();
  const st = S.status.find((s) => s.id === devId);
  if (st?.online) {
    cfg.on = st.on !== false;
    cfg.fx = st.fx ?? 0;
    cfg.pal = st.pal ?? 0;
    cfg.bri = st.bri ?? 160;
    if (st.colors?.length) cfg.colors = st.colors.slice(0, 3).map((c) => c.slice(0, 3));
  }
  cfg.fxName = S.meta.effects[cfg.fx] ?? '';
  cfg.palName = S.meta.palettes[cfg.pal] ?? '';
  return cfg;
}

/**
 * @param fresh  - start a brand-new song: every fixture dark, so you switch on
 *                 only what the song uses instead of remembering to kill the rest.
 * @param asCopy - load this song's settings but do NOT bind to it. Saving then
 *                 creates a new version dated today and the original is left
 *                 alone -- and backing out creates nothing at all.
 */
async function openStage({ fresh = false, sceneId = null, asCopy = false } = {}) {
  ST.open = true;
  $('stage').classList.remove('hidden');
  // Remember the stage as we found it. Going live overwrites it, and Back is
  // expected to undo that rather than leave a half-built design in the room.
  ST.liveTouched = false;
  api('/api/rig/snapshot', { method: 'POST', body: '{}' })
    .catch(() => { /* no snapshot: Back will simply leave the lights as they are */ });
  // The generator panel is opt-in; openAuto re-shows it straight after.
  $('autoPanel').classList.add('hidden');
  ST.autoMode = false;
  const scene = sceneId ? S.scenes.find((s) => s.id === sceneId) : null;
  if (fresh || scene) ST.designs = {};
  // A copy is deliberately unbound: saving it must create, not overwrite.
  ST.editingId = scene && !asCopy ? scene.id : null;

  if (!ST.renderer) {
    ST.renderer = makeRenderer($('stCanvas'));
    // The effect and palette lists are rebuilt per selection by syncStageInputs,
    // since blacklisting can change what belongs in them.
    window.addEventListener('resize', () => { ST.renderer.resize(); renderStage(performance.now()); });
    $('stCanvas').addEventListener('click', (e) => {
      const r = $('stCanvas').getBoundingClientRect();
      const hit = ST.renderer.hitTest(e.clientX - r.left, e.clientY - r.top);
      if (!hit) {
        // Clicking the empty stage clears a narrowed Auto selection, so
        // Generate goes back to rolling the whole rig.
        if (!ST.autoMode || ST.autoAll) return;
        ST.autoAll = true;
      } else {
        ST.sel = groupLeader(hit);
        // Picking a fixture in Auto narrows the next roll to just that one.
        if (ST.autoMode) ST.autoAll = false;
      }
      syncStageInputs();
      renderStage(performance.now());
    });
  }

  // One design per independent fixture: cross, drums, and the framing leader.
  // Editing loads the song; a fresh song leaves them blank, i.e. powered off.
  for (const id of ['cross', 'drum', 'tubeR']) {
    if (ST.designs[id]) continue;
    ST.designs[id] = scene ? designFromScene(id, scene) : fresh ? blankCfg() : seedDesign(id);
  }
  ST.sel = 'cross';

  $('stName').value = scene ? titleOf(scene) : '';
  $('stTitle').textContent = asCopy ? 'New version' : scene ? 'Editing song' : 'Stage';
  $('stSave').textContent = asCopy ? 'Save new version' : scene ? 'Save changes' : 'Create song';

  // stNote is written per-selection by syncStageInputs, which knows whether the
  // chosen effect has a recording.

  ST.renderer.resize();
  stageGeometry();
  syncStageInputs();
  renderStage(performance.now()); // paint immediately; rAF may be throttled
  cancelAnimationFrame(ST.raf);
  ST.raf = requestAnimationFrame(stageFrame);
}

/**
 * Hands self-healing back to the server.
 *
 * A live push suspends reconciling for that controller so the sweep cannot
 * revert an edit mid-flow. Once we stop editing that protection should resume
 * straight away rather than waiting out the server's timeout.
 */
const releaseHold = () =>
  api('/api/fixture/release', { method: 'POST', body: '{}' }).catch(() => { /* it lapses on its own */ });

/**
 * Leaves the designer, putting the stage back if we changed it.
 *
 * Going live pushes the design onto the real rig, so backing out has to undo
 * that -- otherwise an abandoned edit stays in front of the room. Live output is
 * switched off first, so nothing re-pushes over the restore.
 */
async function closeStage() {
  const restore = ST.liveTouched;
  ST.open = false;
  ST.editingId = null;
  ST.liveOut = false;      // stop pushing before anything is sent back
  ST.liveTouched = false;
  cancelAnimationFrame(ST.raf);
  $('stLive').checked = false;
  $('stage').classList.add('hidden');

  if (!restore) return releaseHold();
  try {
    const r = await api('/api/rig/restore', { method: 'POST', body: '{}' });
    const failed = (r.restored ?? []).filter((x) => !x.ok);
    toast(failed.length
      ? `Back — but ${failed.map((f) => f.devId).join(', ')} did not take the restore`
      : 'Back — the lights are as you found them', Boolean(failed.length));
  } catch (e) {
    toast(`Could not restore the previous look: ${e.message}`, true);
  }
}

$('btnNewSong').addEventListener('click', async () => {
  await openStage({ fresh: true });
  $('stName').focus();
});
$('stClose').addEventListener('click', closeStage);

// Go live is output-only: edits are sent to the controllers, and the preview
// keeps rendering the simulation. It does not read anything back.
$('stLive').addEventListener('change', async (e) => {
  ST.liveOut = e.target.checked;
  if (ST.liveOut) {
    toast('Live — sending the whole design to the rig');
    await pushAllLive();
  } else {
    await releaseHold();
    toast('No longer sending — the lights keep their current look');
  }
  syncStageInputs();
});

$('ctlPreset').addEventListener('change', (e) => {
  const leader = groupLeader(ST.sel);
  const p = presetOf(leader, e.target.value);
  if (!p) return;
  const c = ST.designs[leader];
  c.fx = p.fx ?? 0; c.pal = p.pal ?? 0; c.bri = p.bri ?? 255;
  if (p.col?.length) c.colors = p.col.slice(0, 3).map((x) => x.slice(0, 3));
  while (c.colors.length < 3) c.colors.push([0, 0, 0]);
  c.fxName = S.meta.effects[c.fx] ?? '';
  c.palName = S.meta.palettes[c.pal] ?? '';
  syncStageInputs();
  renderStage(performance.now());
  pushLive();
});

const design = () => ST.designs[groupLeader(ST.sel)];

// Repaint immediately on every change rather than waiting for the next animation
// frame, so the preview tracks the controls even while a frame is in flight.
const touched = () => renderStage(performance.now());

$('ctlAllowBlacklisted').addEventListener('change', (e) => {
  ST.allowBlacklisted = e.target.checked;
  syncStageInputs();
});

$('ctlOn').addEventListener('change', (e) => {
  design().on = e.target.checked;
  syncStageInputs(); touched(); pushLive();
});

for (const [id, key] of [['ctlBri','bri'], ['ctlSx','sx'], ['ctlIx','ix']]) {
  $(id).addEventListener('input', (e) => {
    design()[key] = Number(e.target.value); syncStageInputs(); touched(); pushLive();
  });
}
// Clicking a fixture's colour slot opens the wheel on that slot.
for (const i of [0, 1, 2]) {
  $(`rowCol${i}`).addEventListener('click', (e) => {
    wheelSlot = i;
    syncColorUi();
    openColorPop(e.currentTarget);
  });
}
$('colorPopDone').addEventListener('click', closeColorPop);
// Clicking away closes it, but not when the click was inside the popover or on
// a swatch (which is re-opening it for a different colour).
document.addEventListener('pointerdown', (e) => {
  if (!colorPopOpen()) return;
  if (e.target.closest('#colorPop, .pal-chip, .slot')) return;
  closeColorPop();
});
let wheelDragging = false;
$('wheel').addEventListener('pointerdown', (e) => {
  wheelDragging = true; $('wheel').setPointerCapture(e.pointerId); pickFromWheel(e.clientX, e.clientY);
});
$('wheel').addEventListener('pointermove', (e) => { if (wheelDragging) pickFromWheel(e.clientX, e.clientY); });
$('wheel').addEventListener('pointerup', (e) => { wheelDragging = false; $('wheel').releasePointerCapture(e.pointerId); });
$('ctlVal').addEventListener('input', (e) => {
  // Rescale the current colour to the new value, preserving hue and saturation.
  const target = colorTarget();
  if (!target) return;
  const [h, s] = rgb2hsv(target.get() ?? [0, 0, 0]);
  target.set(hsv2rgb(h, s, Number(e.target.value) / 255));
  syncColorUi(); touched();
  if (!ST.autoMode) pushLive();
});
// These call applyControlVisibility rather than the full sync, which would
// rebuild the preset dropdown and lose the operator's place in it.
$('ctlFx').addEventListener('change', (e) => {
  const c = design();
  c.fx = Number(e.target.value);
  c.fxName = S.meta.effects[c.fx] ?? '';

  // Palettes are per-effect, so the list must be rebuilt. Without this the
  // dropdown kept the previous effect's options -- pick Solid (one palette),
  // then Flow, and Flow appeared to support only "* Color 1".
  const allowed = palettesForEffect(c.fx);
  if (allowed && !allowed.has(c.pal)) {
    // Current palette does nothing for this effect; move to one that does.
    const fallback = [2, 3, 4, 5].find((i) => allowed.has(i)) ?? [...allowed][0];
    c.pal = fallback;
    c.palName = S.meta.palettes[c.pal] ?? '';
  }
  fillFilteredOptions('ctlPal', S.meta.palettes ?? [], 'palettes', c.pal, allowed);

  applyControlVisibility(c);
  syncColorUi();
  touched();
  pushLive();
});
$('ctlPal').addEventListener('change', (e) => {
  const c = design();
  c.pal = Number(e.target.value); c.palName = S.meta.palettes[c.pal] ?? '';
  applyControlVisibility(c); touched(); pushLive();
});


/**
 * Creates the song: every fixture's design is applied to its controller and
 * saved there as a real preset, all at once. The resulting scene holds explicit
 * preset IDs for all six, so it never depends on preset names.
 */
$('stSave').addEventListener('click', async () => {
  const title = $('stName').value.trim();
  if (!title) return toast('Name the song first', true);

  // Each framing member gets its own preset carrying the leader's design.
  const designs = {};
  for (const f of FIXTURES) {
    const c = ST.designs[groupLeader(f.id)];
    if (!c) continue;
    // Powered-off fixtures still get a preset saved -- an explicit "off" is part
    // of the song, so firing it darkens them rather than leaving them as they were.
    designs[f.id] = { on: c.on !== false, bri: c.bri, fx: c.fx, pal: c.pal, sx: c.sx, ix: c.ix, col: c.colors };
  }

  const editing = ST.editingId;
  const url = editing ? '/api/songs/update' : '/api/songs/create';
  const body = editing ? { sceneId: editing, title, designs } : { title, designs };

  // Writing six presets takes a few seconds. Without visible progress this
  // looks dead, and a second click creates a second song.
  const btn = $('stSave');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = editing ? 'Saving…' : 'Creating…';
  toast(editing ? `Saving "${title}" to all controllers…` : `Writing "${title}" to all controllers…`);

  // Saving applies the design to the controllers on its way to writing presets,
  // so the rig no longer shows what we found and Back has to put it back.
  ST.liveTouched = true;

  try {
    const r = await api(url, { method: 'POST', body: JSON.stringify(body) });
    const failed = r.saved.filter((s) => !s.ok);

    // It is saved the moment the server answers, so say so NOW. Refreshing the
    // library below is bookkeeping worth none of the operator's attention, and
    // waiting for it is what made the button sit on "Saving…" long after the
    // work was actually finished.
    btn.disabled = false;
    btn.textContent = failed.length ? `Saved — ${failed.length} failed` : 'Saved';
    setTimeout(() => {
      // Only if the designer is still open on the same song; reopening it sets
      // its own label and this must not overwrite that.
      if (ST.open) btn.textContent = ST.editingId ? 'Save changes' : label;
    }, 1800);

    if (failed.length) toast(`"${title}" saved, but ${failed.length} controller(s) failed`, true);
    else if (editing) toast(`Updated "${title}"`);
    else toast(`Created "${title}" → ${r.saved.filter((s) => s.ok).map((s) => `${s.devId}#${s.slot}`).join(' ')}`);

    // A newly created song becomes the one being edited, so pressing Save again
    // updates it rather than quietly creating a second copy of it.
    if (!editing && r.scene?.id) ST.editingId = r.scene.id;

    await init(false);
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.textContent = label;
  }
});

/* -------------------------------------------------------------------- init */

async function init(withStatus = true) {
  const boot = await api('/api/bootstrap');
  Object.assign(S, boot);
  S.devices.sort((a, b) => a.order - b.order);
  setEffectNames(S.meta?.effects ?? []); // lets stage.js spot sound-reactive names
  try { S.previews = await api('/api/previews'); } catch { S.previews = {}; }
  try { setProfiles(await api('/api/fx-profiles')); } catch { setProfiles({}); }
  try { S.fxPalettes = await api('/api/fx-palettes'); } catch { S.fxPalettes = {}; }
  renderAll();
  if (withStatus) refreshStatus();
}

init()
  // Checked once on opening the page, never on a timer: the operator should
  // hear about an update when they sit down, not mid-service.
  .then(checkForUpdate)
  .catch((e) => toast(`Startup failed: ${e.message}`, true));
setInterval(refreshStatus, 3000);
