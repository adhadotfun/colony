/**
 * COLONY: many worms, one arena, one seed epoch.
 *
 * Wraps the ported C. elegans connectome engine and turns a per-token holder
 * snapshot into a scored, recomputable record.
 *
 * Design rules, in order of importance:
 *  1. Nothing here is fitted. Every constant is inherited from the original
 *     engine calibration, not tuned against the back-test outcome. If you tune
 *     the mapping on the outcome you are not testing an oracle, you are
 *     overfitting a worm.
 *  2. Scores are RELATIVE within an epoch cohort. Absolute path efficiency
 *     means nothing on its own, which was the original design's core flaw.
 *  3. A reading with an unfilled tick budget is withheld, not shown small.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  initConnectome, createState, createPosition, Xorshift128,
  planStimulus, expandPlan, runSequence, pathEfficiency,
  DEFAULT_SIGNAL_CONFIG,
} from '../js/engine.js';

export const ENGINE_VERSION = '2.0.0';

/**
 * Budget below this many of 256 ticks means the concentration arm has not had
 * room to express. Derived from the sweep in SUCCESSOR.md section 1: at 3%
 * growth (~77 ticks) HHI 0 vs 2000 separates 0.98 vs 0.91, at 10% growth (256
 * ticks) it separates 0.97 vs 0.25. Set before seeing any back-test result.
 */
export const CONFIDENCE_MIN_BUDGET = 200;
export const CONFIDENCE_MED_BUDGET = 120;

export function loadConnectomeFromFile(path) {
  return initConnectome(JSON.parse(readFileSync(path, 'utf8')));
}

export function connectomeHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Epoch seed. Shared by every worm in the epoch so the PRNG is not a source of
 * cross-token variance: within one epoch the ONLY difference between two worms
 * is their own chain data. In production this is the finalized block hash.
 */
export function epochSeed(cohortRoot, epochIndex) {
  const h = createHash('sha256').update(`${cohortRoot}:${epochIndex}`).digest();
  return h.readUInt32BE(0);
}

/** Snapshot -> signal. The only place chain semantics meet engine semantics. */
export function deriveSignal(snap, prevSnap) {
  if (snap.holder_count < DEFAULT_SIGNAL_CONFIG.warmThreshold) return { kind: 'cold' };

  const prevHolders = prevSnap ? prevSnap.holder_count : 0;
  const growth = snap.new_holders / Math.max(prevHolders, 1);

  const supply = Number(snap.supply_held);
  const toLp = Number(snap.value_to_lp);
  const sellPressure = supply > 0 ? toLp / supply : 0;

  return {
    kind: 'warm',
    growth,
    sellPressure,
    hhi: snap.hhi == null ? 0 : snap.hhi,
  };
}

export function confidenceOf(budgetUsed, holderCount) {
  if (holderCount < 10) return 'low';
  if (budgetUsed >= CONFIDENCE_MIN_BUDGET) return 'high';
  if (budgetUsed >= CONFIDENCE_MED_BUDGET) return 'medium';
  return 'low';
}

/** Score one token for one epoch. Pure function of (snapshot, seed). */
export function scoreToken(snap, prevSnap, seed) {
  const signal = deriveSignal(snap, prevSnap);

  if (signal.kind === 'cold') {
    return {
      signal, plan: { chemotaxisTicks: 0, noseTouchTicks: 0, rightWeight: 0, totalTicks: 0 },
      path_efficiency: null, net_travel: 0, reversals: 0,
      budget_used: 0, confidence: 'cold',
    };
  }

  const plan = planStimulus(signal, DEFAULT_SIGNAL_CONFIG);
  if (plan.totalTicks === 0) {
    return {
      signal, plan, path_efficiency: null, net_travel: 0, reversals: 0,
      budget_used: 0, confidence: 'low',
    };
  }

  const rng = new Xorshift128(seed);
  const sequence = expandPlan(plan, rng);
  const result = runSequence(createState(), createPosition(), sequence);

  let reversals = 0;
  let wasRev = false;
  for (const f of result.frames) {
    const rev = f.motorFireAvg > 19.0;
    if (rev && !wasRev) reversals++;
    wasRev = rev;
  }

  return {
    signal,
    plan,
    path_efficiency: +pathEfficiency(result.path).toFixed(4),
    net_travel: Math.round(Math.hypot(result.position.x, result.position.y)),
    reversals,
    budget_used: plan.totalTicks,
    confidence: confidenceOf(plan.totalTicks, snap.holder_count),
  };
}

/** Rank within the epoch cohort, high-confidence entries only. */
export function rankEpoch(scored) {
  const eligible = scored.filter((s) => s.confidence === 'high' || s.confidence === 'medium');
  const sorted = [...eligible].sort((a, b) => b.path_efficiency - a.path_efficiency);
  sorted.forEach((s, i) => {
    s.rank = i + 1;
    s.percentile = eligible.length > 1 ? +(1 - i / (eligible.length - 1)).toFixed(3) : 1;
  });
  for (const s of scored) {
    if (s.rank === undefined) { s.rank = null; s.percentile = null; }
  }
  return scored;
}

/** Run every token for every epoch. Returns the full COLONY feed. */
export function runColony(dataset, cohortRoot) {
  const nEpochs = Math.min(...dataset.tokens.map((t) => t.snapshots.length));
  const epochs = [];

  for (let e = 0; e < nEpochs; e++) {
    const seed = epochSeed(cohortRoot, e);
    const scored = dataset.tokens.map((t) => {
      const snap = t.snapshots[e];
      const prev = e > 0 ? t.snapshots[e - 1] : null;
      const s = scoreToken(snap, prev, seed);
      return {
        token: t.token, epoch: e, block: snap.block,
        holder_count: snap.holder_count, new_holders: snap.new_holders,
        hhi: snap.hhi, gini: snap.gini,
        ...s,
      };
    });
    epochs.push({ epoch: e, seed, entries: rankEpoch(scored) });
  }

  return { engine_version: ENGINE_VERSION, cohort_root: cohortRoot, n_epochs: nEpochs, epochs };
}
