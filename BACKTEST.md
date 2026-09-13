# The 30-epoch back-test

**Verdict: the one place the shipped mapping earned its keep was the Base survivor
cohort, where it carried a small increment of +0.10 to +0.14 over its own raw
inputs. That result does not replicate. Re-run on a Robinhood Chain launch cohort,
every arm collapses into its confidence interval and the partials all straddle
zero. On both chains the raw inputs beat the compression, and even their sign is
not stable across chains. Treat the worm as a visualisation, not a predictor.
Reported in full rather than buried.**

Generated 2026-09-13. Cohort, feed and code are in this directory, so every number
below recomputes from public chain data. Three cohorts are reported: a Base launch
cohort (v1), a Base survivor cohort (v3), and a Robinhood Chain launch cohort
(v4). Each section names its own chain; numbers are never carried across them.

---

## What was tested

For each token, for each of 30 scoring epochs, the connectome was run on that
epoch's holder snapshot and scored by path efficiency (net displacement over path
length). The question: does that score predict the token's holder growth over the
following k epochs?

The control is the whole point. `path_efficiency` is a deterministic function of
`(growth, sellPressure, hhi)`, so it **cannot** carry information those three lack.
The only defensible claim was ever that it is a useful *compression* of them. So
every correlation below sits next to the same correlation computed on each raw
input, over the identical rows.

## Cohort

| | |
|---|---|
| chain | Base (8453), Uniswap V2 WETH pairs |
| selection | every Uniswap V2 WETH pair created in one fixed 3 hour window, at least 20 transfers and a peak of 10 holders, no survivorship or liveness filter |
| tokens | 16 |
| epoch | 1 hour |
| epochs | 37 ingested, 30 scored, 7 held back for forward outcomes |
| token-epochs | 479 scored |
| RPC calls | public Base RPC, no key |

**Why hourly epochs and not daily.** A launch curve does most of its work in the
first two days. At daily resolution the entire trajectory collapses into three or
four points, which is too coarse to score anything. An hour keeps 37 usable
observations per token and still fits inside what a public node will serve
without a key.

---

## Result 1: the confidence gate eats the cohort

| confidence | token-epochs | share |
|---|---|---|
| high | 34 | 7.1% |
| medium | 3 | 0.6% |
| low | 443 | 92.3% |

**This is the largest finding in the study, and it is a structural one.**

A token buys ticks with growth and sell pressure. Under roughly 200 of the 256
available ticks the concentration arm has not had room to express, so a low HHI and
a high one produce nearly the same path. That threshold came from the calibration
sweep and was fixed before any outcome data was touched.

Applied to a real launch cohort, it disqualifies 92% of all readings. The
instrument is honest, and it is honestly mute. A version of COLONY that published
the other 92% anyway would look far more impressive and would be lying.

## Result 2: path efficiency does not beat its own inputs

Spearman rank correlation against forward holder growth. `p` is a 5,000 iteration
permutation test. Brackets are a 95% bootstrap interval **resampled by token**,
because 16 tokens supplying 34 rows are not 34 independent observations.

### High confidence rows only (n = 34, 16 tokens)

| horizon | path_efficiency | best raw input | verdict |
|---|---|---|---|
| k=3 | -0.258 (p=0.13) | holders +0.267 | tie, both null |
| k=7 | **-0.320** (p=0.063) | growth -0.317 | tie, both null |
| k=14 | **-0.376** (p=0.035) | **growth -0.390** (p=0.024) | growth wins |

At every horizon the worm either loses to a raw input or ties it. At k=14, where
the worm looks its strongest, raw holder growth alone is *better*. The compression
did not earn its complexity.

### The bootstrap kills even that

The permutation test treats each row as independent. It should not: one token
contributes up to 30 rows, and those rows are heavily autocorrelated. Once
resampled by token, every interval straddles zero:

```
k=14 high confidence
  path_efficiency  rho = -0.376   95% CI [-0.581, +0.323]
  growth           rho = -0.390   95% CI [-0.678, +0.579]
  -hhi             rho = +0.068   95% CI [-0.765, +0.388]
```

