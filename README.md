# COLONY

A 302-neuron nervous system, driven by on-chain holder data.

The wiring is the *C. elegans* connectome. The stimulus is the holder behaviour of a fixed
cohort of Base mainnet tokens, hour by hour. Each epoch turns one token's holder snapshot
into a chemotaxis signal, plans a tick budget from it, and runs the worm. What you see move
on the front page is a simulation whose every input came off the chain.

Everything in this repository recomputes. Nothing here asks to be believed.

## The honest version

The back-test is in [BACKTEST.md](BACKTEST.md) and it is not flattering. Short version:

- The worm does **not** predict holder growth on this cohort in any useful standalone sense.
- `path_efficiency` is a deterministic function of `(growth, sellPressure, hhi)`, so it cannot
  carry information those three lack. It was only ever defensible as a compression of them.
- Controlled against its own raw inputs, the connectome arm carries a small real increment,
  roughly **+0.10 to +0.14** across k=3/7/14, with intervals excluding zero.
- The ablation arm is fully explained by raw sell pressure and should not be shipped as an
  instrument. It is reported here rather than quietly dropped.
- The cohort is **selected on survival**: these tokens were picked because they are actively
  traded now, and forward growth is measured inside that same window. Every number above
  sits under that caveat.

If you want to predict holder growth on this universe, use raw growth and raw exit rate
directly. The worm is a visualisation with a measurable but minor edge on top.

## Check it yourself

Open `verify.html`. It loads the stored inputs, re-executes the same engine module the front
page ships, and diffs the result field by field in your browser. Ten checks:

| check | what it proves |
| --- | --- |
| cohort window | the seed domain every epoch derives from matches the chain window |
| snapshot sha256 | the exact bytes of the snapshot file served to you |
| snapshot root | a format-independent root rebuilt row by row from 1,104 parsed records |
| connectome sha256 | the wiring file matches the hash the feed commits to |
| epoch seeds | all 48 seeds re-derive from the cohort window |
| derived signal | 1,104 token-epoch signals recompute from the raw holder snapshot |
| tick plan | 1,104 tick budgets recompute from those signals |
| path efficiency | 1,104 simulation scores reproduce from seed and plan |
| net travel | same |
| reversals | same |

There is no second implementation kept for verification, because a second implementation is
a place for the two to quietly disagree. `verify.html` imports `js/engine.js`, the same module
`index.html` imports.

**What Level 1 does not prove.** It verifies the simulation, not the chain data. If the
snapshot of Base mainnet is wrong, every check above still passes. To close that gap, replay
`Transfer` logs for each token across the window against an archive node you control and diff
against `data/snapshots_v3.json`. The ingest script that produced it is `scripts/ingest.py`.

## The window

| | |
| --- | --- |
| chain | Base mainnet, chain id 8453 |
| blocks | 51,091,736 to 51,178,136 |
| epoch | 1,800 blocks, about 1 hour |
| epochs | 48 (30 of them scored in the back-test) |
| tokens | 23 selected from 30 candidates |
| selection | Base mid-caps with sustained transfer activity across the window |

This build is a frozen replay, not a live feed. Nothing fetches at runtime.

## Layout

```
index.html          front page, live simulation view
verify.html         the audit page described above
docs.html           renders BACKTEST.md
BACKTEST.md         full method and measured result
js/engine.js        signal, tick planning, locomotion, scoring
js/app.js           front page wiring and camera
js/brain.js         connectome view
js/body.js          body render
engine/*.mjs        node pipeline: feed build, back-test, partial correlations
data/connectome.json    clean-room derivation of White et al. 1986, provenance inside
data/cell_layout.json   anatomical cell positions
data/snapshots_v3.json  the chain snapshot, the input Level 2 exists to challenge
out/*.json          generated feed, scores, back-test, partials
scripts/ingest.py   the ingest that produced the snapshot
```

## Rebuild

```bash
node engine/feed_v3.mjs        # snapshot -> feed, recomputes both integrity roots
node engine/backtest_v3.mjs    # 30-epoch back-test, both arms, bootstrapped CIs
node engine/partial_v3.mjs     # partial correlations against raw inputs
```

The feed build is deterministic. Regenerating it produces an identical file apart from the
`generated_utc` stamp, which is how the integrity roots stay meaningful.

Serve the directory over HTTP and open it. Any static server will do:

```bash
python3 -m http.server 8080
```

## Notes on the connectome

`data/connectome.json` is a clean-room derivation of the White et al. 1986 wiring, with its
provenance block inside the file. Cell positions in `data/cell_layout.json` are anatomical:
x runs 0 to 800 microns nose to tail, y is dorsal/ventral. MI is classified as a motor neuron,
which is why the legend reads 131 motor and 97 muscle rather than the split you may expect.

## Licence

MIT.
