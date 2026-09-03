// Flat-file JSON persistence. Chosen over a database deliberately: the whole
// data set is small, and keeping it as readable JSON means a failed service
// night can be fixed with a text editor.

import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');

export async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

/**
 * Fills in data files a fresh install does not have yet, from data/seed/.
 *
 * Only ever creates what is missing. An existing file is left exactly alone --
 * this must never be able to overwrite a live song library, and it runs on
 * every start.
 */
export async function seedMissing(names) {
  const created = [];
  for (const name of names) {
    const target = path.join(DATA_DIR, `${name}.json`);
    try {
      await readFile(target);
      continue;                       // already there: leave it be
    } catch (err) {
      if (err.code !== 'ENOENT') continue;
    }
    try {
      await writeFile(target, await readFile(path.join(DATA_DIR, 'seed', `${name}.json`)));
      created.push(name);
    } catch { /* no seed for this one; the caller's fallback applies */ }
  }
  if (created.length) console.log(`  first run: seeded ${created.join(', ')}`);
  return created;
}

/**
 * Reads one JSON file, falling back rather than failing.
 *
 * A corrupt file must never stop the app from starting. It launches at sign-in
 * with no console anyone will see, so a throw here would look exactly like the
 * app simply not existing -- and the lights would be left with no control
 * surface at all. Losing one file's contents is recoverable; not starting is not.
 *
 * The bad file is kept alongside as .corrupt for inspection instead of being
 * silently overwritten by the next save.
 */
export async function load(name, fallback) {
  const target = path.join(DATA_DIR, `${name}.json`);
  let raw;
  try {
    raw = await readFile(target, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }

  try {
    // Strip a UTF-8 BOM: editors and PowerShell add one, and JSON.parse rejects it.
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    console.error(`  data/${name}.json is not valid JSON (${err.message})`);
    console.error(`  keeping it as ${name}.json.corrupt and carrying on with defaults`);
    await rename(target, `${target}.corrupt`).catch(() => { /* best effort */ });
    return fallback;
  }
}

// Write to a temp file then rename, so an interrupted save can never leave a
// truncated scenes.json behind.
export async function save(name, value) {
  await ensureDataDir();
  const target = path.join(DATA_DIR, `${name}.json`);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, target);
}

/** Newest folder under backups/, used to seed the preset cache without hitting devices. */
export async function newestBackupDir() {
  const root = path.join(process.cwd(), 'backups');
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    return dirs.length ? path.join(root, dirs[dirs.length - 1]) : null;
  } catch {
    return null;
  }
}

export async function readBackupPresets(dir, backupName) {
  try {
    return JSON.parse(await readFile(path.join(dir, `${backupName}__presets.json`), 'utf8'));
  } catch {
    return null;
  }
}