So the correct reading is not "growth beats the worm". It is **nothing here is
distinguishable from noise once you account for the fact that this is 16 tokens.**
The p-values are optimistic artefacts of pretending otherwise, and quoting them
without the intervals would be the exact dishonesty this project exists to avoid.

## Result 3: the sign is negative, and that is mean reversion

Every path efficiency correlation is negative: a *better* looking worm this hour
precedes *slower* holder growth. Raw growth carries the same negative sign, which
explains it. Tokens that added holders fast in one hour add them slower in the
next, which is mean reversion in a launch curve, not distribution health.

The worm inherits the sign from its growth input. It is not detecting anything
about concentration.

## Result 4: the predecessor's headline claim is untestable here

The claim in `SUCCESSOR.md` was: tokens scoring below 0.30 for three consecutive
epochs should show holder decline afterwards.

```
flagged (3 consecutive epochs below 0.30):   n = 0
not flagged:                                 n = 7, from 1 token
```

**Zero** qualifying cases. Not a weak result, no result. Two reasons compound: the
confidence gate leaves few scored epochs per token, and it leaves them scattered
rather than consecutive, so a three-in-a-row window almost never forms. Only one
token in the cohort ever produced a testable window at all.

A claim that cannot be evaluated on a real cohort is not a conservative claim, it
is an untested one, and the original write-up should not have stated it as
plausible.

---

## What this does and does not prove

**Does not prove the connectome mapping is worthless.** 16 tokens, 34 usable
readings, one 3 hour launch window on one chain. This is underpowered by a wide
margin. A negative result at this sample size is weak evidence, not a refutation.

**Does prove three concrete things:**

1. The confidence gate, set honestly in advance, disqualifies over 90% of a real
   launch cohort. Any deployment of this instrument is mostly silence.
2. On the readings that survive, the worm does not outperform a single raw input it
   is computed from. As a compression it is not currently paying for itself.
3. The predecessor's specific published claim produced zero testable cases, so it
   was never supported by anything.

## What would make this a real test

- **More tokens.** 200 plus, across several launch windows, to get past the
  token-clustered interval problem. This needs paid archive access, which is the
  binding constraint here, not compute.
- **A longer forward horizon.** 7 hours of holder change on a 4 day old token is
  mostly launch-curve mechanics. Days-to-weeks is the interesting horizon and needs
  archive data.
- **A cohort with survivors.** This window was dominated by tokens that made 12 to
  22 holders and stopped. One token grew 9 to 86. Distribution health is not a
  meaningful question about a token with 14 holders, and the gate correctly says so,
  which leaves very little to measure.
- **Drop the growth arm and retest.** Since the worm's signal appears to be
  inherited growth with a sign flip, a variant driven by concentration and sell
  pressure only would isolate whether the connectome adds anything at all.

## Reproduce it

```bash
python3 scripts/ingest_colony.py     # pulls the cohort and rebuilds holder balances
node engine/backtest.mjs             # scores every token-epoch and runs the test
```

Outputs land in `out/feed.json` and `out/backtest.json`. The connectome sha256 and
every epoch seed are recorded in the feed, so a third party can rerun the scoring
and get identical numbers.

---

# Ablation: strip the growth arm

Run after the main back-test, to settle whether the connectome contributes
anything beyond a sign flip on holder growth. Code: `engine/ablation.mjs`,
output: `out/ablation.json`.

## How the arm was removed

Zeroing the growth term would not have been an ablation, it would have been a
lobotomy. In the shipped mapping growth does two jobs: it sets the tick budget,
and it competes with sell pressure for the chemotaxis share. Delete it and
budget collapses to whatever sell pressure buys, almost every token falls under
the confidence gate, and the arm becomes untestable for reasons unrelated to the
hypothesis.

So **arm B holds the budget constant at the full 256 ticks** for every eligible
token-epoch, and gives the two survivors the only jobs left:

