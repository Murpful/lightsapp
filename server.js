// LightsApp -- unified control surface for the sanctuary WLED controllers.
//
// Design notes:
//  * Zero npm dependencies. Everything here is Node built-ins so the app cannot
//    be broken by a failed install on the booth PC.
//  * The app addresses every controller explicitly instead of relying on WLED's
//    UDP group sync, which is unreliable and lets the truss controllers
//    broadcast over everything else.
//  * NOTHING is ever written to a controller except in response to an explicit
//    user action (fire / blackout / brightness). Startup and polling are
//    strictly read-only.

import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as wled from './lib/wled.js';
import * as store from './lib/store.js';
import { buildScenes, normalize, extractDate } from './lib/match.js';
import { captureScene } from './lib/capture.js';
import * as updater from './lib/update.js';

const PORT = Number(process.env.PORT || 8420);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(process.cwd(), 'public');

/**
 * Where updates come from.
 *
 * `main` is what the booth runs. `beta` exists for changes not yet fit to be
 * on that machine at all -- most work does not need it, because a feature can
 * ship on main marked "testing" and stay invisible until switched on.
 */
const REPO = { owner: 'Murpful', repo: 'lightsapp', branch: 'main' };

/** Where a feature request is sent, since the booth has no GitHub account. */
const MAINTAINER_EMAIL = 'murpful@gmail.com';

/**
 * Sends a request to a Discord channel.
 *
 * Chosen over a GitHub token because the credential is weaker in the right way:
 * a webhook URL can only post messages into the one channel it belongs to, and
 * is regenerated in two clicks if it ever leaks. It also needs no account at
 * this end, which matters -- whoever runs the lights next will not have one.
 *
 * The URL is a secret. It lives in data/ (gitignored), is never sent to the
 * browser, and is kept out of error messages.
 */
