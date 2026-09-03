# LightsApp

One control surface for the sanctuary's six WLED controllers, replacing six
separate browser tabs.

## Running it

```
start.cmd
```

Opens <http://127.0.0.1:8420> automatically. To launch at sign-in, run
`install-autostart.cmd` once (`uninstall-autostart.cmd` reverses it). Neither
needs administrator rights.

Node lives at `%LOCALAPPDATA%\Programs\node-v24.19.0-win-x64` — a portable
extract, not a system install. The app itself has **zero npm dependencies**, so
there is nothing that can fail to install on the booth PC.

## The rig

| Device   | Name          | Host               | LEDs | Notes                          |
|----------|---------------|--------------------|------|--------------------------------|
| `cross`  | Cross         | `quinled.local`    | 662  | Two outputs, 331 each          |
| `drum`   | Drums         | `srwled9.local`    | 69   |                                |
| `tubeR`  | Tubes Right   | `right-tube.local` | 142  | Broadcasts to the other framing |
| `tubeL`  | Tube Left     | `192.168.0.194`    | 71   | Framing                        |
| `trussR` | Right Truss   | `192.168.0.190`    | 78   | Framing                        |
| `trussL` | Left Truss    | `192.168.0.200`    | 78   | Framing                        |

Addresses live in `data/devices.json`; edit there if a controller moves.

### Why the app does not use WLED sync

The four framing controllers were linked by WLED's UDP group sync — `tubeR`
transmits on group 2 and the others listen. It is unreliable, and both truss
controllers *also* transmit, so touching either one broadcasts over everything
else.

**Every scene now addresses all six controllers explicitly.** Nothing depends on
sync. Each entry is one of:

| Entry | Sent |
|---|---|
| a preset number | `POST /json/state {"ps":N}` to that controller |
| `"off"` | powers that controller down |
| `{"mirror":"tubeR"}` | Tubes Right' preset settings (`fx`, `pal`, `col`, `sx`, `ix`, `bri`) pushed as raw state |

### The framing group is one setting, sent six ways

`tubeL`, `trussR` and `trussL` **always** mirror `tubeR`. They are four sets of
the same visual element, which is exactly what sync was doing — one look across
all of them. The app just delivers it explicitly instead of by broadcast.

They are deliberately *not* matched to same-named presets on their own
controllers. That was a real bug: those controllers hold stale namesakes, and
matching by name picked them. "Goodness of God" ended up with Right Truss on a
January version in pink `(255,79,220)` and Tube Left on an undated orange
`(255,160,0)`, while Tubes Right showed the current blue `(20,20,255)`. Repairing
this corrected **19 entries across 11 songs**.

Mirroring reads the source preset from cache and sends its settings directly, so
a controller needs no preset of its own — which matters, since Left Truss only
holds 34 presets in total. Every controller still reports success or failure
individually per fire.

To give one framing light its own look, set it explicitly in the editor. Note
that `POST /api/scenes/complete` re-normalises the group, so re-running it will
undo that.

`POST /api/scenes/complete` fills any partially-covered scene out to all six.

Sync is left configured on the devices but is now entirely unused, so it can be
switched off whenever you like.

## Stage designer

**Stage** (or **+ New**) opens a simulated stage showing all six fixtures from
the congregation's view. **Click any fixture to design it.** This is intended to
replace the WLED web pages entirely — you should not need to open
`quinled.local` and friends.

### Physical arrangement

Geometry is built in **pixels** at draw time, not in a normalised box — a
45-degree run only looks like 45 degrees if its horizontal and vertical spans
are equal in pixels, and normalised coordinates would skew every slope as the
window resizes.

| Fixture | Shape |
|---|---|
| **Cross** | Tall outline, **one limb thickness shared by trunk and both arms**. 662 LEDs from bottom-left, up and around to bottom-right. Stands on the floor line. |
| **Long tubes** | Two stacked 45° runs per side, high end toward stage centre. 71 LEDs per tube. |
| **Trusses** | Six stacked 45° runs, each ~⅛ the length of a tube run. 13 LEDs each. |
| **Drums** | Two runs meeting in a peak, like a mountain behind the kit. Right of centre stage, immediately left of the cross. |