| input | job in arm B |
|---|---|
| sell pressure | chemotaxis / nose-touch mix |
| HHI | left / right bias |
| growth | removed entirely |

Budget is constant, so it cannot confound, and the tick-budget confidence gate
becomes vacuous. The only eligibility rule left is `holder_count >= 10`, which
admits **479 token-epochs instead of 34**.

## Finding 1: the shipped worm is a growth proxy, confirmed

```
spearman(arm A path efficiency, raw growth) = +0.975
```

That settles the question that prompted this run. Arm A is not compressing three
inputs, it is reporting one of them. The earlier negative correlation with
forward holder change was raw growth's sign, passed through a worm.

## Finding 2: the connectome does carry concentration, once growth stops eating the budget

Arm B responds strongly to the input the shipped mapping was starving:

```
spearman(arm B path efficiency, HHI)   = -0.761
spearman(arm B path efficiency, sell)  = -0.257
spearman(arm A path efficiency, arm B) = -0.009
```

Arm B path efficiency spans 0.076 to 0.818 (sd 0.209, 93 distinct values), so the
mapping is genuinely responsive, not flat. And the two arms are **orthogonal**:
at -0.009 they are not two versions of one instrument, they are measuring
different things. The connectome can express concentration. The shipped
configuration simply never let it.

## Finding 3: it still does not predict

| horizon | arm B (no growth) | 95% CI, token-clustered |
|---|---|---|
| k=3 | -0.188 (p=0.0002) | [-0.332, **+0.021**] |
| k=7 | -0.170 (p=0.0004) | [-0.342, **+0.087**] |
| k=14 | -0.171 (p=0.0014) | [-0.356, **+0.109**] |

Every interval straddles zero. The p-values look emphatic and are not: they come
from treating 479 rows off 16 tokens as 479 independent observations.

## Finding 4: the cohort is structurally degenerate, which caps what any arm can show

This is the real limit, and it was not visible until the row count went up:

```
rows with growth == 0:               440 / 479   (91.9%)
rows with sell == 0:                 458 / 479   (95.6%)
rows with BOTH zero:                 438 / 479   (91.4%)
rows with forward holder change == 0: 438 / 479  (91.4%)
```

**Only 41 of 479 token-epochs contain any activity at all.** The rest are frozen
tokens: no new holders, no transfers to the pool, no forward change. Both inputs
and the outcome collapse into one enormous rank tie, so the correlations above
are mostly measuring "active row versus dead row", not a graded relationship.

That also explains the one result whose clustered interval does exclude zero.
Raw sell pressure correlates **+0.36 to +0.39** with forward holder growth
(reported as `-sell` = -0.363, so higher sell pressure precedes *more* holders).
Read plainly that is not "selling is healthy", it is "a token with any pool
activity at all is a token that is still alive". It is a liveness detector
wearing a distribution-health costume.

## Verdict

Three questions, three answers:

1. **Is the shipped worm a sign-flipped growth proxy?** Yes. rho = 0.975 with raw
   growth. That claim is now settled.
2. **Can the connectome carry anything else?** Yes, mechanically. Freed of the
   budget conflict it tracks concentration at -0.761 and is orthogonal to arm A.
3. **Does that give it predictive value here?** No, and this cohort cannot answer
   it either way. With 91.4% of rows frozen on both sides of the regression,
   there is nothing to predict.

The honest next step is not another variant. It is a cohort with survivors:
tokens that actually traded across the window, which needs paid archive access
to reach launches old enough to have gone somewhere. Running more ablations on
438 dead rows would just be re-testing the same tie block.

---

# v3 cohort: rerun on tokens that actually trade

The v1 verdict ended on a limit, not a result: 91.4% of rows were frozen on both
inputs and on the outcome, so nothing could be predicted from them. v3 replaces
the cohort. Code: `engine/backtest_v3.mjs`, `engine/partial_v3.mjs`, outputs
`out/backtest_v3.json`, `out/partial_v3.json`.

