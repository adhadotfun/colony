/**
 * COLONY front end.
 *
 * The reference instrument watched a single token. COLONY runs the same
 * nervous system over a whole cohort: every hour, every token in the set gets
 * an identical 256 tick budget, and how far the worm actually travels is the
 * readout. This page replays that 48 hour window from out/feed_v3.json.
 *
 * Nothing here is simulated for show. The trajectory you see is the engine
 * re-running the exact tick plan the back-test scored.
 */
import {
  initConnectome, connectome, GROUPS, THRESHOLD,
  createState, createPosition, Xorshift128,
  expandPlan, stepInPlace, movement, stepPosition,
} from './engine.js';
import { createBrain, loadLayout, GROUP_COLOR, GROUP_ORDER } from './brain.js';

const $ = (id) => document.getElementById(id);
const PAPER = '#faf9f6';
const INK = '#16150f';
const INK3 = '#726f64';
const RULE = '#dedbd2';
const GRID_MINOR = '#eeebe2';
const GRID_MAJOR = '#dedbd0';
const ZOOM_MIN = 0.002;   // ~3 decades out: the lattice keeps restacking all the way
const ZOOM_MAX = 40;
const ACCENT = '#e5372c';
const CLASS_COLOR = { chemo: '#7a6a3c', mech: '#7a3c3c', motor: '#3c5a7a', inter: '#8a8578' };

const state = {
  feed: null,
  headBlock: 0,
  epoch: 0,
  token: null,      // sticky: keep driving the same token across hours when it survives
  entry: null,
  seq: [],
  tick: 0,
  path: [],
  sim: null,
  pos: null,
  fired: new Set(),
  cam: 'fit',
  zoom: 1,
  zoomTo: 1,          // wheel and buttons move this; zoom eases toward it
  zoomAt: { x: 0, y: 0 }, // cursor anchor, relative to canvas centre
  offset: { x: 0, y: 0 },
  cells: [],
  drag: null,
};

// --- helpers -----------------------------------------------------------------

const num = (v, d = 0) => (v == null ? '···' : Number(v).toLocaleString('en-US', {
  minimumFractionDigits: d, maximumFractionDigits: d,
}));

/** Base produces a block roughly every 2s, so block delta converts to wall clock. */
function blockTime(block) {
  const genMs = Date.parse(state.feed.source.generated_utc);
  return new Date(genMs - (state.headBlock - block) * 2000);
}

const stamp = (d) => d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

function setRow(id, text) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('row__v--null', text === '···');
}

// --- cell layout -------------------------------------------------------------

/**
 * Cell positions are no longer invented here. They are read from
 * data/cell_layout.json, which carries the real C. elegans atlas coordinates
 * for all 299 neurons plus the 98 body wall muscles, in connectome cell order.
 * See js/brain.js for the projection.
 */

// --- cohort ------------------------------------------------------------------

/** Tokens that actually ran this hour, best path efficiency first. */
function ranked(epochIdx) {
  const ep = state.feed.epochs[epochIdx];
  if (!ep) return [];
  return ep.entries
    .filter((e) => e.path_efficiency !== null && e.rank != null)
    .sort((a, b) => a.rank - b.rank);
}

function loadEpoch(idx) {
  const list = ranked(idx);
  if (!list.length) return;
  state.epoch = idx;

  // keep the user's chosen token if it still trades this hour, else take the leader
  const keep = state.token && list.find((e) => e.token === state.token);
  const entry = keep || list[0];
  state.token = entry.token;
  state.entry = entry;

  state.sim = createState();
  state.pos = createPosition();
  state.path = [{ x: 0, y: 0 }];
  state.tick = 0;
  state.fired = new Set();
  state.offset = { x: 0, y: 0 };
  state.seq = expandPlan(entry.plan, new Xorshift128(state.feed.epochs[idx].seed));

  paintPlate();
  paintRail(list);
  paintBrainLine();
}

function driveToken(tokenAddr) {
  state.token = tokenAddr;
  loadEpoch(state.epoch);
}

// --- plate -------------------------------------------------------------------

