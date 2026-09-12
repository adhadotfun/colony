/**
 * COLONY back-test, v3 cohort (live Base mid-cap universe, 48 hourly epochs).
 *
 * Two arms are scored on identical rows so the comparison is like for like:
 *
 *   arm A  the shipped mapping. growth sets the tick budget AND competes with
 *          sell pressure for the chemotaxis share. On the v1 dead cohort this
 *          arm turned out to be a growth proxy (rho +0.975 with raw growth).
 *
 *   arm B  the ablation. budget pinned at a constant 256 ticks so it cannot
 *          confound, sell pressure sets the chemotaxis / nose mix, HHI sets the
 *          left / right bias, growth removed entirely.
 *
 * v3 SIGNAL ADAPTER, and why it is not identical to v1.
 * The v1 ingest recorded `value_to_lp` (token value moving to the LP pair) and
 * derived sell pressure as a fraction of supply, saturating at 0.01. The v3
 * ingest does not carry that field; it carries per-epoch `entries` / `exits`
 * (holders whose balance rose / fell). So v3 sell pressure is an EXIT RATE:
 *
 *     growth = new_holders / prev_holders      saturating at 0.10
 *     sell   = exits       / prev_holders      saturating at 0.50
 *
 * Both are scale-free against the holder base, which makes them symmetric.
 * The saturation knees are set from the observed v3 distribution, not carried
 * over blind: growth median 0.034 / p75 0.115 (knee 0.10), exit rate median
 * 0.194 / p75 0.535 (knee 0.50). Reusing v1's 0.01 sell knee would peg roughly
 * 85% of v3 rows at maximum and destroy the input's variance.
 * This means v3 sell pressure measures holder churn, NOT value flowing to the
 * pool. It is a different quantity with the same name and the write-up says so.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initConnectome, createState, createPosition, Xorshift128,
  planStimulus, expandPlan, runSequence, pathEfficiency, DEFAULT_SIGNAL_CONFIG,
} from '../js/engine.js';
import { epochSeed } from './colony.mjs';
import { spearman, permutationP, bootstrapCI, median, mean } from './stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '../data');
const OUT = resolve(HERE, '../out');

const HORIZONS = [3, 7, 14];
const SCORING_EPOCHS = 30;
const MIN_HOLDERS = 10;
const CFG = DEFAULT_SIGNAL_CONFIG;
const GROWTH_KNEE = 0.10;
const EXIT_KNEE = 0.50;

const sat = (v, at) => Math.min(Math.max(v, 0) / at, 1);

/** v3 snapshot pair -> signal. Returns null when the token is too small to read. */
function deriveSignalV3(snap, prev) {
  if (!snap || snap.holder_count < MIN_HOLDERS) return null;
  const base = Math.max(prev ? prev.holder_count : snap.holder_count, 1);
  return {
    kind: 'warm',
    growth: (snap.new_holders || 0) / base,
    sellPressure: (snap.exits || 0) / base,
    hhi: snap.hhi == null ? 0 : snap.hhi,
  };
}

/** arm A: shipped mapping, growth drives budget and share. */
function planFull(signal) {
  return planStimulus(
    { kind: 'warm', growth: signal.growth, sellPressure: signal.sellPressure, hhi: signal.hhi },
    { ...CFG, saturation: GROWTH_KNEE, sellSaturation: EXIT_KNEE },
  );
}

/** arm B: constant budget, no growth term anywhere. */
function planNoGrowth(signal) {
  const nose = Math.round(CFG.maxTicks * sat(signal.sellPressure, EXIT_KNEE));
  return {
    chemotaxisTicks: CFG.maxTicks - nose,
    noseTouchTicks: nose,
    rightWeight: sat(signal.hhi, CFG.hhiSaturation),
    totalTicks: CFG.maxTicks,
  };
}

function runPlan(plan, seed) {
  if (!plan || plan.totalTicks === 0) return null;
  const rng = new Xorshift128(seed);
  const r = runSequence(createState(), createPosition(), expandPlan(plan, rng));
  return +pathEfficiency(r.path).toFixed(4);
}

function forwardHolderChange(snaps, e, k) {
  const a = snaps[e], b = snaps[e + k];
  if (!a || !b || a.holder_count < MIN_HOLDERS) return null;
  return (b.holder_count - a.holder_count) / a.holder_count;
}

function clusterBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return [...m.values()];
}

function corr(rows, field, sign = 1) {
  const usable = rows.filter((r) => r[field] !== null && Number.isFinite(r[field]));
  if (usable.length < 20) return null;
  const xs = usable.map((r) => sign * r[field]);
  const ys = usable.map((r) => r.fwd);
  const rho = spearman(xs, ys);
  if (rho === null) return null;
  const ci = bootstrapCI(
    clusterBy(usable, 'token'),
    (rs) => spearman(rs.map((r) => sign * r[field]), rs.map((r) => r.fwd)),
  );
  return {
    field: sign < 0 ? `-${field}` : field,
    n: usable.length,
    tokens: new Set(usable.map((r) => r.token)).size,
    spearman: +rho.toFixed(3),
    p_permutation: +permutationP(xs, ys, 5000).toFixed(4),
    ci95_token_clustered: ci,
    ci_excludes_zero: Array.isArray(ci) && ci.length === 2 && (ci[0] > 0) === (ci[1] > 0),
  };
}

function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return +Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)).toFixed(4);
}

function describe(xs) {
  const v = xs.filter((x) => x !== null && Number.isFinite(x));
  if (!v.length) return null;
  return {
    n: v.length, min: +Math.min(...v).toFixed(4), max: +Math.max(...v).toFixed(4),
    median: +median(v).toFixed(4), sd: sd(v), distinct_values: new Set(v).size,
  };
}