| | v1 cohort | v3 cohort |
|---|---|---|
| selection | every Pons V2 launch in a 1 hour window, no liveness filter | predecessor method: tokens picked for sustained transfer activity, which selects on survival |
| tokens | 16 | 23 ingested, 21 scored |
| epochs | 37 hourly | 48 hourly (30 scored + forward window) |
| rows | 479 | 551 |
| frozen on both inputs | 91.4% | **7.1%** |
| forward change exactly 0 (k=7) | 91.4% | **3.1%** |

The tie block is essentially gone: 7.1% of rows frozen on both inputs, and at k=7
only 3.1% of forward changes are exactly zero. This cohort can answer the
question.

## Why the instrument replays 37 epochs but the test scores 30

These are two different numbers and both are correct.

**48 is the replay.** The v3 cohort is drawn from Base blocks 51,091,736 to
51,178,136, 1,800 blocks per hourly epoch, 48 epochs per token. The worm on the
front page runs every one of them. That is the full reconstructed window and
nothing in it is hidden.

**30 is the scoring window.** A row is only usable if there is a *later* snapshot
to check it against. Every score at epoch `e` is graded on holder change at
`e + k` for k = 3, 7 and 14 epochs, so the tail of the window has no outcome yet:
an epoch 34 score has nowhere to land at k=14. `engine/backtest.mjs` sets
`SCORING_EPOCHS = 30` and drops every entry with `epoch >= 30`, which leaves the
last 7 epochs serving only as forward outcomes, never as predictions.

**Why 30 and not more.** 30 was kept as the scoring constant because the v1 run
scored 30, and holding it fixed is what makes v1, the ablation and v3 comparable
line by line. With 48 ingested epochs every scored row has a k=14 outcome
available, so all three horizons keep the full 551 rows.

So: 48 epochs computed and displayed, 30 epochs scored, the remainder spent as
the forward horizon. The 551 rows in every table below come from that 30 epoch
slice.

## The v3 signal adapter, and where it differs

The v3 ingest records per-epoch `entries` / `exits`, not the `value_to_lp` field
v1 used. So sell pressure changed meaning:

```
growth = new_holders / prev_holders     knee 0.10   (v3 median 0.034, p75 0.115)
sell   = exits       / prev_holders     knee 0.50   (v3 median 0.194, p75 0.535)
```

Knees are set from the observed v3 distribution. Carrying over v1's 0.01 sell
knee would peg about 85% of v3 rows at maximum and flatten the input entirely.
**v3 sell pressure is holder churn, not value moving to the pool.** Same name,
different quantity, and any comparison to v1 has to carry that caveat.

## Finding 1: on a live cohort the shipped worm is no longer a growth proxy

```
v1:  spearman(arm A path efficiency, raw growth) = +0.975
v3:  spearman(arm A path efficiency, raw growth) = -0.101
```

The +0.975 was an artifact of the dead cohort, not a property of the mapping.
When almost every row has growth 0 and a starved budget, path efficiency has
nothing to encode except whether growth was nonzero. Give it real variation and
the nonlinear budget mapping stops tracking growth monotonically. The v1 claim
"the shipped worm is a growth proxy" is **correct about v1 and wrong as a general
statement about the mapping**. Recorded here rather than quietly dropped.

Arm A and arm B are also no longer orthogonal: +0.38, versus -0.009 on v1.

## Finding 2: both arms now predict, marginally

Spearman against forward holder change, 95% CI bootstrapped over token clusters.

| horizon | arm A (shipped) | CI | arm B (no growth) | CI |
|---|---|---|---|---|
| k=3 | -0.137 | [-0.248, -0.020] | **-0.227** | [-0.340, -0.105] |
| k=7 | -0.132 | [-0.267, +0.011] | **-0.246** | [-0.376, -0.108] |
| k=14 | -0.149 | [-0.314, +0.029] | **-0.277** | [-0.424, -0.123] |

Arm B clears zero at all three horizons. On v1 nothing did. That is a real
change, and taken alone it would read as the connectome working.

## Finding 3: taken alone is the wrong way to read it

The raw inputs, on identical rows, are roughly twice as strong:

| input | k=3 | k=7 | k=14 |
|---|---|---|---|
| raw growth | **+0.449** | **+0.459** | **+0.499** |
| exit rate, negated (`-sell`) | -0.431 | -0.428 | -0.433 |
| concentration, negated (`-hhi`) | -0.073 | -0.077 | -0.137 |

Sign convention: the engine scores `-sell` and `-hhi`, so the raw quantities
themselves carry the opposite sign. Exit rate is +0.431 / +0.428 / +0.433 and
HHI is +0.073 / +0.077 / +0.137 against forward holder change on this cohort.

Every worm result is weaker than the numbers it was computed from. The
connectome is not adding information, it is losing some.

## Finding 4: partial correlations, the decisive test

Rank-residualise both the worm score and the outcome on raw growth and raw exit
rate, then correlate what is left. This asks the actual question: does the
connectome contribute anything **beyond** its own inputs?

| horizon | arm B partial | CI | arm A partial | CI |
|---|---|---|---|---|
| k=3 | +0.012 | [-0.103, +0.121] | +0.104 | [+0.031, +0.162] |
| k=7 | -0.020 | [-0.156, +0.127] | +0.136 | [+0.052, +0.204] |
| k=14 | -0.056 | [-0.229, +0.119] | +0.127 | [+0.041, +0.218] |

**Arm B contributes nothing.** Every interval straddles zero. Its marginal
-0.227 to -0.277 was raw sell pressure wearing a worm.

**Arm A contributes a little, and the sign flips.** Marginally it is negative
(-0.137); after controlling for its inputs the increment is positive (+0.10 to
+0.14) with intervals that exclude zero at all three horizons. That is a
suppression pattern: the raw negative comes from the growth-to-budget path, and
what survives the control is a small nonlinear interaction the linear rank
controls cannot absorb. Small, consistent, and not nothing. It is the first
result in this project where the connectome earns its place, and it comes from
the arm that keeps growth, not the ablated one.

## The universe bias, stated plainly

This cohort was chosen because these tokens are actively traded **now**, and
forward holder growth is then measured inside that same window. That is
selection on survival, and it inflates exactly the thing that dominates the
table: raw growth predicting more growth at +0.45 to +0.50 is partly momentum
and partly the fact that no token in this universe was allowed to be dead.

Three further limits, none of them fixed by more rows:

- **21 tokens.** The clustered CIs already price this in, which is why they are
  wide, but 21 clusters is a small bootstrap.
- **48 hours, one regime.** Every row comes from a single two-day window on one
  chain. Whether the relationship survives a different tape is tested directly in
  the Robinhood Chain section below, and the answer is no.
- **Holder count is not price.** The whole project predicts holder growth, which
  is a distribution measure, not a return. A token can gain holders and fall.

v1 was blocked by a cohort with no life in it. v3 is not blocked, but it is
biased toward life, and the honest reading is that the two failure modes bracket
the truth rather than one replacing the other.

## Verdict

- The dead-cohort finding that the shipped worm is a growth proxy does not
  generalise. On live data that correlation is -0.101.
- Arm B, the ablation, is fully explained by raw sell pressure. It should not be
  shipped as an instrument.
- Arm A carries a small genuine increment over its own inputs, +0.10 to +0.14,
  consistent across k=3/7/14 with intervals excluding zero.
- Anyone wanting to predict holder growth on this universe should use raw growth
  and raw exit rate directly. The worm is a visualisation with a measurable but
  minor edge on top, not a replacement for the two numbers feeding it.

---

# v4 cohort: does any of it survive a different chain?

Everything above comes from Base. A result that only exists on one chain in one
48 hour window is not a result yet, it is a coincidence with error bars. So the
whole pipeline was re-pointed at a second chain and rerun unchanged.