Fixtures are deliberately small — they cover about **10% of the frame**, leaving
the rest dark. A real stage from the congregation is mostly darkness, and
matching that is what makes the preview read as the room rather than a diagram.
All proportions live in `LAYOUT` at the top of `public/stage.js`.

> **Left tube count.** Each long tube is 71 LEDs — Tubes Right carries 142, i.e.
> exactly two. Tube Left carries **71, one tube's worth**, and its controller is
> named `Ltube left btm`. The stage draws two tubes on the left as they exist
> physically, but only one tube's worth of LEDs is driven by any controller found
> on the network. Worth checking whether the upper-left tube is wired.

Selecting any framing light selects **all four as one unit**, matching how they
actually behave. One setting, sent to each controller individually.

Two preview modes:

- **Simulated** (default) — approximated in JS; **nothing is sent anywhere**.
  Effects are matched by name keyword, so it is a fair impression, not exact.
- **Go live** — taps every controller's live-view stream and pushes edits to
  them, so the preview is their *real* per-LED output. The lights move while you
  work, so this is for setup time.

Per fixture you get: start-from-an-existing-preset, effect, palette, three
colours, brightness, speed and intensity. Cross proportions — height, width vs
height, limb thickness (one slider, since every limb matches) and crossbar
height — are sliders; tune them until the outline matches the real cross.

### Rendering performance

The first version ran at a crawl. Three fixes, measured at **2.96 ms/frame for
all six fixtures** (~338 fps of headroom, from ~10 fps):

- **No `shadowBlur`.** It re-filters a sprite for *every* LED and dominated the
  frame. Glow is now a translucent disc plus a bright core — two flat fills.
- **Device pixel ratio capped at 1.5.** Fill cost is quadratic in it and the
  extra detail is invisible at this scale.
- **Reused buffers.** Colour arrays are allocated once per fixture instead of
  ~1,100 LEDs' worth of fresh `Uint8Array` every frame.

An fps readout sits in the bottom-left of the stage.

## Creating songs — no name matching

**Create song** applies every fixture's design to its controller, saves it there
as a real preset, and records the resulting slot numbers. All six at once, in
parallel.

Songs made this way are stored with `source: "designed"` and carry **hard preset
IDs per controller from the moment they exist**. The name-matching machinery
that reconstructed your historic library never touches them:

- `rebuild` preserves them rather than regenerating them
- `complete` skips them entirely, so their real per-controller presets are never
  replaced by mirrors

Name matching now applies *only* to the legacy library imported from your
existing presets. Everything new is explicit.

> Both trusses and both tubes also listen on **group 1**, the WLED factory
> default. Any new or factory-reset WLED added to this network with sync
> transmit enabled will hijack all four framing sets.

## Scenes

Preset *numbers* differ per controller — the 08/09/26 blood song is 105 on the
cross, 237 on the drums, 71 on the tubes. A **scene** is the mapping: one name
to one preset number per controller.

Scenes were bootstrapped automatically from your existing preset names, which
follow a `<song> <date>` convention kept consistent across controllers. That
join key produced **82 scenes** imported outright, with the remainder in the
**Review** tab to confirm by hand.

Only high-confidence matches auto-import: 3+ controllers, a date, no duplicates,
and no reliance on the abbreviation table. Ambiguous initialisms (`TIG` is both
"This Is our God" and "Trust In God"; `WMS`, `GOG`) are deliberately excluded
from auto-import and land in Review instead.

## Using it during a service

- **Space** or **→** fires the next scene. **←** steps back.
- Stepping back off the *front* of the queue blacks out every controller and
  rewinds, so the next **NEXT** fires item 1 again.
- Drag queue blocks to reorder. Reordering keeps `NOW` pointed at whatever is
  actually live.
- Clicking or dragging **never** sends anything to the lights. Only the
  transport buttons, the ▶ buttons and Blackout write to controllers.
- A scene only touches the controllers it names; others are left alone.
- Fan-out is parallel with a 3s timeout, so one dead controller cannot stall the
  rest. Failures are reported per controller in the toast.

## Data

Everything is plain JSON under `data/`, safe to edit or back up:

| File                 | Contents                                  |
|----------------------|-------------------------------------------|
| `devices.json`       | Controller registry                       |
| `scenes.json`        | Global presets                            |
| `queue.json`         | Current queue and position                |
| `presets.cache.json` | Cached presets, refreshed via **Refresh** |
| `meta.json`          | Effect and palette names                  |