function paintPlate() {
  const e = state.entry;
  const src = state.feed.source;

  // this is a replay of a fixed window, not a live feed. say so.
  const status = $('status');
  status.classList.remove('status--live', 'status--idle');
  status.classList.add(e.confidence === 'cold' ? 'status--idle' : 'status--live');
  $('status-text').textContent = `replay · ${e.confidence}`;

  $('contract-sym').textContent = e.symbol || 'TOKEN';
  $('contract-addr').textContent = `${e.token.slice(0, 8)}…${e.token.slice(-6)}`;
  $('contract').title = `${e.token} (click to copy)`;

  $('legend-block').textContent = `#${num(e.block)}`;
  $('legend-tag').textContent = `rank ${e.rank}`;
  $('legend-time').textContent = `${stamp(blockTime(e.block))} · ${src.epoch_wallclock} window · ${src.chain}`;

  setRow('v-holders', num(e.holder_count));
  setRow('v-new', `+${num(e.new_holders)}`);
  setRow('v-sells', num(e.exits));
  setRow('v-hhi', e.hhi == null ? '···' : num(e.hhi));
  setRow('v-gini', e.gini == null ? '···' : Number(e.gini).toFixed(3));
  setRow('v-ticks', `${num(e.budget_used)} / 256`);
  setRow('v-eff', e.path_efficiency == null ? '···' : Number(e.path_efficiency).toFixed(3));

  const seedHex = (state.feed.epochs[state.epoch].seed >>> 0).toString(16).padStart(8, '0');
  $('h-seed').textContent = `0x${seedHex}`;
  $('h-root').textContent = state.feed.cohort_root;
  $('h-block').textContent = num(e.block);

  $('ep-read').textContent = `hour ${state.epoch + 1} / ${state.feed.n_epochs}`;
  $('brain-sub').textContent =
    `${connectome.neuronCount} neurons · ${num(connectome.connectionCount)} connections · ${connectome.cells.length} cells`;
}

function paintRail(list) {
  const box = $('rail-list');
  box.textContent = '';
  $('rail-count').textContent = `${list.length} tokens`;

  for (const e of list) {
    const b = document.createElement('button');
    b.className = 'tk';
    b.setAttribute('aria-current', String(e.token === state.token));
    b.onclick = () => driveToken(e.token);

    const r = document.createElement('span');
    r.className = 'tk__rank'; r.textContent = String(e.rank);
    const s = document.createElement('span');
    s.className = 'tk__sym'; s.textContent = e.symbol || e.token.slice(0, 10);
    const v = document.createElement('span');
    v.className = 'tk__eff'; v.textContent = Number(e.path_efficiency).toFixed(3);

    b.append(r, s, v);
    box.append(b);
  }
}

function paintBrainLine() {
  const e = state.entry;
  const el = $('brain-line');
  el.classList.remove('brain__line--null');

  const food = e.plan.chemotaxisTicks;
  const pull = e.plan.noseTouchTicks;
  const bias = Math.round(e.plan.rightWeight * 100);

  let lean;
  if (food === pull && food >= 120) lean = 'both inputs saturated, so the two drives cancel';
  else if (food === pull) lean = 'the two drives cancel';
  else if (food > pull) lean = 'net forward';
  else lean = 'net backing away';

  el.textContent = `${e.symbol || 'this token'}: ${e.new_holders} new holders fired ${food} food ticks, `
    + `${e.exits} sells fired ${pull} withdrawal ticks, concentration set a ${bias}% right turn bias. `
    + `${lean}. tick ${state.tick} of ${state.seq.length}.`;
}

// --- canvases ----------------------------------------------------------------

function fitCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

function viewTransform(w, h) {
  const path = state.path;
  let scale = 6 * state.zoom;
  let cx = 0, cy = 0;

  if (state.cam === 'fit' && path.length > 1) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of path) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    const pad = 90;
    scale = Math.min((w - pad * 2) / Math.max(x1 - x0, 1), (h - pad * 2) / Math.max(y1 - y0, 1));
    scale = Math.max(0.05, Math.min(scale, 60)) * state.zoom;
    cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
  } else if (state.cam === 'follow' && path.length) {
    // derive the follow scale from the path extent so the trail stays on canvas
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of path) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    const pad = 90;
    const fit = Math.min((w - pad * 2) / Math.max(x1 - x0, 1), (h - pad * 2) / Math.max(y1 - y0, 1));
    scale = Math.max(0.05, Math.min(fit * 1.6, 60)) * state.zoom;
    const p = path[path.length - 1];
    cx = p.x; cy = p.y;
  }
  return { scale, cx: cx - state.offset.x / scale, cy: cy - state.offset.y / scale };
}

