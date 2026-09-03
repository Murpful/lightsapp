// Merges the parallel audit shards into the two files the app reads:
//
//   data/fx-palettes.json  which palettes each effect can actually use
//   data/blacklist.json    effects that ignore user colours, added automatically
//
// Offline. Run after tools/palette-audit.mjs has finished on every shard.

import { readFile, writeFile } from 'node:fs/promises';

// Includes partial shards: the audit saves incrementally, so a run cut short
// still contributes everything it measured before it stopped.
const SHARDS = ['a','b','c','d','trial','e','f','g','h','i','j'];
const merged = {};

for (const s of SHARDS) {
  const path = `data/fx-audit-${s}.json`;
  try {
    const part = JSON.parse(await readFile(path, 'utf8'));
    Object.assign(merged, part);
    console.log(`  shard ${s}: ${Object.keys(part).length} effects`);
  } catch {
    console.log(`  shard ${s}: not present`);
  }
}

const all = Object.entries(merged).map(([fx, v]) => ({ fx: +fx, ...v }));
const audio = all.filter((e) => e.audioReactive);
const selfColoured = all.filter((e) => e.selfColoured);
const usableOnly = all.filter((e) => !e.audioReactive && !e.selfColoured);

// fx-palettes: only effects that accept our colours. Audio-reactive and
// self-colouring ones are excluded from the picker entirely.
const palettes = {};
for (const e of usableOnly) {
  palettes[e.fx] = { name: e.name, usable: e.usable, ignoresPalette: e.usable.length <= 1 };
}
await writeFile('data/fx-palettes.json', JSON.stringify(palettes), 'utf8');

// Blacklist: everything that cannot take a user-defined palette. Audio-reactive
// effects are listed too -- they are usable on the rig, but the operator cannot
// set their colour, which is the criterion here.
const blPath = 'data/blacklist.json';
const bl = JSON.parse(await readFile(blPath, 'utf8').catch(() => '{}'));
const names = [...new Set([
  ...(bl.effects ?? []),
  ...selfColoured.map((e) => e.name.trim()),
])].sort();
bl.effects = names;
bl.palettes = bl.palettes ?? [];
bl.paletteColourHonouringOnly = true;
bl.deprecatedPalettes = bl.deprecatedPalettes ?? ['Default'];
bl.audioReactive = audio.map((e) => e.name.trim()).sort();
await writeFile(blPath, JSON.stringify(bl, null, 1), 'utf8');

console.log(`effects audited      : ${all.length}`);
console.log(`audio-reactive       : ${audio.length}`);
console.log(`self-coloured        : ${selfColoured.length}  -> blacklisted`);
console.log(`offer a palette      : ${usableOnly.length}`);

const byCount = {};
for (const e of usableOnly) byCount[e.usable.length] = (byCount[e.usable.length] ?? 0) + 1;
console.log('\npalette options offered:');
for (const k of Object.keys(byCount).sort()) console.log(`  ${k} option(s): ${byCount[k]} effect(s)`);

console.log('\nblacklisted for ignoring your colours:');
for (const e of selfColoured.sort((a, b) => b.meanSat - a.meanSat).slice(0, 25)) {
  console.log(`  fx ${String(e.fx).padEnd(4)} ${e.name.padEnd(24)} sat=${e.meanSat}`);
}
if (selfColoured.length > 25) console.log(`  ... +${selfColoured.length - 25} more`);

