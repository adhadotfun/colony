/**
 * Muscle state -> body outline. Pure geometry, no drawing.
 *
 * The bend is DORSOVENTRAL, not left/right. Measured per segment on real
 * traces: L/R max 10 mean 0.21, D/V max 50 mean 4.96, so L/R renders a stick.
 * The connectome drives the body symmetrically across left/right, and the
 * animal undulates in the dorsoventral plane anyway.
 *
 *     dorsal_i  = MDL_i + MDR_i
 *     ventral_i = MVL_i + MVR_i
 *     curvature_i = (dorsal_i - ventral_i) * k
 *
 * L/R is still real, it just does a different job: it is the engine's steering
 * angle. The worm undulates to swim and steers on a slight L/R imbalance.
 *
 * MVL stops at segment 23, so segment 24's ventral side is MVR24 alone.
 */
import { connectome } from './engine.js';

export const SEGMENTS = 24;

let SEGMENT_MUSCLES = null;

const pad = (n) => String(n).padStart(2, '0');

function muscleIndex(name) {
  const id = connectome.idOf.get(name);
  if (id === undefined) throw new Error(`unknown muscle: ${name}`);
  return id - connectome.neuronCount;
}

export function initBody() {
  SEGMENT_MUSCLES = Array.from({ length: SEGMENTS }, (_, i) => {
    const n = pad(i + 1);
    return {
      mdl: muscleIndex(`MDL${n}`),
      mdr: muscleIndex(`MDR${n}`),
      mvl: i + 1 <= 23 ? muscleIndex(`MVL${n}`) : -1,
      mvr: muscleIndex(`MVR${n}`),
    };
  });
}

export const DEFAULT_BODY_OPTIONS = {
  // Calibrated against real traces. |dorsal-ventral| means 4.96, so 1.5 deg per
  // unit puts a typical segment near 7.4 deg: about one S-wave over 24 segments.
  curvatureScale: 1.5,
  // A peak segment would hit 75 deg unclamped, which draws as a hard corner.
  // 20 deg is near a real nematode's per-segment limit and leaves the mean alone.
  maxSegmentBend: 20,
  segmentLength: 13,
  // 24*13 long by 24 wide is about 13:1. A real C. elegans is roughly 12:1.
  maxHalfWidth: 12,
  smoothing: 8,
};

export function curvatures(muscles, options) {
  const limit = options.maxSegmentBend;
  return SEGMENT_MUSCLES.map(({ mdl, mdr, mvl, mvr }) => {
    const dorsal = muscles[mdl] + muscles[mdr];
    const ventral = (mvl >= 0 ? muscles[mvl] : 0) + muscles[mvr];
    const bend = (dorsal - ventral) * options.curvatureScale;
    return Math.max(-limit, Math.min(limit, bend));
  });
}

/** The left/right difference the engine steers with. Exposed, not drawn. */
export function lateralBias(muscles) {
  return SEGMENT_MUSCLES.map(({ mdl, mdr, mvl, mvr }) => {
    const left = muscles[mdl] + (mvl >= 0 ? muscles[mvl] : 0);
    const right = muscles[mdr] + muscles[mvr];
    return left - right;
  });
}

/** Centreline, head at origin along +x. Heading accumulates down the body. */
export function centreline(muscles, options) {
  const bends = curvatures(muscles, options);
  const points = [{ x: 0, y: 0 }];
  let heading = 0;
  let x = 0;
  let y = 0;

  for (const bend of bends) {
    heading += (bend * Math.PI) / 180;
    x += Math.cos(heading) * options.segmentLength;
    y += Math.sin(heading) * options.segmentLength;
    points.push({ x, y });
  }
  return points;
}

/** Catmull-Rom. Passes through every control point: each is a real boundary. */
export function smooth(points, samplesPerSegment) {
  if (points.length < 2) return [...points];
  const out = [];
  const at = (i) => points[Math.max(0, Math.min(points.length - 1, i))];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Half-width along the body. t=0 head, t=1 tail.
 * Blunt at the head, drawn to a fine point at the tail. Not a symmetric spindle.
 */
export function halfWidthAt(t, maxHalfWidth) {
  const u = Math.min(Math.max(t, 0) / 0.08, 1);
  const head = Math.sqrt(1 - (1 - u) * (1 - u));
  const tail = Math.pow(1 - Math.max(t - 0.35, 0) / 0.65, 1.25);
  return maxHalfWidth * head * Math.max(tail, 0);
}

export function outline(spine, maxHalfWidth) {
  const n = spine.length;
  if (n < 2) return [];

  const normals = spine.map((_, i) => {
    const prev = spine[Math.max(i - 1, 0)];
    const next = spine[Math.min(i + 1, n - 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: -dy / len, y: dx / len };
  });

  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const w = halfWidthAt(t, maxHalfWidth);
    const p = spine[i];
    const nm = normals[i];
    left.push({ x: p.x + nm.x * w, y: p.y + nm.y * w });
    right.push({ x: p.x - nm.x * w, y: p.y - nm.y * w });
  }
  return [...left, ...right.reverse()];
}

export function body(muscles, options = DEFAULT_BODY_OPTIONS) {
  const spine = smooth(centreline(muscles, options), options.smoothing);
  return { spine, outline: outline(spine, options.maxHalfWidth) };
}

/** Playback runs at 15 tick/s but paints at 60 fps. Without this it judders. */
export function lerpMuscles(a, b, t) {
  const out = new Int16Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.round(a[i] + (b[i] - a[i]) * t);
  return out;
}
