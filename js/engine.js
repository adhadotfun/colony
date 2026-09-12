/**
 * C. elegans connectome engine, browser port.
 *
 * Ported from the published spec of the robiworm reference implementation and
 * driven by the OpenWorm c302 connectome table (White et al. 1986).
 *
 * Everything is deterministic: no Math.random, no Date.now, no ambient state.
 */

// --- model constants --------------------------------------------------------
export const THRESHOLD = 30;
export const MAX_IDLE = 10;
export const BODY_NORM_SCALE = 255;
export const BODY_NORM_DIVISOR = 600;
export const NECK_GAIN = 6;
export const EMA_WINDOW = 15;
export const REVERSE_THRESHOLD = 19.0;
const UINT16_MAX = 65535;

// --- connectome -------------------------------------------------------------

export let connectome = null;

const pad = (n) => String(n).padStart(2, '0');
const range = (prefix, from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${pad(from + i)}`);

export const GROUPS = {};

export async function loadConnectome(url = './data/connectome.json') {
  return initConnectome(await (await fetch(url)).json());
}

/** Node path: caller reads the JSON itself, no fetch involved. */
export function initConnectome(raw) {
  const cells = raw.cells;
  connectome = {
    cells,
    neuronCount: raw.neuronCount,
    muscleCount: raw.muscleCount,
    cellCount: raw.cellCount,
    connectionCount: raw.connectionCount,
    provenance: raw.provenance,
    offsets: Int32Array.from(raw.offsets),
    targets: Uint16Array.from(raw.targets),
    weights: Int8Array.from(raw.weights),
    idOf: new Map(cells.map((n, i) => [n, i])),
  };

  const ids = (names) =>
    Uint16Array.from(
      names.map((n) => {
        const id = connectome.idOf.get(n);
        if (id === undefined) throw new Error(`unknown cell: ${n}`);
        return id;
      }),
    );

  Object.assign(GROUPS, {
    CHEMOTAXIS: ids(['ADFL', 'ADFR', 'ASGR', 'ASGL', 'ASIL', 'ASIR', 'ASJR', 'ASJL']),
    NOSE_TOUCH: ids([
      'FLPR', 'FLPL', 'ASHL', 'ASHR', 'IL1VL', 'IL1VR', 'OLQDL', 'OLQDR', 'OLQVR', 'OLQVL',
    ]),
    CHEMOTAXIS_LEFT: ids(['ADFL', 'ASGL', 'ASIL', 'ASJL']),
    CHEMOTAXIS_RIGHT: ids(['ADFR', 'ASGR', 'ASIR', 'ASJR']),
    NOSE_TOUCH_LEFT: ids(['FLPL', 'ASHL', 'IL1VL', 'OLQDL', 'OLQVL']),
    NOSE_TOUCH_RIGHT: ids(['FLPR', 'ASHR', 'IL1VR', 'OLQDR', 'OLQVR']),
    LEFT_NECK_MUSCLE: ids([...range('MDL', 5, 8), ...range('MVL', 5, 8)]),
    RIGHT_NECK_MUSCLE: ids([...range('MDR', 5, 8), ...range('MVR', 5, 8)]),
    LEFT_BODY_MUSCLE: ids([...range('MDL', 9, 23), ...range('MVL', 9, 23)]),
    RIGHT_BODY_MUSCLE: ids([...range('MDR', 9, 23), ...range('MVR', 9, 23)]),
    MOTOR_A: ids([
      ...Array.from({ length: 9 }, (_, i) => `DA${i + 1}`),
      ...Array.from({ length: 12 }, (_, i) => `VA${i + 1}`),
    ]),
  });

  return connectome;
}

// --- state ------------------------------------------------------------------

export function createState() {
  const n = connectome.neuronCount;
  const m = connectome.muscleCount;
  return {
    neuronCurrent: new Int8Array(n),
    neuronNext: new Int8Array(n),
    muscleCurrent: new Int16Array(m),
    muscleNext: new Int16Array(m),
    meta: new Uint8Array(n),
    motorFireAvg: 0,
    leftMuscle: 0,
    rightMuscle: 0,
  };
}

export function cloneState(s) {
  return {
    neuronCurrent: s.neuronCurrent.slice(),
    neuronNext: s.neuronNext.slice(),
    muscleCurrent: s.muscleCurrent.slice(),
    muscleNext: s.muscleNext.slice(),
    meta: s.meta.slice(),
    motorFireAvg: s.motorFireAvg,
    leftMuscle: s.leftMuscle,
    rightMuscle: s.rightMuscle,
  };
}

// --- cell access ------------------------------------------------------------

function getCurrent(s, id) {
  const N = connectome.neuronCount;
  return id < N ? s.neuronCurrent[id] : s.muscleCurrent[id - N];
}

function getNext(s, id) {
  const N = connectome.neuronCount;
  return id < N ? s.neuronNext[id] : s.muscleNext[id - N];
}

/** Neurons saturate at int8 bounds. Muscles are int16 and wrap natively. */
function setNext(s, id, value) {
  const N = connectome.neuronCount;
  if (id < N) {
    s.neuronNext[id] = value > 127 ? 127 : value < -128 ? -128 : value;
  } else {
    s.muscleNext[id - N] = value;
  }
}

function addToNext(s, id, delta) {
  setNext(s, id, getNext(s, id) + delta);
}

// --- neural cycle -----------------------------------------------------------

function pingCell(s, id) {
  const { offsets, targets, weights } = connectome;
  const end = offsets[id + 1];
  for (let j = offsets[id]; j < end; j++) addToNext(s, targets[j], weights[j]);
}

function handleIdleCells(s) {
  const N = connectome.neuronCount;
  for (let i = 0; i < N; i++) {
    const high = s.meta[i] & 0b1000_0000;
    let idle = s.meta[i] & 0b0111_1111;

    if (getNext(s, i) === getCurrent(s, i)) {
      s.meta[i] = s.meta[i] + 1;
      idle += 1;
    } else {
      s.meta[i] = high;
    }

    if (idle > MAX_IDLE) {
      setNext(s, i, 0);
      s.meta[i] = high;
    }
  }
}

function neuralCycle(s, stimulus) {
  const N = connectome.neuronCount;
  for (let i = 0; i < stimulus.length; i++) pingCell(s, stimulus[i]);

  for (let i = 0; i < N; i++) {
    const fired = getCurrent(s, i) > THRESHOLD;
    if (fired) {
      pingCell(s, i);
      setNext(s, i, 0);
    }
    s.meta[i] = fired ? 0b1000_0000 : s.meta[i] & 0b0111_1111;
  }

  handleIdleCells(s);

  s.neuronCurrent.set(s.neuronNext);
  s.muscleCurrent.set(s.muscleNext);
  s.muscleNext.fill(0);
}

// --- muscle aggregation -----------------------------------------------------

function sumClampedAtZero(s, ids) {
  let total = 0;
  for (let i = 0; i < ids.length; i++) {
    const v = getCurrent(s, ids[i]);
    if (v > 0) total += v;
  }
  return total;
}

function aggregateMuscles(s) {
  const bodyTotal = Math.min(
    sumClampedAtZero(s, GROUPS.LEFT_BODY_MUSCLE) + sumClampedAtZero(s, GROUPS.RIGHT_BODY_MUSCLE),
    UINT16_MAX,
  );
  const normBody = Math.min(
    Math.trunc((BODY_NORM_SCALE * bodyTotal) / BODY_NORM_DIVISOR),
    UINT16_MAX,
  );

  const leftNeck = Math.min(sumClampedAtZero(s, GROUPS.LEFT_NECK_MUSCLE), UINT16_MAX);
  const rightNeck = Math.min(sumClampedAtZero(s, GROUPS.RIGHT_NECK_MUSCLE), UINT16_MAX);

  // Contralateral: the weaker neck side receives the gain.
  const neck = leftNeck - rightNeck;
  const boosted = NECK_GAIN * Math.abs(neck) + normBody;
  let left = neck < 0 ? boosted : normBody;
  let right = neck < 0 ? normBody : boosted;

  let fired = 0;
  for (let i = 0; i < GROUPS.MOTOR_A.length; i++) fired += s.meta[GROUPS.MOTOR_A[i]] >>> 7;
  const firingPercent = (100 * fired) / GROUPS.MOTOR_A.length;
  s.motorFireAvg = (firingPercent + EMA_WINDOW * s.motorFireAvg) / (EMA_WINDOW + 1);

  if (s.motorFireAvg > REVERSE_THRESHOLD) {
    left = -left;
    right = -right;
  }

  s.leftMuscle = left;
  s.rightMuscle = right;
}

/** Advance one tick in place. */
export function stepInPlace(s, stimulus) {
  neuralCycle(s, stimulus);
  aggregateMuscles(s);
  return s;
}

// --- movement ---------------------------------------------------------------

export function movement(leftMuscle, rightMuscle) {
  return {
    angle: (rightMuscle - leftMuscle) / 2,
    magnitude: (rightMuscle + leftMuscle) / 2,
  };
}

function wrapDegrees(degrees) {
  const wrapped = degrees % 360;
  if (wrapped < 0) return wrapped + 360;
  return wrapped === 0 ? 0 : wrapped;
}

export function createPosition() {
  return { x: 0, y: 0, direction: 0 };
}

export function stepPosition(position, { angle, magnitude }) {
  const direction = wrapDegrees(position.direction + angle);
  const radians = (direction * Math.PI) / 180;
  const dx = magnitude * Math.cos(radians);
  const dy = magnitude * Math.sin(radians);
  return { position: { x: position.x + dx, y: position.y + dy, direction }, dx, dy };
}

// --- prng: xorshift128 seeded via splitmix32 --------------------------------

function splitmix32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 0x85ebca6b) >>> 0;
    t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35) >>> 0;
    return (t ^= t >>> 16) >>> 0;
  };
}

export class Xorshift128 {
  constructor(seed) {
    this.s = new Uint32Array(4);
    const mix = splitmix32(seed | 0);
    for (let i = 0; i < 4; i++) this.s[i] = mix();
    if (this.s.every((w) => w === 0)) this.s[0] = 1;
  }

  next() {
    const s = this.s;
    let t = s[3];
    const s0 = s[0];
    s[3] = s[2];
    s[2] = s[1];
    s[1] = s0;
    t ^= t << 11;
    t ^= t >>> 8;
    s[0] = (t ^ s0 ^ (s0 >>> 19)) >>> 0;
    return s[0];
  }

  below(bound) {
    const limit = Math.floor(0x100000000 / bound) * bound;
    let v = this.next();
    while (v >= limit) v = this.next();
    return v % bound;
  }
}

// --- signal layer -----------------------------------------------------------

export const DEFAULT_SIGNAL_CONFIG = {
  warmThreshold: 2,
  maxTicks: 256,
  saturation: 0.1,
  sellSaturation: 0.01,
  hhiSaturation: 2000,
  coldTicks: 64,
};

function saturate(value, at) {
  return Math.min(Math.max(value, 0) / at, 1);
}

/** Signal -> tick budgets. Budgets scale together so their ratio survives. */
export function planStimulus(signal, config = DEFAULT_SIGNAL_CONFIG) {
  if (signal.kind === 'cold') {
    return { chemotaxisTicks: 0, noseTouchTicks: 0, rightWeight: 0, totalTicks: 0 };
  }

  let chemo = config.maxTicks * saturate(signal.growth, config.saturation);
  let nose = config.maxTicks * saturate(signal.sellPressure, config.sellSaturation);

  const total = chemo + nose;
  if (total > config.maxTicks) {
    const scale = config.maxTicks / total;
    chemo *= scale;
    nose *= scale;
  }

  const chemotaxisTicks = Math.round(chemo);
  const noseTouchTicks = Math.round(nose);
  const rightWeight = saturate(signal.hhi, config.hhiSaturation);

  return { chemotaxisTicks, noseTouchTicks, rightWeight, totalTicks: chemotaxisTicks + noseTouchTicks };
}

/** Expand a plan into the exact tick sequence. */
export function expandPlan(plan, rng) {
  const sequence = [];
  let chemoLeft = plan.chemotaxisTicks;
  let noseLeft = plan.noseTouchTicks;

  const RESOLUTION = 10_000;
  const rightCut = Math.round(plan.rightWeight * RESOLUTION);

  while (chemoLeft > 0 || noseLeft > 0) {
    const remaining = chemoLeft + noseLeft;
    const takeChemo = noseLeft === 0 || (chemoLeft > 0 && rng.below(remaining) < chemoLeft);
    const useRight = rng.below(RESOLUTION) < rightCut;

    if (takeChemo) {
      sequence.push(useRight ? GROUPS.CHEMOTAXIS_RIGHT : GROUPS.CHEMOTAXIS_LEFT);
      chemoLeft--;
    } else {
      sequence.push(useRight ? GROUPS.NOSE_TOUCH_RIGHT : GROUPS.NOSE_TOUCH_LEFT);
      noseLeft--;
    }
  }

  return sequence;
}

/** Run a full sequence, recording per-tick muscle poses and path. */
export function runSequence(state, position, sequence) {
  const frames = [];
  const path = [{ x: position.x, y: position.y }];
  let pos = position;

  for (const stim of sequence) {
    stepInPlace(state, stim);
    const out = stepPosition(pos, movement(state.leftMuscle, state.rightMuscle));
    pos = out.position;
    frames.push({
      muscles: state.muscleCurrent.slice(),
      left: state.leftMuscle,
      right: state.rightMuscle,
      motorFireAvg: state.motorFireAvg,
      x: pos.x,
      y: pos.y,
      direction: pos.direction,
    });
    path.push({ x: pos.x, y: pos.y });
  }

  return { frames, path, position: pos, state };
}

/** Path efficiency: net displacement over path length. 1 straight, 0 closed loop. */
export function pathEfficiency(path) {
  if (path.length < 2) return 0;
  let length = 0;
  for (let i = 1; i < path.length; i++) {
    length += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  if (length === 0) return 0;
  const net = Math.hypot(
    path[path.length - 1].x - path[0].x,
    path[path.length - 1].y - path[0].y,
  );
  return net / length;
}
