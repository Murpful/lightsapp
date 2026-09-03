// Thin HTTP client for WLED controllers.
// Every call is bounded by a timeout: during a service a dead controller must
// never stall the others, so callers fan out with Promise.allSettled.

const DEFAULT_TIMEOUT = 3000;

async function req(host, endpoint, { method = 'GET', body, timeout = DEFAULT_TIMEOUT } = {}) {
  const url = `http://${host}${endpoint}`;
  const init = { method, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${method} ${url} -> HTTP ${res.status}`);
  return res.json();
}

export const getInfo = (host) => req(host, '/json/info');
export const getState = (host) => req(host, '/json/state');
export const getPresets = (host) => req(host, '/presets.json', { timeout: 20000 });

/**
 * Effects arrive as "Name@slider1,slider2,...;colour1,colour2,colour3;palette".
 * An empty field means that control does nothing for this effect, which is how
 * the UI knows what to hide. "Solid@;!;" has no speed or intensity and uses one
 * colour; "Wipe@!,!;!,!,;!" uses both sliders, two colours and the palette.
 */
export function parseEffect(raw) {
  const s = String(raw);
  const at = s.indexOf('@');
  const name = at < 0 ? s : s.slice(0, at);
  const [sliders = '', colours = '', palette = ''] = (at < 0 ? '' : s.slice(at + 1)).split(';');
  const sl = sliders.split(',');
  const co = colours.split(',');
  const used = (v) => (v ?? '').trim() !== '';
  return {
    name,
    speed: used(sl[0]),
    intensity: used(sl[1]),
    colors: [used(co[0]), used(co[1]), used(co[2])],
    palette: used(palette),
  };
}

export async function getEffects(host) {
  const raw = await req(host, '/json/eff', { timeout: 8000 });
  return raw.map(parseEffect);
}

export const getPalettes = (host) => req(host, '/json/pal', { timeout: 8000 });

/**
 * Push a state patch to a controller. Used for preset loads, blackout and
 * brightness. WLED merges the patch, so we only send what changes.
 */
export const setState = (host, patch) => req(host, '/json/state', { method: 'POST', body: patch });

export const loadPreset = (host, presetId) => setState(host, { ps: Number(presetId) });

export const setPower = (host, on) => setState(host, { on: Boolean(on) });

/**
 * Saves whatever the controller is CURRENTLY showing into a preset slot.
 * `ib`/`sb` include brightness and segment bounds, so the preset reproduces the
 * look exactly rather than only the effect and colours.
 */
export const savePreset = (host, slot, name) =>
  setState(host, { psave: Number(slot), n: String(name), ib: true, sb: true });

/** Reachability probe used by the status poller. */
export async function ping(host) {
  try {
    const info = await getInfo(host);
    return { online: true, name: info.name, leds: info.leds?.count ?? null, version: info.ver };
  } catch (err) {
    return { online: false, error: err.message };
  }
}
