# Does the El Niño ranking hold up? A backtest, 1981–2025

Winter Watch ranks resorts on a hypothesis about how El Niño moves winter
storms. Until now that hypothesis was an editorial position. This checks it
against 44 northern winters and 45 austral seasons of observed and reanalysed
precipitation, re-fits every resort's `ensoSensitivity`, and fixes the clamp
that stopped a record event like 2026–27 from ranking anything.

All the tables are generated: [`results.md`](results.md) holds every number
quoted here, and [`ranking.md`](ranking.md) holds the full before/after board.
`pnpm backtest` reproduces both from public data.

**This is a check of a model, not a forecast.** A ranking built on it is still
the app's own model, not a NOAA product.

## Short version

| Claim | Verdict | In one line |
| --- | --- | --- |
| 1. Southern tier wetter, northern tier drier | **Inconclusive** | The north dries reliably; the south gets wetter only in Southern California and New Mexico, not the Sierra. Whether the split clears noise depends on how you weight regions. |
| 2. Warm winters; base elevation decides the snow | **Supported** | Higher bases keep more of their precipitation as snow in 14 of 15 El Niño winters. The warmth itself is a northern-tier effect: the south is not warmer. |
| 3. The effect scales with strength | **Inconclusive** | The three strongest events split the country less than the weaker ones did, on average. |
| 4. Eastern-Pacific events express it more sharply | **Inconclusive** | Only two winters in the record qualify as eastern-Pacific, which is not enough to test. |

Out of sample, no version of the teleconnection, old or new, predicts the
size of a held-out winter's anomaly better than that resort's neutral-winter
average. The re-fitted sensitivities do rank resorts in the right order
somewhat better than the editorial ones (pattern correlation +0.18 against
−0.07). That is a weak signal, and the new sensitivities are small to match.

## Data and method

**Winters.** A northern winter is Dec–Mar, labelled by its two years. A
season counts as El Niño when its DJF Oceanic Niño Index is ≥ +0.5 °C and as
neutral when it is within ±0.5 °C, using CPC's
[ONI](https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt). That gives 15
El Niño and 13 neutral winters from 1981–82 to 2024–25, including all five the
job names (★ in the tables). La Niña winters are left out.

For the seven Southern Hemisphere resorts, the season is Jun–Sep of the year
the event develops, classified by the JJA ONI. That gives 8 El Niño seasons.
This is the honest analogue: an austral season skis under the developing
event, never under the following January's peak.

