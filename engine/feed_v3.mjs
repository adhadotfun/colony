/**
 * Build out/feed_v3.json in the exact shape arena.js already consumes.
 * Uses the shipped mapping (arm A) so the live feed matches the engine that
 * ships; the back-test cards carry the honest verdict on that mapping.
 * v3 inputs: growth = new_holders / prev holders (knee 0.10),
 *            sell   = exits / prev holders       (knee 0.50, exit rate not value-to-LP).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  initConnectome, createState, createPosition, Xorshift128,
  planStimulus, expandPlan, runSequence, pathEfficiency, DEFAULT_SIGNAL_CONFIG,
} from '../js/engine.js';
import { epochSeed } from './colony.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '../data');
const OUT = resolve(HERE, '../out');
const CFG = { ...DEFAULT_SIGNAL_CONFIG, saturation: 0.10, sellSaturation: 0.50 };
const MIN_HOLDERS = 10;

const raw = readFileSync(resolve(DATA, 'connectome.json'), 'utf8');
initConnectome(JSON.parse(raw));
const connectomeSha = createHash('sha256').update(raw).digest('hex');

const ds = JSON.parse(readFileSync(resolve(DATA, 'snapshots_v3.json'), 'utf8'));
const w = ds.meta.window || ds.meta.cohort_window || {};
const cohortRoot = `${w.start_block}:${ds.meta.chain_id || 8453}`;
const nEpochs = Math.min(...ds.tokens.map((t) => t.snapshots.length));

const epochs = [];
for (let e = 0; e < nEpochs; e++) {
  const seed = epochSeed(cohortRoot, e);
  const entries = [];

  for (const t of ds.tokens) {
    const snap = t.snapshots[e];
    if (!snap) continue;
    const prev = e > 0 ? t.snapshots[e - 1] : null;
    const base = Math.max(prev ? prev.holder_count : snap.holder_count, 1);
    const cold = snap.holder_count < MIN_HOLDERS;

    const signal = cold
      ? { kind: 'cold', growth: 0, sellPressure: 0, hhi: snap.hhi == null ? 0 : snap.hhi }
      : {
          kind: 'warm',
          growth: +((snap.new_holders || 0) / base).toFixed(5),
          sellPressure: +((snap.exits || 0) / base).toFixed(5),
          hhi: snap.hhi == null ? 0 : snap.hhi,
        };

    const plan = cold
      ? { chemotaxisTicks: 0, noseTouchTicks: 0, rightWeight: 0, totalTicks: 0 }
      : planStimulus(signal, CFG);

    let pe = null, netTravel = 0, reversals = 0;
    if (plan.totalTicks > 0) {
      const rng = new Xorshift128(seed);
      const r = runSequence(createState(), createPosition(), expandPlan(plan, rng));
      pe = +pathEfficiency(r.path).toFixed(4);
      netTravel = +(r.netTravel ?? 0).toFixed(4);
      reversals = r.reversals ?? 0;
    }

    // confidence: budget is the honest proxy for how much evidence the worm got
    const confidence = cold ? 'cold'
      : plan.totalTicks >= 192 ? 'high'
      : plan.totalTicks >= 64 ? 'medium' : 'low';

    entries.push({
      token: t.token, symbol: t.symbol || null, epoch: e, block: snap.block,
      holder_count: snap.holder_count, new_holders: snap.new_holders || 0,
      exits: snap.exits || 0, entries_count: snap.entries || 0,
      hhi: snap.hhi, gini: snap.gini,
      signal, plan,
      path_efficiency: pe, net_travel: netTravel, reversals,
      budget_used: plan.totalTicks,
      confidence, rank: null, percentile: null,
    });
  }

  // only high-confidence rows get a published rank; the rest are withheld
  const publishable = entries.filter((x) => x.path_efficiency !== null && x.confidence === 'high')
    .sort((a, b) => b.path_efficiency - a.path_efficiency);
  publishable.forEach((x, i) => {
    x.rank = i + 1;
    x.percentile = publishable.length > 1
      ? +(100 * (1 - i / (publishable.length - 1))).toFixed(1) : 100;
  });

  epochs.push({ epoch: e, seed, entries });
}

// Integrity commitments over the chain snapshot. snapshots_sha256 pins the exact
// bytes we serve; snapshot_root is format independent, rebuilt row by row from the
// parsed records so a reformatted file still has to produce the same root.
const snapshotBytes = readFileSync(resolve(DATA, 'snapshots_v3.json'));
const snapshotsSha = createHash('sha256').update(snapshotBytes).digest('hex');
const snapshotRows = [];
for (const t of [...ds.tokens].sort((a, b) => (a.token < b.token ? -1 : 1))) {
  for (const s of [...t.snapshots].sort((a, b) => a.epoch - b.epoch)) {
    snapshotRows.push(JSON.stringify([t.token, s.epoch, s.block, s.holder_count, s.new_holders, s.exits, s.hhi]));
  }
}
const snapshotRoot = createHash('sha256').update(snapshotRows.join('\n'), 'utf8').digest('hex');

const feed = {
  engine_version: '3',
  cohort_root: cohortRoot,
  n_epochs: nEpochs,
  epochs,
  connectome_sha256: connectomeSha,
  snapshots_sha256: snapshotsSha,
  snapshot_root: snapshotRoot,
  snapshot_rows: snapshotRows.length,
  source: {
    chain: ds.meta.chain || 'base',
    chain_id: ds.meta.chain_id || 8453,
    rpc: ds.meta.rpc || 'https://mainnet.base.org',
    cohort_window: w,
    blocks_per_epoch: ds.meta.blocks_per_epoch || 1800,
    epoch_wallclock: '1 hour',
    n_epochs: nEpochs,
    generated_utc: new Date().toISOString(),
    tokens_selected: ds.tokens.length,
    venue: ds.meta.venue || null,
    candidates_found: ds.meta.candidates_found || null,
    selection_rule: ds.meta.selection_rule || ds.meta.universe_rule
      || 'Base mid-cap tokens with sustained transfer activity over the 48 hour window',
    survivorship_note: ds.meta.survivorship_note
      || 'the cohort is every token launched inside one fixed window, taken before any of them '
      + 'had a track record; tokens that died are still in the sample and still scored',
    epoch_note: ds.meta.epoch_note || 'epochs are 1 hour, not 1 day',
    venue_note: ds.meta.venue_note || null,
    sell_pressure_note: 'v3 sell pressure is an exit rate (exits / prev holders), not value-to-LP as in v1',
  },
};

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'feed_v3.json'), JSON.stringify(feed));
console.log(JSON.stringify({
  n_epochs: nEpochs,
  tokens: ds.tokens.length,
  entries_total: epochs.reduce((a, e2) => a + e2.entries.length, 0),
  scored: epochs.reduce((a, e2) => a + e2.entries.filter((x) => x.path_efficiency !== null).length, 0),
  published: epochs.reduce((a, e2) => a + e2.entries.filter((x) => x.rank != null).length, 0),
  cold: epochs.reduce((a, e2) => a + e2.entries.filter((x) => x.confidence === 'cold').length, 0),
}, null, 2));