| | |
|---|---|
| chain | Robinhood Chain (4663) |
| RPC | `https://rpc.mainnet.chain.robinhood.com`, public, no key |
| venue | Pons V2 bonding curves, factory `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e`, quoted in USDG `0x5fc5360d0400a0fd4f2af552add042d716f1d168` |
| selection | every token launched on that factory in one fixed 1 hour window, blocks 60,546,473 to 60,581,836, no survivorship or liveness filter |
| tokens | 30 selected from 799 candidates (the rest never cleared the minimum transfer and holder floor) |
| epoch | 1 hour (35,363 blocks; RH lands a block roughly every 0.1 seconds) |
| epochs | 37 ingested, 30 scored |
| rows | 730 scored token-epochs |
| RPC calls | 1,872 |

Nothing in the engine changed between chains. Same connectome, same knees, same
scoring code, same permutation and token-clustered bootstrap. Only the snapshot
file is different.

## A defect that would have been published as a finding

The first Robinhood ingest never emitted the `exits` field. Sell pressure is
`exits / prev_holders`, so every row came back with sell pressure exactly zero,
the degeneracy report said `sell_zero_pct: 100%`, and arm A appeared to predict
forward growth at +0.218 / +0.308 / +0.126.

That number was a bug, not a chain. Reading it at face value would have been a
claim that Robinhood Chain tokens have no sell-side at all, which is obviously
false and trivially falsifiable by anyone who opened an explorer. The ingest was
fixed to count entries and exits per epoch the same way the Base ingest does, the
full 30 token pull was rerun from scratch rather than patched in place, and every
number in this section comes from that corrected run. The wrong figures are
recorded here rather than deleted, because a study that only shows its clean runs
is not showing its work.

## Result: nothing survives the chain change

Spearman against forward holder change, 5,000 iteration permutation test, 95% CI
bootstrapped over token clusters.

| horizon | arm A (shipped) | CI | arm B (no growth) | CI |
|---|---|---|---|---|
| k=3 | +0.135 | [-0.010, +0.283] | -0.097 | [-0.204, +0.034] |
| k=7 | +0.101 | [-0.069, +0.264] | -0.089 | [-0.186, +0.032] |
| k=14 | 0.000 | [-0.250, +0.236] | -0.165 | [-0.317, +0.026] |

**Every interval straddles zero.** Several of the permutation p-values look
respectable (arm A k=3 at p=0.030, arm B k=14 at p=0.0002) and every one of them
is an artifact of pretending 730 autocorrelated rows off 30 tokens are 730
independent observations. Once the bootstrap resamples by token, there is nothing
left to report.

The partials say the same thing. Residualise both the score and the outcome on
raw growth and raw exit rate, then correlate what is left:

| horizon | arm B partial | CI | arm A partial | CI |
|---|---|---|---|---|
| k=3 | -0.071 | [-0.170, +0.055] | +0.006 | [-0.274, +0.239] |
| k=7 | -0.051 | [-0.136, +0.052] | -0.038 | [-0.360, +0.210] |
| k=14 | -0.143 | [-0.285, +0.018] | -0.107 | [-0.485, +0.185] |

On Base, arm A's partial was positive at all three horizons with intervals
excluding zero. Here it is +0.006, -0.038, -0.107, and every interval contains
zero. **The one finding this project could point to does not replicate.**

The confidence gate behaves as designed and mutes most of the cohort: arm A is
defined on 264 of 730 rows, because 63.8% of rows are frozen on both inputs. The
launch tape is quieter than the survivor tape, which is what an unfiltered launch
cohort is supposed to look like.

## Cross-chain comparison

Same engine, same knees, same scoring window, two chains:

| | Base v3 (survivor) | Robinhood v4 (launch) |
|---|---|---|
| chain | Base 8453, Uniswap V2 / CoinGecko universe | Robinhood 4663, Pons V2 bonding curves |
| selection bias | selected on survival | none, every launch in the window |
| tokens / rows | 21 / 551 | 30 / 730 |
| frozen on both inputs | 7.1% | 63.8% |
| forward change exactly 0 (k=7) | 3.1% | 40.5% |
| arm A defined on | 512 rows | 264 rows |
| arm A vs raw growth | -0.101 | +0.592 |
| arm A vs arm B | +0.380 | +0.416 |
| arm A partial increment | +0.10 to +0.14, excludes zero | -0.11 to +0.01, straddles zero |

