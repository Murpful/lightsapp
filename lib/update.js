// Self-update from GitHub, with no dependency on git being installed.
//
// The church PC only ever CONSUMES updates: it downloads the published tarball
// and swaps the code files in. Nothing here needs git, so nothing here can
// break because git was uninstalled or fell off PATH after the author left.
//
// Two rules this module exists to guarantee:
//   1. data/ is never touched. The song library, queue and blacklist belong to
//      whoever is running the lights, not to the project.
//   2. Every apply is reversible. The previous code is copied aside first, so a
//      bad release is one click from being undone by someone non-technical.

import https from 'node:https';
import zlib from 'node:zlib';
import path from 'node:path';
import { mkdir, readFile, writeFile, rm, cp, readdir, stat } from 'node:fs/promises';

const ROOT = process.cwd();
const VERSIONS_DIR = path.join(ROOT, 'versions');

/**
 * Files and folders the updater owns.
 *
 * An allow-list rather than "everything except data/", so a stray file in the
 * repo can never land somewhere unexpected on the church machine, and anything
 * the operator has put in the folder themselves is left alone.
 */
const MANAGED = [
  'server.js', 'version.json', 'features.json', 'package.json',
  'offline.html', 'README.md',
  'start.cmd', 'start-silent.cmd', 'Start LightsApp.cmd',
  'run-hidden.vbs', 'install-autostart.cmd', 'uninstall-autostart.cmd', 'launch.ps1',
  'lib', 'public', 'tools',
];

