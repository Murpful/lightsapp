// Records what a controller is ACTUALLY outputting, by tapping WLED's live-view
// WebSocket. Sending {"lv":true} makes the device stream binary frames of real
// per-LED colour, which is the only way to preview an effect faithfully --
// reimplementing 190 WLED effects in JS was never going to match.

const SWATCHES = 48; // resolution we store per frame; plenty for a 46px strip

/**
 * Frame layout, established by streaming known solid colours to a controller
 * and reading the bytes back:
 *
 *   [0]='L' [1]=version [2..3]=LED count [4],[5]=flags [6]=preset id
 *   [7]=brightness   then RGB triplets
 *
 * The header is EIGHT bytes. It was first read as six because
 * `(length - 6) % 3 === 0` held -- which is true for any header that is a
 * multiple of three, so the check appeared to confirm the wrong offset. Two
 * bytes early rotates every channel and a red strip decodes as cyan.
 *
 * The last LED is two bytes short, so the count is floored.
 */
const LIVE_HEADER = 8;

export function decodeFrame(buf) {
  if (!buf?.length || buf[0] !== 0x4c /* 'L' */) return null;
  const bytes = buf.length - LIVE_HEADER;
  if (bytes < 3) return null;
  const chosen = { header: LIVE_HEADER, count: Math.floor(bytes / 3) };
  if (chosen.count < 1) return null;

  // Average each bucket rather than point-sampling, so a single bright pixel in
  // a sparse effect still shows up in the preview instead of being skipped.
  const out = [];
  const per = chosen.count / SWATCHES;
  for (let s = 0; s < SWATCHES; s++) {
    const from = Math.floor(s * per);
    const to = Math.max(from + 1, Math.floor((s + 1) * per));
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = from; i < to && i < chosen.count; i++) {
      const o = chosen.header + i * 3;
      r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; n++;
    }
    if (!n) { out.push('#000000'); continue; }
    const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
    out.push(`#${hex(r)}${hex(g)}${hex(b)}`);
  }
  return out;
}

/**
 * Collects up to `frames` live frames from one controller.
 * Always resolves -- a controller that is offline or refuses the socket simply
 * yields no frames rather than failing the capture of its siblings.
 */
export function captureDevice(host, { frames = 20, timeout = 6000 } = {}) {
  return new Promise((resolve) => {
    const out = [];
    let ws;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already gone */ }
      resolve(out);
    };
    const timer = setTimeout(finish, timeout);

    try {
      ws = new WebSocket(`ws://${host}/ws`);
    } catch {
      return finish();
    }
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => ws.send(JSON.stringify({ lv: true })));
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') return; // the state JSON, not a frame
      const px = decodeFrame(new Uint8Array(ev.data));
      if (px) out.push(px);
      if (out.length >= frames) finish();
    });
    ws.addEventListener('error', finish);
    ws.addEventListener('close', finish);
  });
}

/** Captures every controller a scene touches, concurrently. */
export async function captureScene(scene, devices, opts) {
  const targets = Object.keys(scene.entries ?? {});
  const results = await Promise.all(
    targets.map(async (devId) => {
      const dev = devices.find((d) => d.id === devId);
      if (!dev) return [devId, null];
      return [devId, await captureDevice(dev.host, opts)];
    })
  );
  const out = {};
  for (const [devId, frames] of results) if (frames?.length) out[devId] = frames;
  return out;
}