**Ocean state per winter.** The DJF (or JJA) mean of CPC's monthly
[ERSSTv5 Niño indices](https://www.cpc.ncep.noaa.gov/data/indices/ersst5.nino.mth.91-20.ascii)
(1991–2020 base) fills in Niño 1+2, 3.4 and 4. The script then calls the app's
own `classifyFlavor`, `eventMagnitude` and `teleconnectionGain` on them, so the
backtest tests the formula the site actually runs, not a copy of it.

**Precipitation.**

- **SNOTEL, where it exists.** For 33 western US resorts, the average of up to
  three [NRCS SNOTEL](https://www.nrcs.usda.gov/wps/portal/wcc/home/) stations
  within 40 km whose records start by Oct 1982, via the AWDB REST API. These are
  mountain gauges near the ski terrain.
- **Reanalysis, everywhere else.** For the other 51 resorts,
  [NASA POWER](https://power.larc.nasa.gov/) daily precipitation: MERRA-2,
  bias-corrected to GPCP observations, on a 0.5° × 0.625° grid. Its record
  starts 1 Jan 1981.
- **The two agree.** Where both exist, their winter anomalies correlate at a
  median r = 0.89. The exception is the Colorado Front Range (r 0.61–0.69):
  there the reanalysis cell takes in the plains, which get El Niño upslope
  storms the mountains do not. That gap is why the fits use SNOTEL wherever
  they can.

**Anomalies.** Each resort's Dec–Mar total is standardised against its own
neutral winters: z = (winter − neutral mean) / neutral SD. A z of +1 is a
winter one neutral-winter standard deviation wetter than a typical neutral
winter.

**Snow at the base.** This counts precipitation on days whose mean
temperature at the base elevation was ≤ +1 °C. The temperature is the
reanalysis cell's, carried to the base at 6.5 °C/km. It is a proxy: it says
whether the base was cold enough, not what fell on the mountain.

**Verdict rule, fixed before the tests ran.** A claim is *supported* when the
90% bootstrap interval excludes zero on the predicted side and at least 2 of 3
events agree. It is *contradicted* when the interval excludes zero on the
other side, and *inconclusive* otherwise. The bootstrap resamples winters,
never resorts: resorts in one winter share its weather, so counting them
separately would overstate n.

**n is small.** 15 northern El Niño winters, of which three are very strong
(1982–83, 1997–98, 2015–16) and two eastern-Pacific. 8 austral seasons. Every
interval below is wide for that reason, and no single-winter result should be
read as a finding.

## Claim 1: the north/south split

| Group | Expect | 1982–83 | 1997–98 | 2009–10 | 2015–16 | 2023–24 | 15-winter mean z | 90% CI | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Southern California | wet | +1.19 | +1.14 | +0.59 | −0.28 | +0.76 | +0.40 | +0.08 to +0.71 | Inconclusive (9/15 wet) |
| New Mexico | wet | +0.58 | +0.17 | +1.30 | −0.28 | −0.10 | +0.43 | +0.16 to +0.71 | Supported |
| Sierra Nevada | wet | +0.88 | +0.55 | −0.25 | +0.01 | −0.11 | −0.25 | −0.55 to +0.06 | Inconclusive, leans dry |
| Northern Rockies | dry | +0.27 | −0.37 | −1.26 | −0.06 | −0.43 | −0.59 | −0.86 to −0.33 | Supported |
| Pacific Northwest | dry | +0.47 | −0.35 | −1.39 | +1.12 | −0.11 | −0.34 | −0.65 to −0.02 | Supported |
| Western Canada | dry | +0.25 | −0.65 | −1.08 | +0.85 | +0.88 | −0.12 | −0.47 to +0.25 | Inconclusive |

The **north** half holds: the Northern Rockies were drier than neutral in 13
of 15 El Niño winters, and the Pacific Northwest in 11. The **south** half
holds only at the southern edge. Southern California and New Mexico lean wet;
Southern California misses the 2-of-3 bar at 9 of 15. The **Sierra**, which
the hypothesis puts with the south, does not get wetter. It was wet in the two
great eastern-Pacific winters (1982–83, 1997–98) and near or below normal in
most others, which matches the long-standing finding that northern and central
California sit near the node of the ENSO dipole.

The **split** (south tier minus north tier) is where the verdict turns on a
choice. Averaging regions equally gives +0.54 (90% CI +0.16 to +0.92),
supported. Averaging every resort equally lets six Sierra resorts outvote two
in Southern California: +0.24 (−0.17 to +0.62), inconclusive. Region-equal
weighting was chosen after seeing the resort-weighted result, so it does not
get to decide the verdict. **Inconclusive**, with a supported northern drying.

Two regions the hypothesis says nothing about stand out. The **Wasatch** is
drier in El Niño winters (−0.47, CI −0.82 to −0.11), though the editorial
sensitivity had it at +0.45. **Colorado** leans dry (−0.25). Both now have
small negative sensitivities.

## Claim 2: warm winters, and base elevation

| Test | Estimate | 90% CI | Winters agreeing | Verdict |
| --- | ---: | ---: | ---: | --- |
| Northern resorts warmer than neutral | +0.65 °C | +0.36 to +0.96 | 11/15 | Supported |
| Snow-fraction change per 1,000 ft of base | +1.4 pts | +0.9 to +1.9 | 14/15 | Supported |
| Snow lost beyond the precipitation anomaly, per unit of `magnitude × (1 − resilience)` | −1.23 z | −1.88 to −0.60 | 12/15 | Supported |

The **elevation** half is the best-supported part of the hypothesis. In
almost every El Niño winter, resorts with higher bases kept more of their
precipitation as snow. The app's own warm-storm term, `magnitude ×
(1 − resilience)`, predicts the snow lost beyond what the precipitation
anomaly implies.

The **warmth** is not universal. The Northern Rockies (+0.97 °C), Pacific
Northwest (+1.36), Western Canada (+1.74) and the East (+0.81) run warm.
Southern California (−0.29), New Mexico (−0.08) and the Sierra (+0.10) do
not: the extra storms there come with cloud and cooler days. That lines up
with the snow-fraction changes, which are positive in the south and negative
in the north. The warm-storm penalty still applies everywhere at the same
rate. A regional temperature term would be the next refinement (see
[follow-ups](#follow-ups-not-in-this-change)).

## Claim 3: strength scaling

| Test | Estimate | 90% CI | Verdict |
| --- | ---: | ---: | --- |
| Split per unit magnitude | +0.42 | −0.98 to +1.91 | Inconclusive |
| South-tier z per unit magnitude | +0.51 | −0.29 to +1.25 | Inconclusive |
| Mean split, Niño 3.4 ≥ 2.0 (3 winters) | +0.27 | — | — |
| Mean split, weaker events (12 winters) | +0.61 | — | — |

The three very strong events did not split the country more than the weaker
ones. 1982–83 and 1997–98 did; 2015–16 reversed it. Out of sample, a version
that ignores strength entirely predicts northern winters as well as the app's
magnitude-weighted gain or slightly better (skill +0.01 against +0.00), but
does worse in the austral seasons (−0.03 against +0.10), where strength does
help. **Inconclusive.**

This is also why the saturation fix keeps magnitude capped at Niño 3.4
+2 °C. There is no evidence in the record that a bigger event does more, so
the model should not extrapolate to 2026–27's +3.3 °C.

## Claim 4: eastern- vs central-Pacific flavour

| Test | Estimate | 90% CI | Verdict |
| --- | ---: | ---: | --- |
| Split per unit EP gradient, after magnitude | +0.06 | −2.19 to +1.01 | Inconclusive |
| Mean split, eastern-Pacific (1982–83, 1997–98) | +0.82 | — | — |
| Mean split, central-Pacific and mixed (13 winters) | +0.50 | — | — |

By the app's own classification (Niño 1+2 minus Niño 4 ≥ 1.5 °C, on DJF
means), only 1982–83 and 1997–98 are eastern-Pacific. Both split the country
strongly, which is suggestive and nothing more. 2009–10, the classic
central-Pacific winter, split the country more than either (+1.79). The flavour term cannot be
tested with two cases. **Inconclusive.**

## The 2015–16 miss

| Group | 1982–83 | 1997–98 | 2015–16 | 2015–16 vs neutral mean |
| --- | ---: | ---: | ---: | ---: |
| Southern California | +1.19 | +1.14 | −0.28 | −22% |
| Sierra Nevada | +0.88 | +0.55 | +0.01 | 0% |
| Pacific Northwest | +0.47 | −0.35 | +1.12 | +27% |
| Western Canada | +0.25 | −0.65 | +0.85 | +18% |

The strongest event in the record by ONI (+2.5) did the opposite of the
hypothesis. Southern California got 22% less than a neutral winter, and the
Pacific Northwest 27% more. By the app's own ocean reading, 2015–16 was
*Mixed*, not eastern-Pacific: DJF Niño 4 was +1.27 °C against Niño 1+2 at
+1.77, so its EP gradient is 0.17. That gives a gain of 0.80, against 1.28 for
1997–98. In other words, the flavour term already scales 2015–16 down by about
a third. It cannot flip the sign, and nothing else in the model can either.
The data agree with the common explanation: warmth spread west toward the
date line, and the storm track went north.

It is one winter. It does not prove the flavour term right, but it is the
clearest single reason not to read the ranking as a forecast.

## Out of sample

Leave one El Niño winter out: re-fit everything on the remaining El Niño and
neutral winters, predict the held-out winter at every resort, and repeat for
all 15. *Skill* is 1 − MSE / MSE of predicting zero, so 0 means no better
than the neutral average. *Pattern r* is the across-resort correlation of
predicted and observed anomalies in the held-out winter: does the model put
resorts in the right order?

| Model | Northern skill | Northern pattern r | Western N. America pattern r | Austral skill |
| --- | ---: | ---: | ---: | ---: |
| Predict zero (neutral climatology) | 0.00 | — | — | 0.00 |
| Editorial sensitivities (scale fitted in training) | −0.01 | −0.07 | −0.05 | +0.22 |
| Refit, each resort on its own | −0.03 | +0.18 | +0.26 | +0.15 |
| Refit, pooled within region | −0.02 | +0.16 | +0.24 | +0.15 |
| **Refit, pooled and shrunk toward zero (published)** | **+0.00** | **+0.18** | **+0.23** | **+0.10** |

What this says, plainly:

- **No model has skill on amplitude in the north.** The best is level with
  climatology.
- **The refit orders resorts better than the editorial values,** which were
  slightly worse than random in the north. Most of that comes from two sign
  errors: the Wasatch (editorial +0.45, data dry) and the US East (editorial
  about −0.4, data slightly wet).
- **The East has no usable signal either way** (pattern r ≈ 0). Its
  sensitivities are near zero to match.
- **The austral seasons are the one place with real skill.** Australia dries
  and central Chile wets in El Niño, and the editorial values beat the refit
  there. That rests on 7 resorts and 8 seasons, so the uniform method is kept
  rather than hand-picking a winner per hemisphere.

## Re-derived sensitivities

`ensoSensitivity` is now the slope of a resort's standardised precipitation
anomaly on the app's gain, fitted through the origin over El Niño and neutral
seasons. Two steps keep 15 winters from being over-read:

- **Pooled within region.** A resort keeps only the share of its departure
  from its region's slope that exceeds noise. Resorts in one region share
  their winters, so most of their apparent differences are noise.
- **Shrunk toward zero.** Each region's slope is multiplied by B (about
  0.2–0.3 in the north, 0.8 in the south), the share of between-region
  spread that exceeds noise. Out of sample this ties the unshrunk version on
  pattern and never loses on skill in the north, so the evidence does not
  justify larger values.

Typical changes:

| Region | Editorial | Fitted | Why it moved |
| --- | ---: | ---: | --- |
| Southern California | +0.90 | +0.19 | Right sign, much weaker than assumed |
| New Mexico (Taos) | +0.85 | +0.10 | Same |
| Sierra Nevada | +0.53 to +0.72 | −0.02 to +0.05 | No El Niño signal outside 1982–83 and 1997–98 |
| Wasatch | +0.30 to +0.45 | −0.08 to −0.09 | Wrong sign |
| Colorado | −0.05 to +0.35 | −0.09 to −0.14 | Mostly wrong sign, small |
| Northern Rockies | −0.10 to −0.35 | −0.11 to −0.20 | Right sign |
| Pacific Northwest | −0.45 to −0.65 | +0.03 to −0.13 | Right sign, weaker |
| US East | −0.10 to −0.50 | +0.02 to +0.16 | Wrong sign, no skill |
| Alps and Pyrenees | +0.10 to +0.32 | +0.06 to +0.19 | Right sign |
| Australia | −0.25 | −0.85 | Right sign, much stronger |
| Central Chile | +0.55 | +1.00 | Right sign, at the cap |

Every resort's row, with its own fit, region fit, standard errors, w and B,
is in [`results.md`](results.md#re-derived-sensitivities).
`pnpm backtest --apply` writes the published column into
`src/lib/resorts.ts`. The editorial values it replaced are kept in
[`editorial-sensitivities.json`](../../scripts/enso-backtest/editorial-sensitivities.json)
as the baseline the out-of-sample check compares against.

## Saturation fix

`magnitude` and `epGradient` both cap at 1, so 2026–27 (Niño 3.4 +3.3 °C,
Niño 1+2 +5.2, Niño 4 +1.3) maxes the gain at 1.3. The old `clamp(s × gain,
−1, 1)` then pinned every resort with s ≥ 0.77 at the same backbone score.

The effect is now `tanh(s × gain)`:

- **Near-linear in ordinary years.** tanh(0.3) = 0.29 and tanh(0.5) = 0.46,
  so weak and moderate events score almost as before.
- **No ties in a record year.** It is strictly increasing, so two resorts with
  different sensitivities can never tie, however strong the event.
- **The caps stay.** Claim 3 finds no support for extrapolating beyond
  +2 °C, so the inputs stay capped and only the output curve changes.

At the current week's CPC inputs (week of 7 Oct 2026):

| | Before | After |
| --- | ---: | ---: |
| Resorts pinned at ±1 | 3 | 0 |
| Distinct scores among the top 20 | 20 | 20 |
| Score spread, #1 to #20 | 38.5 | 47.2 |

## 2026–27, before and after

| # after | Resort | Score after | # before | Score before |
| ---: | --- | ---: | ---: | ---: |
| 1 | Valle Nevado | 90.8 | 7 | 83.4 |
| 2 | Taos Ski Valley | 54.6 | 1 | 98.1 |
| 3 | Mammoth Mountain | 50.8 | 2 | 94.3 |
| 4 | St. Anton am Arlberg | 50.7 | 23 | 56.8 |
| 5 | Big Bear Mountain Resort | 49.7 | 5 | 87.6 |
| 6 | Kirkwood | 49.4 | 4 | 87.8 |
| 7 | Chamonix Mont-Blanc | 48.8 | 21 | 58.8 |
| 8 | Zermatt | 48.7 | 19 | 59.8 |
| 9 | Snow Valley | 48.3 | 6 | 86.2 |
| 10 | Crans-Montana | 47.0 | 27 | 55.0 |

All 84 are in [`ranking.md`](ranking.md).

The board is **much flatter**. The old one called Taos, Mammoth and Big Bear
near-certainties at 88–98. The backtest does not support that confidence, and
the new board says so. In the north, standing now comes mostly from elevation
and snow climatology, with El Niño adding at most a few points. Only Valle
Nevado reaches *Favored*; most northern resorts sit in *Neutral*. That is a
visible change to the site. It is what the evidence supports, and it fits the
"model, not a forecast" framing better than the old board did.

If you would rather keep more of the old contrast, the same script also
writes the pooled-but-unshrunk values (the *Pooled* column in `results.md`).
They tie out of sample, but they are about four times larger in the north.
Making that switch is an editorial call, and should come with saying so on
the site.

## Limitations

- **Small n.** 15 northern El Niño winters, 3 very strong, 2 eastern-Pacific.
  8 austral seasons.
- **Coarse grids.** The reanalysis is about 50 km across, so outside SNOTEL
  coverage a resort's "precipitation" is its grid cell's. That includes the
  US East, Canada, Europe, Japan and the Southern Hemisphere.
- **A temperature proxy.** Snow at the base uses a daily-mean threshold on a
  lapsed cell temperature, not observed snowfall.
- **Monthly, not weekly, ocean data.** Historical gain uses monthly ERSSTv5;
  the live app reads weekly OISST. They differ by a few tenths of a degree.
- **La Niña untested.** The app flips the sign for La Niña with the same
  sensitivity. This backtest leaves La Niña winters out and does not check
  that symmetry.
- **2026–27 is outside the record.** Its weekly Niño 3.4 is the warmest in
  the CPC file.

## Follow-ups (not in this change)

These are proposals, not changes made here:

- **Warm-storm weight.** In the new sensitivity units, the backtest's
  −1.23 z per unit of `magnitude × (1 − resilience)` suggests a penalty
  nearer 60 points than the current 18. Changing it is a weight change and
  needs its own out-of-sample check.
- **Regional warmth.** Scale the warm-storm term by each region's El Niño
  temperature anomaly, since the south does not run warm.
- **La Niña.** Fit La Niña sensitivities separately, rather than assuming the
  sign flips.
- **A longer record.** Extend back to 1950 with GHCN-Daily stations or ERA5,
  which would add about eight El Niño winters.

## Reproduce

```bash
pnpm install
pnpm backtest            # downloads into .cache/, writes results.md
pnpm backtest --apply    # also rewrites ensoSensitivity in src/lib/resorts.ts
pnpm backtest:ranking after
```

`ranking-before.json` was produced by `pnpm backtest:ranking before` on the
editorial roster and the old clamp (`def84fb` plus this script). Every source
is free and needs no key: CPC, NRCS AWDB and NASA POWER. Downloads are cached
in `.cache/enso-backtest/`, which is git-ignored.