const get = (url, { json = false, binary = false } = {}) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'LightsApp', Accept: json ? 'application/json' : '*/*' },
      timeout: 20000,
    }, (res) => {
      // GitHub redirects tarball requests; follow them rather than failing.
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, { json, binary }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (binary) return resolve(buf);
        const text = buf.toString('utf8');
        try {
          resolve(json ? JSON.parse(text) : text);
        } catch (e) {
          reject(new Error(`bad JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });

/** Compares dotted versions numerically, so 1.10.0 beats 1.9.0. */
export function isNewer(remote, local) {
  const parts = (v) => String(v ?? '0').split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parts(remote), parts(local)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export const localVersion = async () => {
  try {
    return JSON.parse(await readFile(path.join(ROOT, 'version.json'), 'utf8'));
  } catch {
    return { version: '0.0.0', released: null, notes: '' };
  }
};

/**
 * Asks GitHub what the published version is.
 *
 * Never throws for the caller's sake -- being offline is the normal state of a
 * booth PC between services, and it must not produce an error on screen.
 */
export async function checkRemote({ owner, repo, branch }) {
  // raw.githubusercontent is CDN-cached, so a freshly pushed release can take
  // a few minutes to appear. The timestamp shortens that where the cache
  // honours it; where it does not, the update simply shows up a little later,
  // which is harmless.
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/version.json?t=${Date.now()}`;
  try {
    return { ok: true, remote: await get(url, { json: true }) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------------- tar */

/**
 * Minimal tar reader, enough for a GitHub source tarball.
 *
 * Node ships gzip but no tar, and pulling in a dependency for ~60 lines would
 * break the zero-dependency rule this project is built on. Only the record
 * types GitHub actually emits are handled; anything else is skipped rather than
 * guessed at.
 */
export function readTar(buf) {
  const files = [];
  let offset = 0;
  let longName = null;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;          // end-of-archive padding

    const str = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(str(124, 12), 8) || 0;
    const type = String.fromCharCode(header[156]);
    let name = str(0, 100);
    const prefix = str(345, 155);
    if (prefix) name = `${prefix}/${name}`;
    if (longName) { name = longName; longName = null; }

    const body = buf.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === 'L') {                                // GNU long name record
      longName = body.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (type === 'x' || type === 'g') continue;        // pax metadata
    if (type === '0' || type === '\0') files.push({ name, body });
  }
  return files;
}

/** Downloads the branch tarball and writes it into `dest`, stripping the top dir. */
async function fetchInto(dest, { owner, repo, branch }) {
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${branch}`;
  const gz = await get(url, { binary: true });
  const tar = zlib.gunzipSync(gz);

  await rm(dest, { recursive: true, force: true });
  let written = 0;
  for (const f of readTar(tar)) {
    // GitHub wraps everything in "<repo>-<sha>/"; drop that first segment.
    const rel = f.name.split('/').slice(1).join('/');
    if (!rel) continue;
    const target = path.join(dest, rel);
    if (!target.startsWith(dest)) continue;            // refuse path traversal
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, f.body);
    written++;
  }
  if (!written) throw new Error('the download contained no files');
  return written;
}

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

/**
 * Applies the published version.
 *
 * Order matters: everything is downloaded and verified BEFORE the running copy
 * is touched, so a failed download leaves the booth exactly as it was.
 */
export async function applyUpdate({ owner, repo, branch }) {
  const staging = path.join(VERSIONS_DIR, '.staging');
  await mkdir(VERSIONS_DIR, { recursive: true });
  await fetchInto(staging, { owner, repo, branch });

  // Refuse anything that does not look like this app, rather than emptying the
  // folder because a URL was wrong.
  for (const required of ['server.js', 'public', 'lib']) {
    if (!(await exists(path.join(staging, required)))) {
      await rm(staging, { recursive: true, force: true });
      throw new Error(`the download is missing ${required} - not applying it`);
    }
  }
  const incoming = JSON.parse(await readFile(path.join(staging, 'version.json'), 'utf8'));

  // Keep the current code so the operator can undo without knowing anything.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(VERSIONS_DIR, stamp);
  await mkdir(backup, { recursive: true });
  for (const item of MANAGED) {
    const from = path.join(ROOT, item);
    if (await exists(from)) await cp(from, path.join(backup, item), { recursive: true });
  }
  await writeFile(path.join(backup, '.rolled-back-from.json'),
    JSON.stringify({ replacedAt: new Date().toISOString(), becameVersion: incoming.version }, null, 2));

  // Swap in the new code. data/ is not in MANAGED and is never considered.
  const applied = [];
  for (const item of MANAGED) {
    const from = path.join(staging, item);
    if (!(await exists(from))) continue;
    await cp(from, path.join(ROOT, item), { recursive: true, force: true });
    applied.push(item);
  }
  await rm(staging, { recursive: true, force: true });
  await pruneBackups();
  return { version: incoming.version, notes: incoming.notes, applied, backup: stamp };
}

/** Keeps the few most recent rollback copies; older ones are just clutter. */
async function pruneBackups(keep = 3) {
  try {
    const dirs = (await readdir(VERSIONS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const old of dirs.slice(keep)) {
      await rm(path.join(VERSIONS_DIR, old), { recursive: true, force: true });
    }
  } catch { /* nothing kept yet */ }
}

/** The rollback copies available, newest first. */
export async function listBackups() {
  try {
    const dirs = (await readdir(VERSIONS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort()
      .reverse();
    return Promise.all(dirs.map(async (name) => {
      let meta = {};
      try { meta = JSON.parse(await readFile(path.join(VERSIONS_DIR, name, 'version.json'), 'utf8')); } catch {}
      return { name, version: meta.version ?? 'unknown' };
    }));
  } catch {
    return [];
  }
}

/** Puts back a rollback copy. Same rule: data/ is never involved. */
export async function undoUpdate(name) {
  const backup = path.join(VERSIONS_DIR, name);
  if (!(await exists(path.join(backup, 'server.js')))) {
    throw new Error('that rollback copy is incomplete');
  }
  const restored = [];
  for (const item of MANAGED) {
    const from = path.join(backup, item);
    if (!(await exists(from))) continue;
    await cp(from, path.join(ROOT, item), { recursive: true, force: true });
    restored.push(item);
  }
  const version = JSON.parse(await readFile(path.join(ROOT, 'version.json'), 'utf8')).version;
  return { version, restored };
}
