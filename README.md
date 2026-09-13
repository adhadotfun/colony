# COLONY

One *C. elegans* connectome per token, one shared seed per epoch, one leaderboard,
and a back-test that is allowed to fail in public.

This is the successor to the single-worm instrument. The predecessor's engine was
good and its product was decorative: chain state went in, an animal wiggled,
nothing came back out that anyone could dispute. COLONY keeps the engine byte for
byte and replaces the ornament with a scored, recomputable feed.

## What changed

| | predecessor | COLONY |
|---|---|---|
| output | an animation | a rank per token per epoch, plus a signed JSON feed |
| meaning | absolute, thresholds picked by feel | relative within an epoch cohort |
| falsifiable | no | yes, and the back-test is in `BACKTEST.md` |
| quiet tokens | look identical to healthy ones | withheld with a stated reason |
| PRNG | per token | shared per epoch, so it adds zero cross-token variance |

## Layout

```
engine/colony.mjs      scoring: snapshot -> signal -> plan -> worm -> path efficiency
engine/stats.mjs       spearman, permutation test, cluster bootstrap. no dependencies
engine/backtest_v3.mjs the 30-epoch back-test, writes out/backtest_v3.json and out/scored_v3.json
engine/feed_v3.mjs     writes the signed public feed, out/feed_v3.json
engine/partial_v3.mjs  writes out/partial_v3.json
js/engine.js           the ported connectome engine, unchanged calibration
js/body.js             muscle state to body geometry
js/app.js              the front end: arena, leaderboard, withheld panel and replay
js/brain.js            cell positions on the strip, from data/cell_layout.json
data/snapshots_v3.json    real per-epoch holder snapshots ingested from chain
data/connectome.json      OpenWorm c302 adjacency, 397 cells, 3,683 connections
out/                   generated feed, scored rows and back-test report
scripts/               ingest scripts: ingest.py, ingest_colony_rh.py
server.py              static file server for hosts that want a process
verify.html            re-runs the numbers in your browser
docs.html              the report, rendered from BACKTEST.md
```

## Run it

```bash
node engine/backtest_v3.mjs    # scores every token-epoch, runs the back-test
python3 server.py              # serve the site on :8080, or set PORT
```

Then open `index.html`, or `/docs` for the report and `/verify` to re-run the
numbers yourself.

## The three design rules

**1. Nothing is fitted to the outcome.** Every engine constant is inherited from
the predecessor's calibration. The confidence threshold (200 of 256 ticks) was set
from the tick-budget sweep *before* any outcome data was touched. Tuning the
mapping against the back-test would not produce an oracle, it would produce an
overfitted worm.

**2. Scores are relative.** Absolute path efficiency is meaningless because the
saturation constants (chemotaxis at 10% growth, nose touch at 1%) were chosen so
the animation looked lively, not because those numbers mean anything about a
market. Ranking within an epoch cohort needs no magic constants and self-normalises
as conditions drift.

**3. A reading that cannot express is withheld, not shown small.** Below roughly
200 ticks of budget the concentration arm barely separates, so a low HHI and a high
one produce nearly the same path. Those token-epochs are excluded from the
leaderboard with the reason printed.

## The control that matters

`path_efficiency` is a deterministic function of `(growth, sellPressure, hhi)`. It
therefore **cannot** contain information those three inputs lack. The only
defensible claim is that it is a *useful compression* of them.

So the back-test reports the worm's correlation next to the correlation of each raw
input, on the same rows, with the same test. If a single raw input beats the worm,
the worm is a lossy wrapper and `BACKTEST.md` says exactly that. That comparison is
the point of the exercise, not a footnote to it.

## Cohort honesty

The cohort is every token launched on the Pons V2 bonding curve factory on
Robinhood Chain inside one fixed 1 hour window, blocks 60,512,037 to 60,547,400.
827 launches landed in that window; the 30 kept are those with at least 20
transfers and a peak of at least 10 holders. There is **no filter for
whether the token still exists today**, so failed launches stay in the sample. If a
correlation only appears after dropping the dead ones, that is survivorship, not
signal.

Epochs are counted from each token's own launch block rather than from a wall-clock
date, so what is being compared is launch trajectories at equivalent age.

## Known gameable surfaces

Inherited from the predecessor's best habit: publish the failure modes next to the
metric.

1. **HHI is trivially split.** A whale wanting a healthy-looking worm spreads across
   50 addresses for one block. Concentration measures address distribution, not
   beneficial ownership.
2. **Growth is buyable for one block.** The snapshot reads a single block, so dust
   to 200 fresh addresses just before it saturates the chemotaxis budget. Sampling
   the minimum across a window of blocks raises the cost but does not remove it.
3. **The LP set is a semantic claim, not a chain fact.** Here it is resolved
   mechanically from the Pons V2 launch factory, which removes the predecessor's
   trusted operator input on this cohort but would not generalise to a token whose
   liquidity sits somewhere the factory does not know about.

None of these have clean fixes. Shipping them beside the number is the point.

## Verify

Nothing on the site asks for trust. Open `/docs` for the full report, or
`/verify` to re-run the engine in your own browser and compare against the
stored output field by field. Pushes and pull requests run the same checks in
CI (`.github/workflows/check.yml`): syntax checks over the JS and Python, a
re-run of the back-test compared against `out/backtest_v3.json`, and a scan
that fails the build if an em dash or en dash lands in any source file.