And the raw inputs, which is where it gets interesting:

| input, vs forward holder change | Base v3 | Robinhood v4 |
|---|---|---|
| raw growth | **+0.449 / +0.459 / +0.499** | **-0.175 / -0.192 / -0.222** |
| raw exit rate | +0.431 / +0.428 / +0.433 | -0.247 / -0.238 / -0.241 |
| raw HHI | +0.073 / +0.077 / +0.137 | +0.111 / +0.172 / +0.285 |

All three rows are stated as the raw quantity, not the negated field the engine
scores. An earlier revision of this table printed the Base HHI row straight from
the `-hhi` field while de-negating the Robinhood one, which made concentration
look like it flipped sign. It does not. Corrected 2026-09-13.

**Two of the three inputs flip sign between the two cohorts: growth and exit
rate. Concentration keeps its sign.** That is the most important line in this
document and it is not a flattering one.

On Base, growth predicts more growth at +0.45 to +0.50, which is momentum plus
the survivorship bias already admitted above: no token in that universe was
allowed to be dead. On Robinhood, growth predicts *less* growth at -0.18 to
-0.22, which is mean reversion in a launch curve, the same sign v1 found on the
Base launch cohort. The split tracks cohort construction, not chain: survivor
universes show momentum, unfiltered launch universes show reversion. Base v3 is
the odd one out, and the thing that makes it odd is the selection rule, not the
chain.

Exit rate flips the same way and for the same reason. On the survivor cohort,
churn is a liveness proxy (a token with any pool activity is still alive) so it
correlates positively with forward holders. On the launch cohort, exits are
exits: holders leaving precede fewer holders. The v3 text called the positive
version "a liveness detector wearing a distribution-health costume", and the
launch cohort is the control that confirms it.

HHI is the one input that does **not** flip. It is positive on both cohorts,
+0.07 to +0.14 on Base and +0.11 to +0.29 on Robinhood, so concentration
*rising* precedes holder growth in both universes and simply runs stronger on
the launch cohort, where it is the strongest raw input at k=14. A plausible
reading is that a token consolidating into a few committed wallets early is a
token that has not been abandoned yet, and that this channel is louder before
survivorship filtering removes the abandoned ones. That is an interpretation,
not a tested claim.

One caveat on this table: the Base v3 scored rows were overwritten by the
Robinhood run, so the Base column is transcribed from the Finding 3 table
recorded on 2026-09-11 rather than re-derived from disk today. The Robinhood
column is re-derived from `out/backtest_v3.json`.

## What this means for the shipped instrument

- **The one positive result in this project was cohort-specific.** Arm A's
  +0.10 to +0.14 partial increment on Base survivors goes to zero on Robinhood
  launches. One replication attempt, one failure. It should not be quoted as a
  general property of the mapping, and the front page does not quote it.
- **Arm B remains fully explained by its inputs on both chains.** It should not
  be shipped as an instrument on either.
- **The inputs themselves are not chain-portable.** Anyone who fits knees or
  thresholds on one cohort and runs them on another is fitting the cohort. The
  knees in this repo were set on Base distributions and were deliberately *not*
  refitted for Robinhood, which is why the RH numbers are honest and weak rather
  than tuned and impressive.
- **What the worm is for.** It is a legible, deterministic rendering of three
  public quantities, recomputable by anyone from a public RPC with no key. That
  is a real thing and it is what colony.watch claims. It is not a predictor of
  holder growth, on either chain tested, and this document is the reason to
  believe that claim rather than the marketing one.

Reproduce: `node engine/feed_v3.mjs && node engine/backtest_v3.mjs && node
engine/partial_v3.mjs` against `data/snapshots_rh.json` for the Robinhood numbers
and `data/snapshots_base_archive.json` for the Base ones. Ingest log for the
corrected Robinhood run: `data/ingest_log_rh.txt`.