function main() {
  initConnectome(JSON.parse(readFileSync(resolve(DATA, 'connectome.json'), 'utf8')));
  const ds = JSON.parse(readFileSync(resolve(DATA, 'snapshots_v3.json'), 'utf8'));
  const w = ds.meta.window || ds.meta.cohort_window || {};
  const cohortRoot = `${w.start_block}:${ds.meta.chain_id || ds.meta.chain || 'base'}`;

  const scored = [];
  const skipped = { too_small: 0, no_signal: 0 };

  for (let e = 0; e < SCORING_EPOCHS; e++) {
    const seed = epochSeed(cohortRoot, e);
    for (const t of ds.tokens) {
      const snap = t.snapshots[e];
      if (!snap) continue;
      if (snap.holder_count < MIN_HOLDERS) { skipped.too_small++; continue; }
      const sig = deriveSignalV3(snap, e > 0 ? t.snapshots[e - 1] : null);
      if (!sig) { skipped.no_signal++; continue; }

      const pA = planFull(sig);
      const pB = planNoGrowth(sig);
      scored.push({
        token: t.token, symbol: t.symbol || null, epoch: e,
        holders: snap.holder_count,
        growth: +sig.growth.toFixed(5),
        sell: +sig.sellPressure.toFixed(5),
        hhi: sig.hhi,
        budgetA: pA.totalTicks,
        pe_full: runPlan(pA, seed),
        pe_nogrowth: runPlan(pB, seed),
      });
    }
  }

  const frozen = scored.filter((r) => r.growth === 0 && r.sell === 0).length;
  const report = {
    generated_utc: new Date().toISOString(),
    cohort: {
      file: 'snapshots_v3.json',
      chain: ds.meta.chain || ds.meta.chain_id,
      universe_rule: ds.meta.universe_rule || null,
      window: w,
      epoch_seconds: ds.meta.epoch_seconds || null,
      tokens_ingested: ds.tokens.length,
    },
    design: {
      arm_a: 'shipped mapping, growth drives tick budget and chemotaxis share',
      arm_b: 'ablation, constant 256-tick budget, sell pressure and HHI only, growth removed',
      growth_knee: GROWTH_KNEE,
      exit_knee: EXIT_KNEE,
      sell_pressure_definition: 'v3 exit rate (exits / prev holders), NOT v1 value-to-LP',
      eligibility: `holder_count >= ${MIN_HOLDERS}`,
      scoring_epochs: SCORING_EPOCHS,
    },
    rows_scored: scored.length,
    tokens_scored: new Set(scored.map((r) => r.token)).size,
    skipped,
    degeneracy: {
      note: 'the v1 cohort failed here: 91.4% of rows were frozen on both inputs and the outcome',
      frozen_rows: frozen,
      frozen_pct: +(100 * frozen / Math.max(scored.length, 1)).toFixed(1),
      growth_zero_pct: +(100 * scored.filter((r) => r.growth === 0).length / Math.max(scored.length, 1)).toFixed(1),
      sell_zero_pct: +(100 * scored.filter((r) => r.sell === 0).length / Math.max(scored.length, 1)).toFixed(1),
    },
    responsiveness: {
      arm_a: describe(scored.map((r) => r.pe_full)),
      arm_b: describe(scored.map((r) => r.pe_nogrowth)),
      arm_a_vs_growth: +(spearman(scored.map((r) => r.growth), scored.map((r) => r.pe_full)) ?? NaN).toFixed(3),
      arm_b_vs_hhi: +(spearman(scored.map((r) => r.hhi), scored.map((r) => r.pe_nogrowth)) ?? NaN).toFixed(3),
      arm_b_vs_sell: +(spearman(scored.map((r) => r.sell), scored.map((r) => r.pe_nogrowth)) ?? NaN).toFixed(3),
      arm_b_growth_leak: +(spearman(scored.map((r) => r.growth), scored.map((r) => r.pe_nogrowth)) ?? NaN).toFixed(3),
      arm_a_vs_arm_b: +(spearman(scored.map((r) => r.pe_full), scored.map((r) => r.pe_nogrowth)) ?? NaN).toFixed(3),
    },
    horizons: {},
  };

  const byToken = new Map(ds.tokens.map((t) => [t.token, t]));
  for (const k of HORIZONS) {
    const rows = [];
    for (const r of scored) {
      const fwd = forwardHolderChange(byToken.get(r.token).snapshots, r.epoch, k);
      if (fwd === null) continue;
      rows.push({ ...r, fwd });
    }
    if (rows.length < 20) { report.horizons[`k${k}`] = { n: rows.length, note: 'too few rows' }; continue; }
    report.horizons[`k${k}`] = {
      n: rows.length,
      tokens: new Set(rows.map((r) => r.token)).size,
      median_forward_change: +median(rows.map((r) => r.fwd)).toFixed(4),
      forward_zero_pct: +(100 * rows.filter((r) => r.fwd === 0).length / rows.length).toFixed(1),
      arm_a_full: corr(rows, 'pe_full'),
      arm_b_nogrowth: corr(rows, 'pe_nogrowth'),
      raw_inputs: [corr(rows, 'growth'), corr(rows, 'sell', -1), corr(rows, 'hhi', -1)].filter(Boolean),
    };
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, 'backtest_v3.json'), JSON.stringify(report, null, 2));
  writeFileSync(resolve(OUT, 'scored_v3.json'), JSON.stringify(scored));
  console.log(JSON.stringify(report, null, 2));
}

main();