/**
 * Infinite graph paper. The world step is chosen from a 1/2/5 ladder so the
 * on-screen spacing always lands in a readable band, and two levels are drawn
 * at once: as you zoom out the fine level fades away exactly while the coarse
 * level takes over, so the lattice restacks instead of vanishing.
 */
function drawGrid(ctx, w, h, scale, cx, cy) {
  const WANT = 110;                                 // px: preferred cell size
  const MIN  = 72;                                  // px: never tighter than this

  // Decade ladder with 1/2/5/10 mantissas. Pick the smallest step whose
  // on-screen size clears MIN, so the cell always sits in roughly 72..180px.
  // Zoom out far enough and the step jumps a rung: the old cells merge into a
  // new coarser lattice covering the same paper, which is the restack.
  const base = Math.pow(10, Math.floor(Math.log10(WANT / scale)));
  let step = 10 * base;
  for (const m of [1, 2, 5, 10]) {
    if (m * base * scale >= MIN) { step = m * base; break; }
  }

  // World bounds of the viewport, so we iterate real coordinates rather than
  // screen offsets. That is what keeps labels honest and lines exactly aligned
  // to the unit lattice no matter how far the camera has travelled.
  const wl = cx - (w / 2) / scale, wr = cx + (w / 2) / scale;
  const wt = cy - (h / 2) / scale, wb = cy + (h / 2) / scale;
  const sx = (x) => w / 2 + (x - cx) * scale;
  const sy = (y) => h / 2 + (y - cy) * scale;

  const x0 = Math.floor(wl / step) * step, y0 = Math.floor(wt / step) * step;
  const majorEvery = step * 5;
  const isMajor = (v) => Math.abs(v / majorEvery - Math.round(v / majorEvery)) < 1e-6;

  ctx.save();
  ctx.lineWidth = 1;

  // two passes so every line is drawn at full opacity in its own colour: no
  // alpha crossfade, nothing ever half present, nothing to "disappear"
  for (const major of [false, true]) {
    ctx.strokeStyle = major ? GRID_MAJOR : GRID_MINOR;
    ctx.beginPath();
    for (let x = x0; x <= wr; x += step) {
      if (isMajor(x) !== major) continue;
      const p = Math.round(sx(x)) + 0.5;
      ctx.moveTo(p, 0); ctx.lineTo(p, h);
    }
    for (let y = y0; y <= wb; y += step) {
      if (isMajor(y) !== major) continue;
      const p = Math.round(sy(y)) + 0.5;
      ctx.moveTo(0, p); ctx.lineTo(w, p);
    }
    ctx.stroke();
  }

  // unit readout at every major intersection, so the paper is a measuring
  // surface and not just texture: you can see the scale you are looking at
  ctx.fillStyle = INK3;
  ctx.globalAlpha = 0.72;
  ctx.font = '9px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const dec = step < 1 ? Math.min(6, Math.ceil(-Math.log10(step))) : 0;
  const fmt = (v) => {
    const n = Math.abs(v) < step / 2 ? 0 : v;
    return n.toFixed(dec);
  };
  const mx0 = Math.floor(wl / majorEvery) * majorEvery;
  const my0 = Math.floor(wt / majorEvery) * majorEvery;
  for (let x = mx0; x <= wr; x += majorEvery) {
    for (let y = my0; y <= wb; y += majorEvery) {
      ctx.fillText(`${fmt(x)}, ${fmt(y)}`, sx(x) + 5, sy(y) + 4);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawStage() {
  const cv = $('stage-canvas');
  const { ctx, w, h } = fitCanvas(cv);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);

  const { scale, cx, cy } = viewTransform(w, h);
  const px = (p) => w / 2 + (p.x - cx) * scale;
  const py = (p) => h / 2 + (p.y - cy) * scale;

  drawGrid(ctx, w, h, scale, cx, cy);

  const path = state.path;
  if (path.length > 1) {
    // straight line from origin to head: the denominator of path efficiency
    const head = path[path.length - 1];
    ctx.strokeStyle = INK3;
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px(path[0]), py(path[0]));
    ctx.lineTo(px(head), py(head));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(px(path[0]), py(path[0]));
    for (let i = 1; i < path.length; i++) ctx.lineTo(px(path[i]), py(path[i]));
    ctx.stroke();

    ctx.fillStyle = INK3;
    ctx.beginPath(); ctx.arc(px(path[0]), py(path[0]), 3, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = ACCENT;
    ctx.beginPath(); ctx.arc(px(head), py(head), 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(px(head), py(head), 9, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const units = Math.max(1, Math.round(100 / scale));
  $('scale-units').textContent = String(units);
  $('scale-bar').style.width = `${Math.round(units * scale)}px`;
}

function paintLegend() {
  const box = $('brain-legend');
  if (!box) return;
  box.textContent = '';
  for (const g of GROUP_ORDER) {
    const s = document.createElement('span');
    s.className = 'brain__leg';
    const d = document.createElement('span');
    d.className = 'brain__dot';
    d.style.background = GROUP_COLOR[g];
    s.append(d, document.createTextNode(`${g} ${state.layout.groupCounts[g]}`));
    box.append(s);
  }
  const f = document.createElement('span');
  f.className = 'brain__leg';
  const fd = document.createElement('span');
  fd.className = 'brain__dot';
  fd.style.background = ACCENT;
  f.append(fd, document.createTextNode('firing'));
  box.append(f);
}

function paintHover(cell) {
  const el = $('brain-hover');
  if (!el) return;
  if (!cell) { el.textContent = ''; return; }
  const mm = (cell.x / 1000).toFixed(3);
  el.textContent = `${cell.name} · ${cell.group} · ${mm} mm from nose${cell.firing ? ' · firing' : ''}`;
}

// --- loop --------------------------------------------------------------------

function advance() {
  if (!state.entry) return;
  if (state.tick >= state.seq.length) {
    loadEpoch((state.epoch + 1) % state.feed.n_epochs);
    return;
  }
  const stim = state.seq[state.tick];
  stepInPlace(state.sim, stim);
  const out = stepPosition(state.pos, movement(state.sim.leftMuscle, state.sim.rightMuscle));
  state.pos = out.position;
  state.path.push({ x: out.position.x, y: out.position.y });
  state.tick++;

  // cells[] is neurons 0..298 then muscles 299..396, and the engine keeps those in
  // two separate arrays. muscleCurrent[i] is cells[neuronCount + i], NOT cells[i].
  // The brain strip wants indices into cells[], so push ids, not names.
  const fired = [];
  const N = connectome.neuronCount;
  for (const id of stim) fired.push(id);

  const nc = state.sim.neuronCurrent;
  for (let i = 0; i < N; i++) if (nc[i] > THRESHOLD) fired.push(i);

  const mc = state.sim.muscleCurrent;
  for (let i = 0; i < mc.length; i++) if (mc[i] > THRESHOLD) fired.push(N + i);

  if (state.brain) state.brain.push(fired, state.tick);
  paintBrainLine();
}

/**
 * Ease the live zoom toward the requested zoom and keep the point under the
 * cursor pinned while it moves. The offset correction uses the zoom ratio,
 * which equals the scale ratio, so it holds in both fit and free camera.
 */
function easeZoom(dt) {
  const d = state.zoomTo - state.zoom;
  if (Math.abs(d) < state.zoom * 1e-4) { state.zoom = state.zoomTo; return; }
  const prev = state.zoom;
  // frame rate independent exponential approach: the same physical glide on a
  // 60Hz and a 144Hz screen, where a flat per frame fraction would not be
  state.zoom = prev + d * (1 - Math.exp(-14 * dt));
  const r = state.zoom / prev;
  const a = state.zoomAt;
  state.offset.x = r * (state.offset.x - a.x) + a.x;
  state.offset.y = r * (state.offset.y - a.y) + a.y;
}

let last = 0;
let prevTs = 0;
function frame(ts) {
  const dt = Math.min((ts - prevTs) / 1000 || 0.016, 0.05); // clamp tab-switch gaps
  prevTs = ts;
  if (ts - last > 55) { advance(); last = ts; }
  easeZoom(dt);
  drawStage();
  if (state.brain) state.brain.draw();
  requestAnimationFrame(frame);
}

// --- controls ----------------------------------------------------------------

function wireControls() {
  const setCam = (mode) => {
    state.cam = mode;
    state.offset = { x: 0, y: 0 };
    for (const m of ['follow', 'free', 'fit']) {
      $(`cam-${m}`).setAttribute('aria-pressed', String(m === mode));
    }
  };
  $('cam-follow').onclick = () => setCam('follow');
  $('cam-free').onclick = () => setCam('free');
  $('cam-fit').onclick = () => setCam('fit');
  const nudge = (f) => {
    state.zoomAt = { x: 0, y: 0 };                  // buttons zoom about centre
    state.zoomTo = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.zoomTo * f));
  };
  $('zoom-in').onclick = () => nudge(1.35);
  $('zoom-out').onclick = () => nudge(1 / 1.35);

  const hop = (d) => {
    const n = state.feed.n_epochs;
    loadEpoch((state.epoch + d + n) % n);
  };
  $('ep-prev').onclick = () => hop(-1);
  $('ep-next').onclick = () => hop(1);

  $('contract').onclick = async () => {
    const act = document.querySelector('.contract__act');
    try {
      await navigator.clipboard.writeText(state.entry.token);
      act.textContent = 'copied';
    } catch { act.textContent = state.entry.token.slice(0, 10); }
    setTimeout(() => { act.textContent = 'copy'; }, 1400);
  };

  const cv = $('stage-canvas');
  cv.addEventListener('pointerdown', (ev) => {
    setCam('free');
    state.drag = { x: ev.clientX, y: ev.clientY };
    cv.setPointerCapture(ev.pointerId);
  });
  cv.addEventListener('pointermove', (ev) => {
    if (!state.drag) return;
    state.offset.x += ev.clientX - state.drag.x;
    state.offset.y += ev.clientY - state.drag.y;
    state.drag = { x: ev.clientX, y: ev.clientY };
  });
  cv.addEventListener('pointerup', () => { state.drag = null; });
  cv.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = cv.getBoundingClientRect();
    state.zoomAt = { x: ev.clientX - r.left - r.width / 2, y: ev.clientY - r.top - r.height / 2 };
    // continuous exponential response: zoom is proportional to how far the
    // wheel actually moved, so a trackpad glide is smooth rather than stepped
    const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
    const f = Math.pow(0.999, Math.max(-240, Math.min(240, dy)));
    state.zoomTo = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.zoomTo * f));
  }, { passive: false });

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft') hop(-1);
    if (ev.key === 'ArrowRight') hop(1);
  });
}

// --- boot --------------------------------------------------------------------

async function boot() {
  const [conn, feed] = await Promise.all([
    fetch('./data/connectome.json').then((r) => r.json()),
    fetch('./out/feed_v3.json').then((r) => r.json()),
  ]);
  initConnectome(conn);
  state.feed = feed;
  state.headBlock = Math.max(...feed.epochs.flatMap((e) => e.entries.map((x) => x.block)));

  const layout = await loadLayout('./data/cell_layout.json');
  if (layout.cells.length !== connectome.cells.length) {
    throw new Error(`layout/connectome mismatch: ${layout.cells.length} vs ${connectome.cells.length}`);
  }
  state.layout = layout;
  state.brain = createBrain($('brain-canvas'), layout, { paper: PAPER, active: ACCENT });
  state.brain.onHover(paintHover);
  paintLegend();

  wireControls();
  loadEpoch(0);
  requestAnimationFrame(frame);
}

boot().catch((err) => {
  $('status-text').textContent = 'offline';
  $('brain-line').textContent = `could not read the cohort: ${err.message}`;
});
