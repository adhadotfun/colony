/**
 * COLONY brain strip.
 *
 * Every cell sits at its real position in the worm. The coordinates come from
 * the C. elegans cell atlas (data/cell_layout.json): x runs nose to tail over
 * roughly 0..800 microns, y is the dorsal/ventral axis, z is left/right. The
 * head ganglia genuinely are a dense knot in the first tenth of the body, so
 * that is what the strip shows. Nothing is scattered for looks.
 *
 * Two things make the field readable rather than a strobe:
 *   1. cells are tinted by functional group, not by whether they happen to be on
 *   2. a firing cell decays over FADE_TICKS instead of snapping off, so a wave
 *      through the cord leaves a visible trail
 *
 * The reference instrument draws 299 neurons. This draws 397: the 98 body wall
 * muscles are the row the motor neurons are actually talking to, and watching
 * the cord fire without the muscles answering tells you nothing.
 */

const FADE_TICKS = 10;
const PAD_X = 26;
const PAD_Y = 18;
const V_FILL = 0.74;
const HIT_R2 = 144;

const REST = '#d9d5c8';
const AXIS = '#c4c0b4';
const LABEL = '#726f64';

export const GROUP_COLOR = {
  chemosensory: '#7a6a3c',
  mechanosensory: '#7a3c3c',
  motor: '#3c5a7a',
  interneuron: '#8a8578',
  muscle: '#4f6b53',
};

export const GROUP_ORDER = [
  'chemosensory', 'mechanosensory', 'motor', 'interneuron', 'muscle',
];

function mix(a, b, t) {
  const x = parseInt(a.slice(1), 16);
  const y = parseInt(b.slice(1), 16);
  const r = (x >> 16 & 255) + ((y >> 16 & 255) - (x >> 16 & 255)) * t;
  const g = (x >> 8 & 255) + ((y >> 8 & 255) - (x >> 8 & 255)) * t;
  const bl = (x & 255) + ((y & 255) - (x & 255)) * t;
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(bl)})`;
}

export function createBrain(canvas, layout, opts = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');

  const paper = opts.paper || '#faf9f6';
  const active = opts.active || '#e5372c';
  const fontNum = opts.fontNum || 'ui-monospace, monospace';

  const cells = layout.cells;
  const n = cells.length;
  const b = layout.bounds;

  // last tick each cell fired, -Infinity until it ever does
  const lastFired = new Float64Array(n).fill(-1e9);
  let tick = 0;

  let pts = [];
  let lastW = -1;
  let lastH = -1;
  let hover = null;
  let onHover = () => {};

  const dpr = () => (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  const W = () => canvas.width / dpr();
  const H = () => canvas.height / dpr();

  function project() {
    const w = W() - PAD_X * 2;
    const h = H() - PAD_Y * 2;
    const cy = (b.y[0] + b.y[1]) / 2;
    const spanX = b.x[1] - b.x[0] || 1;
    const spanY = b.y[1] - b.y[0] || 1;
    const spanZ = b.z[1] - b.z[0] || 1;
    pts = cells.map((c) => ({
      x: PAD_X + ((c.x - b.x[0]) / spanX) * w,
      y: PAD_Y + h / 2 - ((c.y - cy) / spanY) * h * V_FILL,
      // left/right depth, used only to separate overlapping pairs by weight
      d: (c.z - b.z[0]) / spanZ,
    }));
  }

  function fit() {
    const r = dpr();
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * r));
    canvas.height = Math.max(1, Math.round(rect.height * r));
    lastW = -1;
  }

  /**
   * Feed the strip one simulation tick.
   * `firedIds` is any iterable of cell indices that crossed threshold.
   */
  function push(firedIds, t) {
    tick = t;
    for (const id of firedIds) {
      if (id >= 0 && id < n) lastFired[id] = t;
    }
  }

  function reset() {
    lastFired.fill(-1e9);
    tick = 0;
  }

  function intensity(i) {
    const age = tick - lastFired[i];
    if (age < 0 || age > FADE_TICKS) return 0;
    return 1 - age / FADE_TICKS;
  }

  function draw() {
    const w = W();
    const h = H();
    if (w !== lastW || h !== lastH) { lastW = w; lastH = h; project(); }

    ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, w, h);

    // body axis
    const mid = PAD_Y + (h - PAD_Y * 2) / 2;
    ctx.strokeStyle = AXIS;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_X, mid);
    ctx.lineTo(w - PAD_X, mid);
    ctx.stroke();

    ctx.fillStyle = LABEL;
    ctx.font = `9px ${fontNum}`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText('nose', PAD_X, h - 5);
    ctx.textAlign = 'right';
    ctx.fillText('tail', w - PAD_X, h - 5);
    ctx.textAlign = 'left';

    // resting pass, then firing pass on top
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const t = intensity(i);
        const on = t > 0.001;
        if (pass === 0 ? on : !on) continue;

        const p = pts[i];
        const g = GROUP_COLOR[cells[i].group] || GROUP_COLOR.interneuron;

        if (on) {
          ctx.globalAlpha = 0.35 + 0.65 * t;
          ctx.fillStyle = mix(g, active, t);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2 + 3.4 * t, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = mix(REST, g, 0.55);
          ctx.beginPath();
          ctx.arc(p.x, p.y, cells[i].kind === 'muscle' ? 1.3 : 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    if (hover != null) {
      const p = pts[hover];
      ctx.strokeStyle = '#16150f';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function pick(mx, my) {
    let best = null;
    let bd = HIT_R2;
    for (let i = 0; i < n; i++) {
      const dx = pts[i].x - mx;
      const dy = pts[i].y - my;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  const move = (ev) => {
    const r = canvas.getBoundingClientRect();
    const hit = pick(ev.clientX - r.left, ev.clientY - r.top);
    if (hit !== hover) {
      hover = hit;
      canvas.style.cursor = hit == null ? 'default' : 'pointer';
      onHover(hit == null ? null : { ...cells[hit], id: hit, firing: intensity(hit) > 0.001 });
    }
  };
  const leave = () => { if (hover != null) { hover = null; onHover(null); } };

  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseleave', leave);
  window.addEventListener('resize', fit);

  fit();
  project();

  return {
    push,
    reset,
    draw,
    fit,
    /** live count of cells with any residual activity, per group */
    counts() {
      const out = {};
      for (const g of GROUP_ORDER) out[g] = 0;
      for (let i = 0; i < n; i++) {
        if (lastFired[i] === tick) out[cells[i].group]++;
      }
      return out;
    },
    onHover(fn) { onHover = fn; },
    destroy() {
      canvas.removeEventListener('mousemove', move);
      canvas.removeEventListener('mouseleave', leave);
      window.removeEventListener('resize', fit);
    },
  };
}

export async function loadLayout(url = 'data/cell_layout.json') {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`cell_layout: ${r.status}`);
  return r.json();
}