function postToDiscord(webhook, { kind, detail, version }) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(webhook);
    } catch {
      return reject(new Error('the webhook address is not a valid URL'));
    }
    if (!/(^|\.)discord(app)?\.com$/.test(url.hostname)) {
      return reject(new Error('that is not a Discord webhook address'));
    }

    const payload = JSON.stringify({
      username: 'LightsApp',
      embeds: [{
        title: kind,
        // Discord rejects an embed description over 4096 characters.
        description: detail.slice(0, 3800),
        color: 0x4c8dff,
        footer: { text: `LightsApp ${version} · from the booth` },
        timestamp: new Date().toISOString(),
      }],
    });

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'User-Agent': 'LightsApp',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 20000,
    }, (res) => {
      res.resume();
      res.on('end', () => {
        // 204 is the success case for a webhook; 200 if it was asked to wait.
        if (res.statusCode === 204 || res.statusCode === 200) return resolve(true);
        // Never echo the response: it can quote the URL back, secret and all.
        reject(new Error(`Discord replied ${res.statusCode}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', () => reject(new Error('could not reach Discord')));
    req.end(payload);
  });
}

/** Feature flags shipped with the code, not operator data, so read from root. */
const readFeatures = async () => {
  try {
    return JSON.parse(await readFile(path.join(process.cwd(), 'features.json'), 'utf8'));
  } catch {
    return { features: {} };
  }
};

// Only presets from this service year onward are carried into the library.
// Older ones stay on the controllers untouched -- they are simply not surfaced.
const MIN_YEAR = Number(process.env.MIN_YEAR || 26);

/** Entry value meaning "power this controller down" rather than "load preset N". */
const OFF = 'off';

/**
 * Which controller each framing light used to follow over UDP sync group 2.
 * These now get the same look pushed to them explicitly instead.
 */
const FOLLOWS = { tubeL: 'tubeR', trussR: 'tubeR', trussL: 'tubeR' };

const isMirrorEntry = (v) => Boolean(v) && typeof v === 'object' && Boolean(v.mirror);

/**
 * Always-available utility scenes. These carry no song or date, so the
 * recent-year filter would otherwise drop them; `pinned` exempts them and keeps
 * them at the top of the library where they can be grabbed mid-service.
 */
const UTILITY_SCENES = [
  {
    id: 'util-sermon',
    title: 'Sermon',
    created: null,
    entries: { cross: 184, drum: OFF, tubeR: OFF, tubeL: OFF, trussR: OFF, trussL: OFF },
    source: 'utility',
    pinned: true,
  },
  {
    id: 'util-all-off',
    title: 'All Off',
    created: null,
    entries: { cross: OFF, drum: OFF, tubeR: OFF, tubeL: OFF, trussR: OFF, trussL: OFF },
    source: 'utility',
    pinned: true,
  },
];

/**
 * True only for a full MM/DD/YY date at or after MIN_YEAR.
 *
 * Bare "M/D" names (e.g. "holy spirit 1/26" = January 26) carry no year and are
 * from earlier years, so they are excluded. Note the trap: the last two digits
 * of a bare M/D date look exactly like a year, so a naive suffix test would
 * wrongly keep them.
 */
function isRecentDate(date) {
  const m = /^\d{2}\/\d{2}\/(\d{2})$/.exec(date ?? '');
  return m ? Number(m[1]) >= MIN_YEAR : false;
}

const toIso = (date) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(date ?? '');
  return m ? `20${m[3]}-${m[1]}-${m[2]}` : null;
};

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Display title = the preset name with its trailing date stripped.
 *
 * New songs created here carry no date in their name at all -- the version is
 * identified by `created` instead. This only exists to fold the historic
 * "<song> <date>" names into the same folder as their newer siblings.
 */
const titleFromName = (name) =>
  String(name ?? '').replace(/\s*\d{1,2}\s*\/\s*\d{1,2}(\s*\/\s*\d{2,4})?\s*$/, '').trim() || String(name ?? '');

/** Brings older scene records up to the title/created shape and seeds utilities. */
function migrateScenes() {
  let changed = false;
  for (const s of state.scenes) {
    if (!s.title) { s.title = titleFromName(s.name); changed = true; }
    if (s.created === undefined) { s.created = toIso(s.date); changed = true; }
  }
  for (const u of UTILITY_SCENES) {
    if (!state.scenes.some((s) => s.id === u.id)) { state.scenes.push(structuredClone(u)); changed = true; }
  }
  return changed;
}

const DEFAULT_DEVICES = [
  { id: 'cross',  name: 'Cross',        host: '192.168.0.226', mdns: 'quinled.local',    leds: 662, role: 'cross',   backupName: 'QuinLED-cross',  order: 1 },
  { id: 'drum',   name: 'Drums',        host: '192.168.0.196', mdns: 'srwled9.local',    leds: 69,  role: 'drums',   backupName: 'Drum',           order: 2 },
  { id: 'tubeR',  name: 'Tubes Right',  host: '192.168.0.160', mdns: 'right-tube.local', leds: 142, role: 'framing', backupName: 'Ltubes-right',   order: 3 },
  { id: 'tubeL',  name: 'Tube Left',    host: '192.168.0.194', mdns: null,               leds: 71,  role: 'framing', backupName: 'Ltube-left-btm', order: 4 },
  { id: 'trussR', name: 'Right Truss',  host: '192.168.0.190', mdns: null,               leds: 78,  role: 'framing', backupName: 'Right-Truss',    order: 5 },
  { id: 'trussL', name: 'Left Truss',   host: '192.168.0.200', mdns: null,               leds: 78,  role: 'framing', backupName: 'Left-Truss',     order: 6 },
];

const state = {
  devices: [],
  presets: {},   // devId -> { presetId: presetObject }
  scenes: [],
  queue: { items: [], position: -1 },
  meta: { effects: [], fxCaps: [], palettes: [] },
  previews: {}, // sceneId -> { at, devices: { devId: frames[][] } }
  dismissed: [], // proposal ids deliberately hidden from the review queue
  blacklist: { effects: [], palettes: [] }, // hidden from the designer by default
  activeSceneId: null,                      // last scene fired, for reconciliation
  /**
   * Two separate failures, so two mechanisms.
   *
   * `periodic` catches CONTROLLER REBOOTS. Every controller here is set to
   * apply preset 180 at boot, and on Tubes Right that preset is bright green --
   * so a mid-service reboot puts a green fixture on stage with no command
   * involved. Only a timer can catch that, because nothing was fired.
   *
   * `verifyOnFire` catches a command that did not land, by re-checking shortly
   * after each fire and re-sending to whichever controller did not take it.
   *
   * Both re-send only the active scene's own values, and only to a controller
   * that demonstrably differs.
   */
  reconcile: {
    verifyOnFire: true, maxRetries: 2, verifyDelayMs: 1000,
    periodic: true, intervalSec: 20,
  },
  repairStreak: {},  // devId -> consecutive repairs, to stop a fight loop
  lastUptime: {},    // devId -> last seen uptime, for reboot detection
  editHold: {},      // devId -> timestamp until which reconciling is suspended
  rigSnapshot: null, // what was on stage when the designer opened, for backing out
};

/**
 * How long a live edit outranks the reconciler.
 *
 * Editing with "Go live" on deliberately puts a controller out of step with the
 * active scene, which is exactly what the reconciler exists to undo -- so
 * without this it reverts your work on its next sweep. The hold is refreshed by
 * every live push, and the designer drops it when you close or stop going live,
 * so this timeout only matters if the browser goes away mid-edit. Long enough to
 * pause and think, short enough that a forgotten tab cannot leave the rig
 * unprotected through a service.
 */
const EDIT_HOLD_MS = 3 * 60 * 1000;

/**
 * Stops defending whatever was on stage.
 *
 * Self-healing exists to keep a SONG up when a controller drops it. A dark
 * stage needs no defending: there is nothing to lose, and enforcing it would
 * fight whoever turns the lights back on -- including someone at a controller's
 * own web page. So going dark, by any route, ends protection.
 */
async function stopDefending(why) {
  if (!state.activeSceneId) return;
  state.activeSceneId = null;
  state.repairStreak = {};
  await store.save('active', { sceneId: null, at: new Date().toISOString(), why })
    .catch(() => { /* in-memory is what counts; the file is a convenience */ });
  console.log(`  self-heal idle: ${why}`);
}

/** A scene that darkens every controller is a blackout, whatever it is called. */
const isBlackoutScene = (scene) => {
  const entries = Object.values(scene?.entries ?? {});
  return entries.length > 0 && entries.every((e) => e === OFF);
};

const holdActive = (devId) => (state.editHold[devId] ?? 0) > Date.now();
const holdEdit = (devId) => { state.editHold[devId] = Date.now() + EDIT_HOLD_MS; };
/** Drop the hold for one device, or for all of them when called bare. */
const releaseHold = (devId) => {
  if (devId) delete state.editHold[devId];
  else state.editHold = {};
};

/**
 * Effects and palettes judged not useful in this room. Hidden from the pickers
 * unless the operator ticks the override, rather than removed -- an existing
 * preset may still use one, and the list is expected to grow with experience.
 */
const DEFAULT_BLACKLIST = {
  effects: ['Pacifica'],
  palettes: [],
  /**
   * Hide every palette that cannot take OUR colours.
   *
   * The "*" palettes always build from the segment colours. Fixed ones (Ocean,
   * Forest, Party, the rainbows) always impose their own.
   *
   * "Default" sits in between and IS allowed, because for most effects it is
   * correct: effects that read a palette get their own built-in one, but the
   * many effects that use the colour slots directly ignore the palette
   * entirely and render exactly what you picked. Measured with a white input:
   * Solid, Breathe, Chase, Twinklefox, Noisemove and Dancing Shadows all came
   * back at ~0.00 saturation under Default.
   *
   * "* Random Cycle" is excluded: it carries the "*" but honours nothing.
   */
  paletteColourHonouringOnly: true,

  /**
   * Effects measured to IGNORE your colours when the palette is Default --
   * they render their own built-in palette instead. Pairing one of these with
   * Default is worth warning about; every other palette choice is unaffected.
   * Saturation with a white primary, where 0 = pure grey:
   *   Flow 0.97, Pacifica 0.73, Dynamic Smooth 0.70, Noise 4 0.71
   */
  defaultPaletteUnsafe: ['Flow', 'Pacifica', 'Dynamic Smooth', 'Noise 4'],

  /**
   * Being phased out: not offered for new work, but never removed from
   * anything already using it.
   *
   * "Default" is ambiguous by nature -- whether it honours your colours depends
   * on the effect it is paired with, which is a trap worth designing out. The
   * "*" palettes are unambiguous for every effect. Existing presets keep
   * working untouched; a song already on Default still shows and fires it,
   * marked "legacy" in the picker.
   */
  deprecatedPalettes: ['Default'],
};

/* ---------------------------------------------------------------- bootstrap */

async function bootstrap() {
  await store.ensureDataDir();
  // A fresh clone has no data/ of its own. Seed it from the committed copies so
  // the app runs immediately, complete with the hardware measurements that took
  // hours of controller time. Existing files are never touched, so this is a
  // no-op on the machine that has been running all along.
  await store.seedMissing([
    'devices', 'blacklist', 'meta', 'fx-palettes', 'fx-models', 'fx-profiles',
  ]);

  state.devices = await store.load('devices', DEFAULT_DEVICES);
  state.scenes = await store.load('scenes', null) ?? [];
  state.queue = await store.load('queue', null) ?? { items: [], position: -1 };
  state.meta = await store.load('meta', null) ?? { effects: [], fxCaps: [], palettes: [] };
  state.presets = await store.load('presets.cache', null) ?? {};
  state.previews = await store.load('previews', null) ?? {};
  state.dismissed = await store.load('dismissed', null) ?? [];
  state.blacklist = await store.load('blacklist', null) ?? DEFAULT_BLACKLIST;
  if (!(await store.load('blacklist', null))) await store.save('blacklist', state.blacklist);
  state.reconcile = await store.load('reconcile', null) ?? state.reconcile;
  // activeSceneId is deliberately NOT restored here -- see startUnprotected.
  // data/active.json is written as a record of what was last fired, not as
  // something to resume defending.

  if (!(await store.load('devices', null))) await store.save('devices', state.devices);

  // Seed the preset cache from the newest on-disk backup so the app comes up
  // fully populated without touching a single controller.
  if (!Object.keys(state.presets).length) {
    const dir = await store.newestBackupDir();
    if (dir) {
      let loaded = 0;
      for (const dev of state.devices) {
        const p = await store.readBackupPresets(dir, dev.backupName);
        if (p) { state.presets[dev.id] = p; loaded++; }
      }
      if (loaded) {
        await store.save('presets.cache', state.presets);
        console.log(`  seeded presets for ${loaded} device(s) from ${path.basename(dir)}`);
      }
    }
  }

  if (!state.scenes.length && Object.keys(state.presets).length) {
    const n = rebuildLibrary();
    await store.save('scenes', state.scenes);
    console.log(`  auto-imported ${n.imported} scenes from ${n.recent} recent candidates`);
  }

  if (migrateScenes()) {
    await store.save('scenes', state.scenes);
    console.log('  migrated scene records / seeded utility scenes');
  }

  const orphans = prunePreviews();
  if (orphans) {
    await store.save('previews', state.previews);
    console.log(`  dropped ${orphans} preview(s) for songs that no longer exist`);
  }

  // fxCaps was added after the first releases; refetch if the cache predates it.
  if (!state.meta.effects.length || !state.meta.fxCaps?.length) await refreshMeta();
}

/** Effect/palette names are identical across these controllers; first reachable wins. */
async function refreshMeta() {
  for (const dev of state.devices) {
    try {
      const [parsed, palettes] = await Promise.all([wled.getEffects(dev.host), wled.getPalettes(dev.host)]);
      // Names drive the dropdown; caps drive which controls are worth showing.
      state.meta = { effects: parsed.map((e) => e.name), fxCaps: parsed, palettes };
      await store.save('meta', state.meta);
      return;
    } catch { /* try the next controller */ }
  }
  console.log('  warning: no controller reachable for effect/palette names');
}

/* ------------------------------------------------------------------ actions */

const deviceById = (id) => state.devices.find((d) => d.id === id);

/** Candidate scenes limited to recent service years. */
const recentProposals = () => buildScenes(state.presets).filter((p) => isRecentDate(p.date));

/**
 * Regenerates the auto-matched half of the library from the current preset
 * cache. Hand-made and hand-corrected scenes are preserved -- only entries that
 * came from the matcher are recomputed, so a manual fix is never clobbered by a
 * later refresh.
 */
function rebuildLibrary() {
  const proposals = recentProposals();
  // Utility and pinned scenes carry no date and must survive every rebuild.
  // "designed" songs were built in the stage editor with real preset IDs on
  // every controller; they must never be regenerated from names.
  const kept = state.scenes.filter(
    (s) => s.pinned || s.source === 'utility' || s.source === 'manual' || s.source === 'designed'
  );
  // Dedupe on song+date, not on id: a hand-made scene may carry a different id
  // slug than the matcher would generate for the very same song and service.
  const keyOf = (s) => `${s.song ?? ''}|${s.date ?? ''}`;
  const keptKeys = new Set(kept.map(keyOf));
  // Also dedupe on title. A materialised song deliberately has null song/date
  // so name matching cannot rewrite it -- which would otherwise leave it with
  // an empty key and let the matcher re-import it as a duplicate.
  const keptTitles = new Set(kept.map((s) => normalize(s.title ?? s.name ?? '')));
  const auto = proposals
    .filter((p) => p.confidence === 'high'
                && !keptKeys.has(keyOf(p))
                && !keptTitles.has(normalize(titleFromName(p.name))))
    .map((p) => ({
      id: p.id,
      name: p.name,
      title: titleFromName(p.name),
      created: toIso(p.date),
      song: p.song,
      date: p.date,
      entries: p.entries,
      source: 'auto',
    }));
  state.scenes = [...kept, ...auto].sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
  return { imported: state.scenes.length, recent: proposals.length, keptManual: kept.length };
}

/**
 * Records the scene's real output shortly after it is fired, so the library
 * self-populates with accurate previews as the rig gets used. Deliberately not
 * awaited -- the operator must never wait on a capture mid-service. The delay
 * lets the crossfade finish so we record the settled look, not the transition.
 */
let fireSeq = 0;

/**
 * Marks the rig as changed, abandoning any capture still in flight.
 * Called by every path that writes to a controller.
 */
const invalidateCaptures = () => { fireSeq++; };

/**
 * Capture is EXPLICIT ONLY -- there is deliberately no capture-on-fire.
 *
 * Recording takes several seconds, and the rig can be changed during them from
 * the WLED pages, another operator, or a sync broadcast. None of that is
 * visible to this app, so an automatic capture regularly filed the wrong look
 * under a song and the swatches drifted from reality. Sequence-guarding only
 * covered writes we ourselves made, which was not enough.
 *
 * Swatches therefore come from stored preset data, which is always accurate,
 * and a real recording is made only when the operator asks for one while the
 * song is actually on the rig.
 */

/** Drops captures whose song no longer exists, so stale looks cannot resurface. */
function prunePreviews() {
  const live = new Set(state.scenes.map((s) => s.id));
  let removed = 0;
  for (const id of Object.keys(state.previews)) {
    if (!live.has(id)) { delete state.previews[id]; removed++; }
  }
  return removed;
}

/**
 * Fires one scene at every controller it names, in parallel.
 *
 * An entry is either a preset number to load, or the string "off" to power the
 * controller down. A controller absent from `entries` is left completely alone
 * -- that is what makes a scene like Sermon able to darken the band lights
 * while a song scene leaves untouched controllers holding their look.
 */
async function fireScene(scene) {
  const targets = Object.entries(scene.entries || {});
  const results = await Promise.allSettled(
    targets.map(async ([devId, action]) => {
      const dev = deviceById(devId);
      if (!dev) throw new Error(`unknown device ${devId}`);

      if (action === OFF) {
        await wled.setPower(dev.host, false);
      } else if (action && typeof action === 'object' && action.mirror) {
        // No preset for this song on this controller, so push the source
        // controller's actual look as raw settings. This is what replaces UDP
        // sync: the same result, but sent explicitly and confirmably.
        await wled.setState(dev.host, mirrorPatch(scene, action.mirror));
      } else {
        await wled.loadPreset(dev.host, action);
      }
      return devId;
    })
  );
  return targets.map(([devId, action], i) => ({
    devId,
    presetId: action,
    ok: results[i].status === 'fulfilled',
    error: results[i].status === 'rejected' ? String(results[i].reason?.message ?? results[i].reason) : null,
  }));
}

/**
 * Builds the state patch that reproduces another controller's preset look.
 * Reads the cached preset body from the source controller and forwards its
 * segment settings, so the target renders the same effect without needing a
 * preset of its own.
 */
function mirrorPatch(scene, sourceDevId) {
  const srcPreset = scene.entries?.[sourceDevId];
  const body = state.presets[sourceDevId]?.[String(srcPreset)];
  const seg = Array.isArray(body?.seg) ? body.seg[0] : null;
  if (!seg) throw new Error(`no cached preset ${srcPreset} on ${sourceDevId} to mirror`);
  return {
    on: true,
    bri: body.bri ?? 255,
    seg: [{ id: 0, fx: seg.fx ?? 0, pal: seg.pal ?? 0, col: seg.col ?? [], sx: seg.sx ?? 128, ix: seg.ix ?? 128 }],
  };
}

/** Every preset on a controller whose name reduces to the same song. */
function candidatesFor(devId, songKey) {
  const out = [];
  for (const [pid, p] of Object.entries(state.presets[devId] ?? {})) {
    const id = Number(pid);
    if (!p?.n || !Number.isFinite(id) || id <= 0) continue;
    if (normalize(p.n) === songKey) out.push({ id, name: p.n, date: extractDate(p.n) });
  }
  return out;
}

/**
 * Fills in controllers a scene does not name yet.
 *
 * This is what removes the dependency on WLED's UDP sync. Historically only the
 * cross, drums and Tubes Right were addressed, and the remaining three framing
 * controllers followed Tubes Right over sync group 2 -- which is exactly the
 * unreliable path. Once every scene names all six, sync is never needed.
 */
function completeScene(scene) {
  const added = [];

  // The four framing sets are ONE visual unit -- that is what sync was doing.
  // So they always take Tubes Right's look rather than hunting for a preset
  // that merely shares the song name. Those stale namesakes are the trap: the
  // trusses hold a January "Goodness of God" in pink and Tube Left an undated
  // orange one, neither matching the current blue. One setting, sent to each
  // controller individually.
  for (const [devId, src] of Object.entries(FOLLOWS)) {
    if (typeof scene.entries[src] !== 'number') continue;
    const cur = scene.entries[devId];
    if (isMirrorEntry(cur) && cur.mirror === src) continue;
    scene.entries[devId] = { mirror: src };
    added.push({ devId, mirror: src, replaced: cur ?? null });
  }

  const songKey = scene.song || normalize(scene.title ?? scene.name ?? '');
  if (!songKey) return added;

  // Independent fixtures (cross, drums, and the framing master) keep their own
  // presets, matched by song.
  for (const dev of state.devices) {
    if (FOLLOWS[dev.id]) continue;
    if (scene.entries[dev.id] != null) continue;
    const cands = candidatesFor(dev.id, songKey);
    if (!cands.length) continue;
    const exact = cands.find((c) => c.date && c.date === scene.date);
    const pick = exact ?? cands.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))[0];
    scene.entries[dev.id] = pick.id;
    added.push({ devId: dev.id, presetId: pick.id, name: pick.name, exact: Boolean(exact) });
  }
  return added;
}

/**
 * Lowest unused preset slot on a controller, for saving a brand-new look.
 *
 * `reserve` claims the slot in the cache immediately. Without it two saves
 * issued before the cache refreshes both pick the same number and the second
 * overwrites the first -- which is exactly what happened when Create song was
 * pressed twice in quick succession.
 */
/**
 * Re-reads the controller before choosing a slot.
 *
 * Allocating from the cache destroyed a real preset: the cache can be stale, or
 * can have been captured while the controller was rewriting presets.json, and
 * an occupied slot then looks free and gets overwritten. Presets are the only
 * copy of the operator's work, so this always pays the round-trip and refuses
 * to allocate at all if the controller cannot be read.
 */
async function nextFreeSlotLive(devId) {
  const dev = deviceById(devId);
  if (!dev) return null;
  try {
    state.presets[devId] = await wled.getPresets(dev.host);
  } catch {
    return null; // never guess -- better to fail the save than clobber a preset
  }
  return nextFreeSlot(devId, true);
}

function nextFreeSlot(devId, reserve = false) {
  const used = new Set(Object.keys(state.presets[devId] ?? {}).map(Number));
  for (let i = 1; i <= 250; i++) {
    if (used.has(i)) continue;
    if (reserve) {
      state.presets[devId] ??= {};
      state.presets[devId][String(i)] = { n: '(reserving)' };
    }
    return i;
  }
  return null;
}

async function pollStatus() {
  const results = await Promise.allSettled(
    state.devices.map(async (dev) => {
      const s = await wled.getState(dev.host);
      const seg = s.seg?.[0] ?? {};
      // Uptime is only needed to spot reboots, and these are small
      // microcontrollers: fetching it on EVERY poll doubled the HTTP rate
      // against each device every few seconds, which contributed to them
      // resetting under load. Once a minute is ample for catching a restart.
      let uptime = state.lastUptime?.[dev.id] ?? null;
      const now = Date.now();
      if (!state.uptimeCheckedAt) state.uptimeCheckedAt = {};
      if ((now - (state.uptimeCheckedAt[dev.id] ?? 0)) > 60000) {
        state.uptimeCheckedAt[dev.id] = now;
        try { uptime = (await wled.getInfo(dev.host)).uptime ?? uptime; } catch { /* optional */ }
      }
      return {
        id: dev.id,
        online: true,
        on: s.on,
        bri: s.bri,
        ps: s.ps,
        fx: seg.fx,
        pal: seg.pal,
        colors: seg.col ?? [],
        uptime,
      };
    })
  );
  return results.map((r, i) => (r.status === 'fulfilled' ? r.value : { id: state.devices[i].id, online: false }));
}

/* ------------------------------------------------------------- reconciler */

/**
 * What a scene says a controller should be showing.
 * Returns null when the scene deliberately does not touch that controller.
 */
function expectedFor(scene, devId) {
  const e = scene?.entries?.[devId];
  if (e == null) return null;
  if (e === OFF) return { kind: 'off' };
  if (isMirrorEntry(e)) {
    const body = state.presets[e.mirror]?.[String(scene.entries[e.mirror])];
    const seg = Array.isArray(body?.seg) ? body.seg[0] : null;
    if (!seg) return null;
    return { kind: 'mirror', fx: seg.fx ?? 0, pal: seg.pal ?? 0, col0: seg.col?.[0] ?? null };
  }
  return { kind: 'preset', ps: Number(e) };
}

const sameColour = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** True when the controller is already showing what the scene asks for. */
function matches(expected, live) {
  if (!expected || !live?.online) return true; // nothing asked, or nothing to compare
  if (expected.kind === 'off') return live.on === false;
  if (!live.on) return false;
  if (expected.kind === 'preset') return live.ps === expected.ps;
  // A mirrored controller legitimately reports ps -1, so compare the look.
  return live.fx === expected.fx && sameColour(live.colors?.[0], expected.col0);
}

/**
 * Re-sends the active scene to any controller that has drifted from it.
 *
 * Controllers occasionally miss a command or reboot and come back on their
 * default green. This notices and corrects only those. It deliberately does NOT
 * re-send to healthy controllers: reloading a preset restarts the effect, which
 * would show as a visible hitch across the whole rig every cycle.
 *
 * `dryRun` reports what it would do and writes nothing.
 */
async function reconcileOnce({ dryRun = false } = {}) {
  const scene = state.scenes.find((s) => s.id === state.activeSceneId);
  if (!scene) return { active: null, checked: 0, drifted: [], repaired: [], held: [], dryRun };

  const live = await pollStatus();
  const drifted = [];
  const rebooted = [];
  const held = [];
  for (const dev of state.devices) {
    const st = live.find((l) => l.id === dev.id);
    if (!st?.online) continue; // offline: nothing we send can land anyway

    // A falling uptime means the controller restarted and will have applied its
    // boot preset, discarding the song. Worth naming separately in the log --
    // it is a hardware symptom, not a networking one.
    const prev = state.lastUptime?.[dev.id];
    if (prev != null && st.uptime != null && st.uptime < prev) {
      rebooted.push(dev.id);
      state.repairStreak[dev.id] = 0; // a reboot is a fresh cause, not a fight
    }
    if (st.uptime != null) (state.lastUptime ??= {})[dev.id] = st.uptime;

    // Being edited live: the operator is deliberately overriding the scene, so
    // "drift" here is the intended look. Uptime above is still tracked, so
    // reboot detection stays correct once the hold lapses.
    if (holdActive(dev.id)) { held.push(dev.id); continue; }

    const expected = expectedFor(scene, dev.id);
    if (!expected) continue;
    if (!matches(expected, st)) {
      drifted.push({
        devId: dev.id, expected, rebooted: rebooted.includes(dev.id),
        saw: { on: st.on, ps: st.ps, fx: st.fx, col0: st.colors?.[0] ?? null },
      });
    } else {
      state.repairStreak[dev.id] = 0;
    }
  }

  const repaired = [];
  const givenUp = [];
  if (!dryRun && drifted.length) {
    invalidateCaptures();
    for (const d of drifted) {
      // If a controller keeps drifting straight back, something else is driving
      // it. Correcting forever would be a visible fight, so back off and say so.
      const streak = state.repairStreak[d.devId] ?? 0;
      if (streak >= 3) { givenUp.push(d.devId); continue; }

      const dev = deviceById(d.devId);
      try {
        if (d.expected.kind === 'off') await wled.setPower(dev.host, false);
        else if (d.expected.kind === 'mirror') await wled.setState(dev.host, mirrorPatch(scene, scene.entries[d.devId].mirror));
        else await wled.loadPreset(dev.host, d.expected.ps);
        state.repairStreak[d.devId] = streak + 1;
        repaired.push(d.devId);
        console.log(`  reconciled ${d.devId}${d.rebooted ? ' (had rebooted)' : ''} back to "${scene.title ?? scene.name}"`);
      } catch (e) {
        console.error(`  reconcile failed for ${d.devId}: ${e.message}`);
      }
    }
  }
  if (rebooted.length) console.log(`  reboot detected: ${rebooted.join(', ')}`);
  return {
    active: scene.title ?? scene.name, checked: state.devices.length,
    drifted, repaired, rebooted, givenUp, held, dryRun,
  };
}

/**
 * Fires a scene, then confirms it actually landed.
 *
 * Runs only in the seconds after a deliberate fire, and re-sends nothing that
 * already matches. The delay must exceed the crossfade time or a controller
 * still mid-transition reads as a failure.
 */
async function fireSceneVerified(scene) {
  releaseHold(); // firing a scene is itself an override, and supersedes any edit

  // "All Off" is a blackout by another name. Defending it would mean fighting
  // anyone who brings a fixture back up, so it is fired and then let go of.
  if (isBlackoutScene(scene)) {
    await stopDefending(`fired "${scene.title ?? scene.name}"`);
    return fireScene(scene);
  }

  state.activeSceneId = scene.id;
  state.repairStreak = {};
  store.save('active', { sceneId: scene.id, at: new Date().toISOString() })
    .catch((e) => console.error('could not record the active scene:', e.message));
  const results = await fireScene(scene);
  const cfg = state.reconcile;
  if (!cfg.verifyOnFire) return results;

  for (let attempt = 0; attempt < (cfg.maxRetries ?? 2); attempt++) {
    await new Promise((r) => setTimeout(r, cfg.verifyDelayMs ?? 1000));
    const check = await reconcileOnce({ dryRun: false });
    if (!check.drifted.length) break;
    for (const d of check.drifted) {
      const hit = results.find((r) => r.devId === d.devId);
      if (hit) hit.retried = (hit.retried ?? 0) + 1;
    }
  }
  return results;
}

let reconcileTimer = null;
function startReconciler() {
  clearInterval(reconcileTimer);
  if (!state.reconcile.periodic) return;
  const every = Math.max(5, Number(state.reconcile.intervalSec) || 20) * 1000;
  reconcileTimer = setInterval(() => {
    reconcileOnce({ dryRun: false }).catch((e) => console.error('reconcile:', e.message));
  }, every);
  reconcileTimer.unref?.();
  console.log(`  reconciler on, every ${every / 1000}s`);
}

/* -------------------------------------------------------------------- http */

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml',
  // ping.png is what offline.html probes to tell whether the server is up.
  '.png': 'image/png', '.ico': 'image/x-icon',
};

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && p === '/api/bootstrap') {
    // Names plus just enough of the first segment to draw a preview swatch.
    // The full preset bodies stay server-side; they are far too large to ship.
    const index = {};
    for (const [devId, presets] of Object.entries(state.presets)) {
      index[devId] = Object.entries(presets)
        .filter(([id, v]) => v && v.n && Number(id) > 0)
        .map(([id, v]) => {
          const seg = Array.isArray(v.seg) ? v.seg[0] ?? {} : {};
          return { id: Number(id), name: v.n, fx: seg.fx ?? 0, pal: seg.pal ?? 0, col: seg.col ?? [], bri: v.bri ?? 255 };
        });
    }
    return json(res, 200, {
      devices: state.devices, scenes: state.scenes, queue: state.queue,
      meta: state.meta, blacklist: state.blacklist, presetIndex: index,
      maintainer: MAINTAINER_EMAIL,
    });
  }

  if (method === 'GET' && p === '/api/status') return json(res, 200, await pollStatus());

  if (method === 'GET' && p === '/api/previews') return json(res, 200, state.previews);

  /**
   * Reconciler: keeps controllers on the active scene after a dropout.
   * GET reports config and the current drift WITHOUT writing anything.
   */
  if (method === 'GET' && p === '/api/reconcile') {
    const check = await reconcileOnce({ dryRun: true });
    return json(res, 200, { config: state.reconcile, activeSceneId: state.activeSceneId, check });
  }

  if (method === 'POST' && p === '/api/reconcile') {
    const body = await readBody(req);
    state.reconcile = {
      ...state.reconcile,
      verifyOnFire: Boolean(body.verifyOnFire ?? state.reconcile.verifyOnFire),
      periodic: Boolean(body.periodic ?? state.reconcile.periodic),
      intervalSec: Number(body.intervalSec ?? state.reconcile.intervalSec) || 20,
    };
    await store.save('reconcile', state.reconcile);
    startReconciler();
    return json(res, 200, state.reconcile);
  }

  // One-shot repair, on demand. Writes only to controllers that have drifted.
  if (method === 'POST' && p === '/api/reconcile/run') {
    return json(res, 200, await reconcileOnce({ dryRun: false }));
  }

  /**
   * Fitted effect models, derived from recordings of the real controllers.
   * The recordings themselves stay server-side: the browser only needs the
   * handful of parameters, not kilobytes of frames.
   */
  if (method === 'GET' && p === '/api/fx-profiles') {
    const models = await store.load('fx-models', null);
    if (models) return json(res, 200, models);
    return json(res, 200, await store.load('fx-profiles', {}));
  }

  /** Which palettes each effect can actually use, measured on hardware. */
  if (method === 'GET' && p === '/api/fx-palettes') {
    return json(res, 200, await store.load('fx-palettes', {}));
  }

  // Grows as you find more settings that are not worth offering.
  if (method === 'POST' && p === '/api/blacklist') {
    const body = await readBody(req);
    state.blacklist = {
      // Spread first so keys this handler does not name survive the save.
      // Without it, every save silently dropped `audioReactive` -- a list this
      // endpoint never mentions but the rest of the app relies on.
      ...state.blacklist,
      effects: Array.isArray(body.effects) ? body.effects : state.blacklist.effects,
      palettes: Array.isArray(body.palettes) ? body.palettes : state.blacklist.palettes,
      paletteColourHonouringOnly:
        body.paletteColourHonouringOnly ?? state.blacklist.paletteColourHonouringOnly ?? true,
      defaultPaletteUnsafe: Array.isArray(body.defaultPaletteUnsafe)
        ? body.defaultPaletteUnsafe
        : state.blacklist.defaultPaletteUnsafe ?? DEFAULT_BLACKLIST.defaultPaletteUnsafe,
      deprecatedPalettes: Array.isArray(body.deprecatedPalettes)
        ? body.deprecatedPalettes
        : state.blacklist.deprecatedPalettes ?? DEFAULT_BLACKLIST.deprecatedPalettes,
    };
    await store.save('blacklist', state.blacklist);
    return json(res, 200, state.blacklist);
  }

  // Manual capture: records whatever the rig is showing RIGHT NOW and files it
  // under this scene. Read-only against the controllers -- it never fires.
  if (method === 'POST' && p === '/api/previews/capture') {
    const { sceneId } = await readBody(req);
    const scene = state.scenes.find((s) => s.id === sceneId);
    if (!scene) return json(res, 404, { error: 'scene missing' });
    const devices = await captureScene(scene, state.devices, { frames: 20, timeout: 8000 });
    if (!Object.keys(devices).length) return json(res, 502, { error: 'no frames captured' });
    state.previews[scene.id] = { at: Date.now(), devices };
    await store.save('previews', state.previews);
    return json(res, 200, { sceneId, devices: Object.keys(devices), frames: Object.values(devices)[0].length });
  }

  if (method === 'GET' && p === '/api/proposals') {
    // Match rebuildLibrary's key: a hand-corrected scene covers its song+date
    // even though its id slug differs, so it must not reappear as pending.
    const keyOf = (s) => `${s.song ?? ''}|${s.date ?? ''}`;
    const known = new Set(state.scenes.map(keyOf));
    const knownIds = new Set(state.scenes.map((s) => s.id));
    const knownTitles = new Set(state.scenes.map((s) => normalize(s.title ?? s.name ?? '')));
    const hidden = new Set(state.dismissed);
    return json(
      res,
      200,
      recentProposals().filter((x) => !known.has(keyOf(x))
                                   && !knownIds.has(x.id)
                                   && !knownTitles.has(normalize(titleFromName(x.name)))
                                   && !hidden.has(x.id))
    );
  }

  // Proposals are recomputed from the controllers every time, so hiding one
  // means remembering its id rather than deleting a record.
  if (method === 'POST' && p === '/api/proposals/dismiss') {
    const { ids = [], all = false } = await readBody(req);
    const target = all ? recentProposals().map((x) => x.id) : ids;
    state.dismissed = [...new Set([...state.dismissed, ...target])];
    await store.save('dismissed', state.dismissed);
    return json(res, 200, { dismissed: state.dismissed.length });
  }

  // Reports where a new song WOULD be saved, so the UI can show the slots
  // before anything is written to a controller.
  if (method === 'GET' && p === '/api/slots') {
    return json(res, 200, state.devices.map((d) => ({ devId: d.id, name: d.name, slot: nextFreeSlot(d.id) })));
  }

  /**
   * Creates a song from a stage design: applies each fixture's look to its
   * controller, saves it there as a real preset, and records the resulting slot
   * numbers explicitly.
   *
   * Nothing here relies on preset NAMES. Songs made this way carry hard preset
   * IDs per controller from the moment they are created, so the name-matching
   * used to reconstruct the historic library never touches them.
   */
  if (method === 'POST' && p === '/api/songs/create') {
    const { title, designs } = await readBody(req);
    const name = String(title ?? '').trim();
    if (!name) return json(res, 400, { error: 'title required' });
    const wanted = Object.entries(designs ?? {});
    if (!wanted.length) return json(res, 400, { error: 'no fixtures designed' });
    invalidateCaptures();

    // All controllers in parallel, so the rig changes as one.
    const saved = await Promise.all(
      wanted.map(async ([devId, d]) => {
        const dev = deviceById(devId);
        if (!dev) return { devId, ok: false, error: 'unknown device' };
        const slot = await nextFreeSlotLive(devId);
        if (slot == null) return { devId, ok: false, error: 'could not read controller for a free slot' };
        try {
          // An explicitly dark fixture is saved as a real preset that powers it
          // off, so the song darkens it rather than leaving it as it was.
          await wled.setState(dev.host, d.on === false
            ? { on: false }
            : {
                on: true,
                bri: d.bri ?? 255,
                seg: [{ id: 0, fx: d.fx ?? 0, pal: d.pal ?? 0, col: d.col ?? [], sx: d.sx ?? 128, ix: d.ix ?? 128 }],
              });
          await wled.savePreset(dev.host, slot, name);
          return { devId, slot, ok: true };
        } catch (e) {
          return { devId, slot, ok: false, error: e.message };
        }
      })
    );

    const entries = {};
    for (const s of saved) if (s.ok) entries[s.devId] = s.slot;
    if (!Object.keys(entries).length) return json(res, 502, { error: 'no controller accepted the save', saved });

    const scene = {
      id: `song-${Date.now().toString(36)}`,
      name,
      title: name,
      created: todayIso(),
      song: null,   // deliberately null: designed songs are never name-matched
      date: null,
      entries,
      source: 'designed',
    };
    state.scenes.push(scene);
    await store.save('scenes', state.scenes);

    for (const s of saved.filter((x) => x.ok)) {
      try { state.presets[s.devId] = await wled.getPresets(deviceById(s.devId).host); } catch { /* cache stays stale */ }
    }
    await store.save('presets.cache', state.presets);

    return json(res, 200, { scene, saved });
  }

  // Fills every scene out to all six controllers so nothing relies on sync.
  if (method === 'POST' && p === '/api/scenes/complete') {
    const report = [];
    for (const scene of state.scenes) {
      // Utility scenes already name all six. Designed songs already hold real
      // preset IDs everywhere -- rewriting their framing entries as mirrors
      // would throw away presets that genuinely exist on those controllers.
      if (scene.source === 'utility' || scene.source === 'designed') continue;
      const added = completeScene(scene);
      if (added.length) report.push({ scene: scene.title ?? scene.name, added });
    }
    await store.save('scenes', state.scenes);
    const coverage = state.scenes.map((s) => Object.keys(s.entries).length);
    return json(res, 200, {
      scenesChanged: report.length,
      entriesAdded: report.reduce((n, r) => n + r.added.length, 0),
      fullyCovered: coverage.filter((c) => c === state.devices.length).length,
      totalScenes: state.scenes.length,
      report,
    });
  }

  /**
   * Re-saves an existing song from an edited stage design.
   *
   * Slots are REUSED where the song already has one, so editing overwrites the
   * song's own presets instead of leaking a new slot on every save. Mirror
   * entries stay mirrors -- those controllers have no preset of their own and
   * pick up the leader's new look automatically.
   */
  if (method === 'POST' && p === '/api/songs/update') {
    const { sceneId, title, designs } = await readBody(req);
    const scene = state.scenes.find((s) => s.id === sceneId);
    if (!scene) return json(res, 404, { error: 'scene missing' });
    const name = String(title ?? scene.title ?? scene.name ?? '').trim();
    if (!name) return json(res, 400, { error: 'title required' });
    invalidateCaptures();

    const saved = await Promise.all(
      Object.entries(designs ?? {}).map(async ([devId, d]) => {
        const dev = deviceById(devId);
        if (!dev) return { devId, ok: false, error: 'unknown device' };
        const existing = scene.entries?.[devId];
        if (isMirrorEntry(existing)) return { devId, ok: true, kept: 'mirror' };

        const slot = typeof existing === 'number' ? existing : await nextFreeSlotLive(devId);
        if (slot == null) return { devId, ok: false, error: 'could not read controller for a free slot' };
        try {
          await wled.setState(dev.host, d.on === false
            ? { on: false }
            : {
                on: true,
                bri: d.bri ?? 255,
                seg: [{ id: 0, fx: d.fx ?? 0, pal: d.pal ?? 0, col: d.col ?? [], sx: d.sx ?? 128, ix: d.ix ?? 128 }],
              });
          await wled.savePreset(dev.host, slot, name);
          return { devId, slot, ok: true, reused: typeof existing === 'number' };
        } catch (e) {
          return { devId, slot, ok: false, error: e.message };
        }
      })
    );

    for (const s of saved) if (s.ok && s.slot != null) scene.entries[s.devId] = s.slot;
    scene.title = name;
    scene.name = name;
    await store.save('scenes', state.scenes);

    for (const s of saved.filter((x) => x.ok && x.slot != null)) {
      try { state.presets[s.devId] = await wled.getPresets(deviceById(s.devId).host); } catch { /* cache stays stale */ }
    }
    await store.save('presets.cache', state.presets);

    return json(res, 200, { scene, saved });
  }

  /**
   * Converts a legacy name-matched song into one LightsApp fully owns.
   *
   * Applies the song to the rig, then saves a real preset on every controller
   * that does not already have one -- the framing followers, which until now
   * only mirrored Tubes Right. Afterwards the song holds hard preset IDs for
   * all six and is marked "designed", so neither name matching nor the mirror
   * repair pass will ever rewrite it.
   */
  if (method === 'POST' && p === '/api/songs/materialise') {
    const { sceneId } = await readBody(req);
    const scene = state.scenes.find((s) => s.id === sceneId);
    if (!scene) return json(res, 404, { error: 'scene missing' });
    const name = String(scene.title ?? scene.name ?? '').trim();
    if (!name) return json(res, 400, { error: 'scene has no title' });

    invalidateCaptures();
    // Put the rig into the song first: a mirrored controller has no preset to
    // copy from, so the only way to capture its look is to render it.
    const fired = await fireScene(scene);
    if (fired.some((f) => !f.ok)) return json(res, 502, { error: 'could not apply the song to every controller', fired });
    await new Promise((r) => setTimeout(r, 700)); // let transitions settle

    const saved = [];
    for (const dev of state.devices) {
      const entry = scene.entries?.[dev.id];
      if (typeof entry === 'number') { saved.push({ devId: dev.id, slot: entry, kept: true, ok: true }); continue; }
      const slot = await nextFreeSlotLive(dev.id);
      if (slot == null) { saved.push({ devId: dev.id, ok: false, error: 'could not read controller for a free slot' }); continue; }
      try {
        await wled.savePreset(dev.host, slot, name);
        scene.entries[dev.id] = slot;
        saved.push({ devId: dev.id, slot, created: true, ok: true });
      } catch (e) {
        saved.push({ devId: dev.id, slot, ok: false, error: e.message });
      }
    }

    // Detach from the name-matching machinery for good. The id must change too:
    // it was derived from song+date, so the matcher would compute the identical
    // id for its own proposal and the two records would be indistinguishable --
    // deleting one would delete both.
    scene.source = 'designed';
    scene.song = null;
    scene.date = null;
    scene.id = `song-${Date.now().toString(36)}-${scene.id.slice(0, 8)}`;
    await store.save('scenes', state.scenes);

    for (const s of saved.filter((x) => x.created)) {
      try { state.presets[s.devId] = await wled.getPresets(deviceById(s.devId).host); } catch { /* cache stays stale */ }
    }
    await store.save('presets.cache', state.presets);

    return json(res, 200, { scene, saved });
  }

  if (method === 'POST' && p === '/api/scenes/rebuild') {
    const stats = rebuildLibrary();
    await store.save('scenes', state.scenes);
    return json(res, 200, { ...stats, scenes: state.scenes });
  }

  if (method === 'GET' && p.startsWith('/api/presets/')) {
    const devId = p.slice('/api/presets/'.length);
    return json(res, 200, state.presets[devId] ?? {});
  }

  if (method === 'POST' && p === '/api/scenes') {
    const body = await readBody(req);
    const title = String(body.title ?? body.name ?? '').trim();
    if (!body.id || !title) return json(res, 400, { error: 'id and title required' });
    const i = state.scenes.findIndex((s) => s.id === body.id);
    const existing = i >= 0 ? state.scenes[i] : null;
    const scene = {
      id: body.id,
      name: title,
      title,
      created: body.created ?? existing?.created ?? todayIso(),
      song: body.song ?? existing?.song ?? null,
      date: body.date ?? existing?.date ?? null,
      entries: body.entries ?? {},
      // A utility scene stays a utility scene through edits, so Sermon and All
      // Off keep surviving rebuilds after you retune them.
      source: existing?.source === 'utility' ? 'utility' : body.source ?? 'manual',
      pinned: body.pinned ?? existing?.pinned ?? false,
    };
    if (i >= 0) state.scenes[i] = scene; else state.scenes.push(scene);
    await store.save('scenes', state.scenes);
    return json(res, 200, scene);
  }

  if (method === 'POST' && p === '/api/scenes/import') {
    const { ids = [] } = await readBody(req);
    const wanted = new Set(ids);
    const known = new Set(state.scenes.map((s) => s.id));
    const added = recentProposals()
      .filter((x) => wanted.has(x.id) && !known.has(x.id))
      .map((x) => ({ id: x.id, name: x.name, song: x.song, date: x.date, entries: x.entries, source: 'auto' }));
    state.scenes.push(...added);
    await store.save('scenes', state.scenes);
    return json(res, 200, { added: added.length, scenes: state.scenes });
  }

  /**
   * Retires a song, or brings it back.
   *
   * Archiving is reversible and touches nothing but a flag, so the song's
   * presets, entries and dates all survive intact. An archived song stops being
   * defended, since it is no longer something the operator means to keep on
   * stage.
   */
  if (method === 'POST' && p === '/api/scenes/archive') {
    const { sceneId, archived } = await readBody(req);
    const scene = state.scenes.find((s) => s.id === sceneId);
    if (!scene) return json(res, 404, { error: 'scene missing' });

    if (archived) {
      scene.archived = true;
      scene.archivedAt = new Date().toISOString();
      scene.pinned = false;   // a retired song has no business at the top
      if (state.activeSceneId === sceneId) await stopDefending('the active scene was archived');
    } else {
      delete scene.archived;
      delete scene.archivedAt;
    }
    await store.save('scenes', state.scenes);
    return json(res, 200, { scene });
  }

  if (method === 'DELETE' && p.startsWith('/api/scenes/')) {
    const id = decodeURIComponent(p.slice('/api/scenes/'.length));
    const existed = state.scenes.some((s) => s.id === id);
    state.scenes = state.scenes.filter((s) => s.id !== id);
    await store.save('scenes', state.scenes);
    // Never leave the reconciler defending something that no longer exists.
    // The lights keep whatever they are showing; it is simply not enforced.
    if (state.activeSceneId === id) await stopDefending('the active scene was deleted');
    return json(res, 200, { ok: true, existed });
  }

  if (method === 'PUT' && p === '/api/queue') {
    const body = await readBody(req);
    state.queue = { items: body.items ?? [], position: body.position ?? -1 };
    await store.save('queue', state.queue);
    return json(res, 200, state.queue);
  }

  // Queue transport. `next` advances then fires; `jump` fires a specific slot;
  // `reset` goes dark and rewinds to before the first item.
  if (method === 'POST' && (p === '/api/queue/next' || p === '/api/queue/prev'
                            || p === '/api/queue/jump' || p === '/api/queue/reset')) {
    const body = p === '/api/queue/jump' ? await readBody(req) : {};
    let pos = state.queue.position;
    if (p === '/api/queue/next') pos += 1;
    else if (p === '/api/queue/prev') pos -= 1;
    else if (p === '/api/queue/reset') pos = -1;
    else pos = Number(body.index);

    /**
     * Stepping off either end of the queue means "nothing is playing", so the
     * rig goes dark rather than refusing the press. Off the front rewinds to
     * -1, so the next NEXT fires item 1; off the back parks just past the end,
     * so PREV comes back to the last song.
     *
     * Like any other blackout this ends self-healing -- otherwise the sweep
     * would put the last song straight back up.
     */
    const restart = p === '/api/queue/reset';
    const offFront = restart || (p === '/api/queue/prev' && pos < 0);
    const offBack = p === '/api/queue/next' && pos >= state.queue.items.length;
    if (offFront || offBack) {
      const why = restart ? 'queue restarted'
        : offFront ? 'stepped back off the front of the queue'
        : 'stepped past the end of the queue';
      await stopDefending(why);
      releaseHold();
      const results = await Promise.allSettled(state.devices.map((d) => wled.setPower(d.host, false)));
      state.queue.position = offFront ? -1 : state.queue.items.length;
      await store.save('queue', state.queue);
      return json(res, 200, {
        position: state.queue.position,
        reset: true,
        atEnd: offBack,
        restarted: restart,
        scene: null,
        results: state.devices.map((d, i) => ({
          devId: d.id, presetId: OFF, ok: results[i].status === 'fulfilled',
        })),
      });
    }

    if (!(pos >= 0 && pos < state.queue.items.length)) return json(res, 400, { error: 'out of range', position: state.queue.position });

    const item = state.queue.items[pos];
    const scene = state.scenes.find((s) => s.id === item.sceneId);
    if (!scene) return json(res, 404, { error: 'scene missing' });

    invalidateCaptures();
    const results = await fireSceneVerified(scene);
    state.queue.position = pos;
    await store.save('queue', state.queue);
    return json(res, 200, { position: pos, scene, results });
  }

  if (method === 'POST' && p === '/api/fire') {
    const body = await readBody(req);
    if (body.sceneId) {
      const scene = state.scenes.find((s) => s.id === body.sceneId);
      if (!scene) return json(res, 404, { error: 'scene missing' });
      invalidateCaptures();
      const results = await fireSceneVerified(scene);
      return json(res, 200, { scene, results });
    }
    if (body.devId && body.presetId != null) {
      const dev = deviceById(body.devId);
      if (!dev) return json(res, 404, { error: 'device missing' });
      try {
        await wled.loadPreset(dev.host, body.presetId);
        return json(res, 200, { results: [{ devId: dev.id, presetId: body.presetId, ok: true }] });
      } catch (e) {
        return json(res, 502, { results: [{ devId: dev.id, presetId: body.presetId, ok: false, error: e.message }] });
      }
    }
    return json(res, 400, { error: 'sceneId or devId+presetId required' });
  }

  // Live push from the stage designer. Only reached while "Go live" is on.
  if (method === 'POST' && p === '/api/fixture/state') {
    const { devId, patch } = await readBody(req);
    const dev = deviceById(devId);
    if (!dev) return json(res, 404, { error: 'device missing' });
    invalidateCaptures();
    holdEdit(dev.id); // this look outranks the active scene until you stop editing
    try {
      await wled.setState(dev.host, patch ?? {});
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 502, { ok: false, error: e.message });
    }
  }

  /**
   * Remembers exactly what the rig is showing, so leaving the designer can put
   * it back.
   *
   * Taken when the designer opens. Going live from there overwrites the stage
   * mid-service, and backing out should undo that rather than leaving a
   * half-finished design in front of the room.
   */
  if (method === 'POST' && p === '/api/rig/snapshot') {
    const taken = {};
    await Promise.all(state.devices.map(async (dev) => {
      try {
        const st = await wled.getState(dev.host);
        const seg = st.seg?.[0] ?? {};
        taken[dev.id] = {
          on: Boolean(st.on),
          bri: st.bri ?? 255,
          ps: typeof st.ps === 'number' ? st.ps : -1,
          seg: { fx: seg.fx ?? 0, pal: seg.pal ?? 0, sx: seg.sx ?? 128, ix: seg.ix ?? 128, col: seg.col ?? [] },
        };
      } catch { /* unreachable: leave it out, and restore will not touch it */ }
    }));
    state.rigSnapshot = { at: Date.now(), devices: taken };
    return json(res, 200, { ok: true, captured: Object.keys(taken) });
  }

  /**
   * Puts the rig back to the snapshot and forgets it.
   *
   * Restores the literal segment state rather than reloading a preset: what was
   * on stage is what goes back, even if it had been tweaked past its preset.
   */
  if (method === 'POST' && p === '/api/rig/restore') {
    const snap = state.rigSnapshot;
    if (!snap) return json(res, 200, { ok: true, restored: [], note: 'nothing was captured' });
    invalidateCaptures();

    const restored = await Promise.all(Object.entries(snap.devices).map(async ([devId, s]) => {
      const dev = deviceById(devId);
      if (!dev) return { devId, ok: false, error: 'unknown device' };
      try {
        await wled.setState(dev.host, s.on === false
          ? { on: false }
          : { on: true, bri: s.bri, seg: [{ id: 0, ...s.seg }] });
        return { devId, ok: true };
      } catch (e) {
        return { devId, ok: false, error: e.message };
      }
    }));

    state.rigSnapshot = null;
    releaseHold(); // back to the pre-edit look, so self-healing can resume
    return json(res, 200, { ok: restored.every((r) => r.ok), restored });
  }

  /**
   * Ends the live-edit hold, restoring self-healing immediately.
   *
   * The designer calls this when you close it or switch "Go live" off, so
   * protection resumes at once rather than after EDIT_HOLD_MS. Omit devId to
   * release every device.
   */
  if (method === 'POST' && p === '/api/fixture/release') {
    const { devId } = await readBody(req);
    releaseHold(devId || undefined);
    return json(res, 200, { ok: true, holding: Object.keys(state.editHold) });
  }

  // Saves one controller's current look into its next unused preset slot.
  if (method === 'POST' && p === '/api/fixture/save') {
    const { devId, name } = await readBody(req);
    const dev = deviceById(devId);
    if (!dev) return json(res, 404, { error: 'device missing' });
    const label = String(name ?? '').trim();
    if (!label) return json(res, 400, { error: 'name required' });
    const slot = await nextFreeSlotLive(devId);
    if (slot == null) return json(res, 409, { error: 'could not read controller for a free slot' });
    invalidateCaptures();
    try {
      await wled.savePreset(dev.host, slot, label);
      state.presets[devId] = await wled.getPresets(dev.host);
      await store.save('presets.cache', state.presets);
      return json(res, 200, { devId, slot, name: label });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (method === 'POST' && p === '/api/blackout') {
    invalidateCaptures();
    // Before the writes, so a sweep landing mid-blackout cannot start putting
    // fixtures back on while the rest are still going dark.
    await stopDefending('blacked out');
    releaseHold();
    const results = await Promise.allSettled(state.devices.map((d) => wled.setPower(d.host, false)));
    return json(res, 200, state.devices.map((d, i) => ({ devId: d.id, ok: results[i].status === 'fulfilled' })));
  }

  /**
   * What version is running, and whether a newer one has been published.
   *
   * Deliberately cannot fail loudly: a booth PC is offline more often than not,
   * and "could not reach GitHub" is not something to put in front of an
   * operator during a service. The client simply shows nothing.
   */
  if (method === 'GET' && p === '/api/update/status') {
    const current = await updater.localVersion();
    const settings = await store.load('update', null) ?? {};
    const branch = settings.branch ?? REPO.branch;
    const check = await updater.checkRemote({ ...REPO, branch });

    // Applying restarts the server and swaps files under a live rig. Refuse
    // while anything is lit -- an update is never so urgent that it should
    // interrupt what is on stage.
    const live = state.devices.length ? await pollStatus().catch(() => []) : [];
    const lit = live.filter((d) => d.online && d.on).map((d) => d.id);

    return json(res, 200, {
      current,
      remote: check.ok ? check.remote : null,
      reachable: check.ok,
      updateAvailable: check.ok && updater.isNewer(check.remote?.version, current.version),
      branch,
      beta: Boolean(settings.beta),
      lightsOn: lit,
      safeToApply: lit.length === 0,
      backups: await updater.listBackups(),
      features: await readFeatures(),
    });
  }

  /** Beta mode and update channel. Local to this machine, never published. */
  if (method === 'POST' && p === '/api/update/settings') {
    const body = await readBody(req);
    const settings = await store.load('update', null) ?? {};
    if (body.branch === 'main' || body.branch === 'beta') settings.branch = body.branch;
    if (typeof body.beta === 'boolean') {
      settings.beta = body.beta;
      delete settings.testingMode;   // the name this setting used to have
    }
    await store.save('update', settings);
    return json(res, 200, settings);
  }

  /**
   * Installs the published version, then restarts into it.
   *
   * `force` exists for the author, not the booth: it skips the lights-on guard.
   */
  if (method === 'POST' && p === '/api/update/apply') {
    const body = await readBody(req);
    const settings = await store.load('update', null) ?? {};
    const branch = settings.branch ?? REPO.branch;

    if (!body.force) {
      const live = await pollStatus().catch(() => []);
      const lit = live.filter((d) => d.online && d.on).map((d) => d.id);
      if (lit.length) {
        return json(res, 409, {
          error: 'the lights are on', lightsOn: lit,
          hint: 'blackout first, or update between services',
        });
      }
    }

    try {
      const result = await updater.applyUpdate({ ...REPO, branch });
      console.log(`  updated to ${result.version} (rollback kept as ${result.backup})`);
      scheduleRestart();
      return json(res, 200, { ...result, restarting: true });
    } catch (e) {
      console.error('  update failed:', e.message);
      return json(res, 500, { error: e.message });
    }
  }

  /** Puts the previous version back. */
  if (method === 'POST' && p === '/api/update/undo') {
    const { name } = await readBody(req);
    const backups = await updater.listBackups();
    const target = name ?? backups[0]?.name;
    if (!target) return json(res, 404, { error: 'nothing to roll back to' });
    try {
      const result = await updater.undoUpdate(target);
      console.log(`  rolled back to ${result.version}`);
      scheduleRestart();
      return json(res, 200, { ...result, restarting: true });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  /**
   * Files a request from whoever is running the lights.
   *
   * Saved locally FIRST, always. The booth is often offline and the webhook may
   * be missing or revoked, and a request that vanishes because of either would
   * be worse than useless -- so the local record is the source of truth and
   * Discord is a bonus on top of it.
   */
  if (method === 'POST' && p === '/api/request') {
    const { kind, detail } = await readBody(req);
    const text = String(detail ?? '').trim();
    if (!text) return json(res, 400, { error: 'say what you need first' });

    const version = (await updater.localVersion()).version;
    const entry = {
      id: `req-${Date.now().toString(36)}`,
      at: new Date().toISOString(),
      kind: String(kind ?? 'Request'),
      detail: text,
      version,
      posted: null,
    };

    const log = await store.load('requests', null) ?? [];
    log.unshift(entry);
    await store.save('requests', log);

    const cfg = await store.load('notify', null);
    if (!cfg?.discordWebhook) {
      return json(res, 200, {
        ok: true, saved: true, sent: false,
        note: 'Saved here, but no Discord channel is set up yet.',
      });
    }

    try {
      await postToDiscord(cfg.discordWebhook, { kind: entry.kind, detail: text, version });
      entry.posted = new Date().toISOString();
      await store.save('requests', log);
      return json(res, 200, { ok: true, saved: true, sent: true });
    } catch (e) {
      // The local copy already exists, so nothing is lost. Say so plainly.
      return json(res, 200, {
        ok: true, saved: true, sent: false,
        note: `Saved here, but it could not be sent (${e.message}).`,
      });
    }
  }

  /**
   * Whether a Discord channel is configured, and setting one up.
   *
   * The URL itself is never returned -- only whether one exists -- so the
   * secret cannot be read back out of the app by anyone using it.
   */
  if (method === 'GET' && p === '/api/notify') {
    const cfg = await store.load('notify', null);
    return json(res, 200, { configured: Boolean(cfg?.discordWebhook) });
  }
  if (method === 'POST' && p === '/api/notify') {
    const { discordWebhook, test } = await readBody(req);
    const cfg = await store.load('notify', null) ?? {};

    if (typeof discordWebhook === 'string') {
      const url = discordWebhook.trim();
      if (url && !/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(url)) {
        return json(res, 400, { error: 'that does not look like a Discord webhook URL' });
      }
      if (url) cfg.discordWebhook = url; else delete cfg.discordWebhook;
      await store.save('notify', cfg);
    }

    if (test) {
      if (!cfg.discordWebhook) return json(res, 400, { error: 'no channel set up yet' });
      try {
        await postToDiscord(cfg.discordWebhook, {
          kind: 'Test message',
          detail: 'If you can read this, requests from the booth will reach you here.',
          version: (await updater.localVersion()).version,
        });
        return json(res, 200, { configured: true, tested: true });
      } catch (e) {
        return json(res, 502, { configured: true, tested: false, error: e.message });
      }
    }
    return json(res, 200, { configured: Boolean(cfg.discordWebhook) });
  }

  /** Requests filed from this machine, newest first. */
  if (method === 'GET' && p === '/api/requests') {
    return json(res, 200, await store.load('requests', null) ?? []);
  }

  if (method === 'POST' && p === '/api/refresh') {
    let ok = 0;
    for (const dev of state.devices) {
      try { state.presets[dev.id] = await wled.getPresets(dev.host); ok++; } catch { /* keep cached copy */ }
    }
    await store.save('presets.cache', state.presets);
    await refreshMeta();
    return json(res, 200, { refreshed: ok, of: state.devices.length });
  }

  return json(res, 404, { error: 'no such endpoint' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(`${req.method} ${url.pathname} failed:`, err);
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

console.log('LightsApp starting...');
await bootstrap();
// At sign-in the autostart entry may fire while a copy is already running --
// after a manual start, or a fast re-login. Say so plainly and exit rather than
// dying with a stack trace nobody will ever see from a hidden window.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`  port ${PORT} already in use - LightsApp is presumably already running.`);
    process.exit(0);
  }
  throw err;
});

/**
 * Relaunches into the newly installed code.
 *
 * The swapped files are already on disk but this process is still running the
 * old ones, so it hands off to the same hidden launcher the sign-in entry uses
 * and exits. Detached, so the child outlives us; delayed, so the HTTP response
 * telling the browser what happened actually gets sent first.
 */
function scheduleRestart(delayMs = 700) {
  setTimeout(() => {
    // Release the port BEFORE the replacement starts. Starting it first would
    // hand it an EADDRINUSE -- which this server treats as "already running"
    // and exits on -- leaving nothing listening at all.
    try {
      server.close();
      server.closeAllConnections?.();
    } catch { /* already down */ }

    setTimeout(async () => {
      try {
        const { spawn } = await import('node:child_process');
        const vbs = path.join(process.cwd(), 'run-hidden.vbs');
        spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', cwd: process.cwd() }).unref();
      } catch (e) {
        console.error('  could not relaunch automatically:', e.message);
        console.error('  start it again from the desktop icon.');
      }
      setTimeout(() => process.exit(0), 400);
    }, 500);
  }, delayMs);
}

/**
 * Starts with nothing to defend.
 *
 * The app cannot know what happened while it was not running -- the rig may
 * have been driven from the controllers' own web pages, or left mid-song, or
 * powered up dark. Defending a remembered scene would mean imposing it on
 * whatever is actually there, twenty seconds after sign-in, with nobody at the
 * keyboard.
 *
 * So it comes up idle and touches nothing. Self-healing begins at the first
 * scene fired from here, which is the first moment the app genuinely knows what
 * is supposed to be on stage.
 */
async function startUnprotected() {
  state.activeSceneId = null;
  state.repairStreak = {};
  state.editHold = {};
  await store.save('active', { sceneId: null, at: new Date().toISOString(), why: 'fresh start' })
    .catch(() => { /* in-memory is what counts */ });
  console.log('  self-heal idle until a scene is fired - the lights are left as they are');
}

server.listen(PORT, HOST, async () => {
  console.log(`  devices: ${state.devices.length}   scenes: ${state.scenes.length}`);
  const rc = state.reconcile;
  console.log(`  self-heal: verify-on-fire ${rc.verifyOnFire ? 'on' : 'off'}, ` +
              `sweep ${rc.periodic ? `every ${rc.intervalSec}s` : 'off'}`);

  // Settle what may be defended BEFORE the sweep timer can fire even once.
  await startUnprotected();
  startReconciler(); // no-op unless it has been deliberately enabled

  console.log(`\n  ready -> http://${HOST}:${PORT}\n`);
});