`backups/<timestamp>/` holds full per-controller dumps (presets, config, info,
state). The app seeds itself from the newest backup on first run, so it starts
fully populated without touching a controller. **These backups are the only
copy of years of preset work that is not on ESP32 flash.**

## Preview

Each scene shows one colour strip per controller it drives.

Before a scene has ever been fired, the strip is drawn from the preset's stored
colours. Once fired, LightsApp taps WLED's live-view WebSocket
(`ws://<host>/ws`, send `{"lv":true}`) and records ~20 frames of **real per-LED
output**, which then replay as an animation. The library becomes more accurate
the more the rig is used. **Capture preview** in the scene editor records
whatever is on the lights at that moment.

Capture is strictly read-only — it never fires anything.

> Frame format gotcha: the header's LED-count field is 8-bit truncated, so the
> 662-LED cross reports 150 (662 mod 256). `lib/capture.js` derives the real
> count from the buffer length and uses the header only as a sanity check.

## Songs, versions and folders

A song is a folder. Its versions are dated by the day they were created — **no
date goes in the name**. Folder actions target the newest version; the chevron
reveals older ones.

Historic presets named `<song> <date>` are folded into the same folders
automatically: the trailing date becomes the version date and is stripped from
the displayed title.

## Pinned utility scenes

Two always-available scenes sit above the songs and are exempt from the
recent-year filter:

| Scene | Does |
|-------|------|
| **Sermon** | Cross loads #184 (warm white); all five others power off |
| **All Off** | All six power off |

They survive every library rebuild, and stay utilities even after you edit them.

### Only useful controls are shown

WLED publishes, per effect, which sliders and colour slots it actually uses —
`Solid@;!;` has no speed or intensity and one colour; `Wipe@!,!;!,!,;!` uses both
sliders, two colours and the palette. That metadata drives the panel, so a
control appears only when it would change something.

Palette choice narrows it further: fixed palettes such as **Forest** ignore the
segment colours entirely, so the colour section disappears. Effect capability
and palette are intersected — Dancing Shadows uses one colour, so pairing it
with `* Colors 1&2` shows only Colour 1.

### Blacklisted settings

Options judged not useful live in `data/blacklist.json` and are hidden from the
pickers:

```json
{ "effects": [], "palettes": ["Party", "Rainbow", "Rainbow Bands"] }
```

An **Allow blacklisted settings** checkbox appears at the foot of any panel that
is withholding something; blacklisted entries show with a `•` when revealed. A
design already using a blacklisted setting always keeps it, so nothing is
silently reassigned. Extend via `POST /api/blacklist` or by editing the file.

## Editing and creating

**Edit** opens the simulated stage with that song loaded — every fixture set to
the preset the song assigns it, mirrors resolved to the look they inherit. Tweak
and hit **Save changes**: each fixture's design is re-saved into the song's
*existing* preset slots, so editing overwrites rather than leaking a new slot
every time. Mirror entries stay mirrors and pick up the leader's new look.

**Map** is the lower-level view, assigning presets per controller. It expresses
two things the designer cannot:

- **— leave alone —**, so the scene does not touch that controller at all
- **— match Tubes Right —**, the mirror entry

**+ New** opens the designer with **the whole rig powered off**, so you switch on
only what the song uses. Name it and hit **Create song** to write a fresh preset
to every controller at once.

Each fixture has a **Powered on** toggle. Switching it off darkens that fixture,
hides its other controls, and saves a preset that powers it down — so firing the
song darkens it rather than leaving whatever was there.

> This is the only path that writes presets to the controllers, and it only ever
> uses **unused** slots — nothing existing is overwritten.

Edits save as `manual`, protecting them from a later library rebuild.

## Which presets appear

Only presets dated in the current service year (`MM/DD/26`) are surfaced. Older
ones remain on the controllers untouched — they are simply not listed. Change
the cutoff with the `MIN_YEAR` environment variable.

Bare `M/D` names carry no year and are treated as old. This matters: the last
two digits of a bare date look exactly like a year, so `holy spirit 1/26` is
January 26, not 2026.

`POST /api/scenes/rebuild` regenerates the auto-matched half of the library from
the current preset cache, preserving every hand-edited scene.

## Not built yet

- Scheduling by day/time.
