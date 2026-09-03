# LightsApp

One control surface for a stage lighting rig built from [WLED](https://kno.wled.ge/)
controllers, replacing one browser tab per controller.

It runs locally on the booth PC as a small web app. Nothing is hosted, nothing
leaves the network, and it has no npm dependencies — just Node and the files in
this repository.

![node 20+](https://img.shields.io/badge/node-%E2%89%A520-informational)
![no dependencies](https://img.shields.io/badge/dependencies-none-informational)

## What it does

**Songs.** A song is one look across the whole rig, stored as a preset on each
controller. Songs are grouped by name, with each dated version kept behind a
chevron, so a song played across several months stays one entry in the list.

**Queue.** Drag songs into a running order and step through it with a single
NEXT button, or the space bar. Stepping off either end turns the rig off. Start
over rewinds to the beginning without losing the running order.

**Stage designer.** Pick a fixture, choose its effect, palette, colours,
brightness, speed and intensity, and save it as a song. "Go live" pushes the
design to the real controllers while you work, and backing out puts the stage
back exactly as you found it.

**Auto.** Give it a palette with primary, secondary and accent colours, plus a
song speed and energy, and it builds a look for every fixture. Generate again
for another take, or click one fixture to reroll only that one.

**Self-healing.** Controllers occasionally miss a command or reboot. Every 20
seconds the app compares each one against the song that is supposed to be
playing and re-sends only to those that have drifted. Going dark by any route —
blackout, an all-off song, either end of the queue — ends that, so nothing
fights you when you want the stage dark.

**Archive.** Retire a song without deleting it. Archived songs drop out of the
list and out of search, and live in a folder at the bottom until unarchived or
deleted for good.

**Hidden list.** Effects and palettes that are not useful in the room can be
hidden from the pickers. Palettes that ignore your colours, and WLED's empty
"Reserved" slots, are hidden automatically.

**Updates.** The app checks GitHub when you open it and can install a new
version on request, keeping the previous one for one-click rollback. It never
updates on its own and refuses while any fixture is lit.

## Running it

Double-click **Start LightsApp** on the desktop, or:

```
start.cmd
```

Then open <http://127.0.0.1:8420>.

Run `install-autostart.cmd` once to launch it at sign-in
(`uninstall-autostart.cmd` reverses it). Neither needs administrator rights.

Requires Node 20 or newer (developed on 24). A portable extract is fine — no
system install and no admin rights needed.

## How it is put together

```
server.js        HTTP API, scenes, queue, self-healing
lib/             WLED client, flat-file storage, updater, name matching
public/          the browser app (no framework, no build step)
data/            your songs, queue and settings — never in git
data/seed/       defaults a fresh install starts from
tools/           one-off scripts for measuring effects on real hardware
```

Every controller is addressed **individually**. WLED's UDP sync is deliberately
not used: it is unreliable across a rig this size, and one controller
broadcasting over the others is difficult to diagnose from the booth.

`data/` is yours. Updates never touch it, and it is excluded from the
repository, so your song library and settings survive everything.

## Adapting it to a different rig

Most of the work is one file.

**1. Describe your controllers** in `data/seed/devices.json` (delete your
`data/devices.json` to pick up changes):

```json
{
  "id": "cross",
  "name": "Cross",
  "host": "192.168.0.226",
  "mdns": "quinled.local",
  "leds": 662,
  "role": "cross",
  "order": 1
}
```

`id` is used throughout the code, `name` is what the operator sees, `host` can
be an IP or mDNS name, and `order` sets left-to-right position in the UI.

**2. Group fixtures that should share a setting.** Some rigs have several
controllers that always do the same thing. In `public/stage.js`:

```js
export const GROUP_OF = { tubeL: 'tubeR', trussR: 'tubeR', trussL: 'tubeR' };
```

Each key follows its leader, receiving the same settings sent individually.
The server has a matching `FOLLOWS` map in `server.js`.

**3. Lay out the stage picture.** `CROSS_GEO` and `LAYOUT` in `public/stage.js`
place each fixture on the canvas. Geometry is in pixels at draw time, so
diagonal runs stay at the angle you specify whatever the window size. This is
cosmetic — the app works with the layout untouched, it will just not look like
your room.

**4. Point updates at your own fork.** In `server.js`:

```js
const REPO = { owner: 'Murpful', repo: 'lightsapp', branch: 'main' };
```

**5. Optional — feature requests.** Create a Discord webhook and save it as
`data/notify.json`:

```json
{ "discordWebhook": "https://discord.com/api/webhooks/..." }
```

Requests from the Request button then arrive in that channel. Without it they
are still saved to `data/requests.json`.

Anything else — effect names, palettes, which effects support which palettes —
is read from the controllers themselves the first time it runs.

## Shipping a change

Push to `main` and the booth is offered the update next time the app is opened,
provided `version.json` has a higher version number.

To ship something that is not ready to be the default, add it to
`features.json` marked `"beta"`. It reaches the booth dormant and appears only
when Beta mode is switched on, under the version number. Change its stage to
`"stable"` and push, and it becomes normal for everyone on the next update.

## Licence

MIT — see [LICENSE](LICENSE). Use it, change it, run it in your own building.
No warranty of any kind.
