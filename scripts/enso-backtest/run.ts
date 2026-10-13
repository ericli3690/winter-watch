import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { RESORTS } from '../../src/lib/resorts'
import editorial from './editorial-sensitivities.json'
import type { Resort } from '../../src/lib/types'
import {
  getErsstNino,
  getOni,
  getPower,
  getSnotelMonthlyPrecip,
  getSnotelStations,
  OUT_DIR,
  type SnotelStation,
} from './data'
import { hemisphere, seasonEnso, seasonTotals, SNOW_LINE_C, type Hemisphere, type SeasonEnso, type SeasonTotals } from './seasons'
import { bootstrap, fmt, fmtU, mean, ols, pearson, sd, slopeThroughOrigin, spearman, sum } from './stats'

/**
 * The El Nino winters the job names, which every table reports individually.
 *
 * @remarks
 * Labelled by their January; the southern season is the austral winter of the developing year.
 */
const REQUIRED_NORTH = [1983, 1998, 2010, 2016, 2024]

/** The austral seasons inside the same five events. */
const REQUIRED_SOUTH = [1982, 1997, 2009, 2015, 2023]

/** An analysis group: resorts that share a regional climate, used for composites and pooling. */
interface Group {
  id: string
  label: string
  /** What the hypothesis says an El Nino does here, where it says anything. */
  expect: 'wet' | 'dry' | null
  members: (r: Resort) => boolean
}

/**
 * Groups finer than the app's `RegionId`, because the hypothesis is about finer regions.
 *
 * @remarks
 * - `us-west` mixes the Sierra and the Wasatch, which sit on opposite sides of the split.
 * - `us-rockies` mixes Colorado with the Tetons and Montana.
 */
const GROUPS: Group[] = [
  { id: 'socal', label: 'Southern California', expect: 'wet', members: (r) => r.region === 'us-southwest' && r.lon < -110 },
  { id: 'new-mexico', label: 'New Mexico', expect: 'wet', members: (r) => r.region === 'us-southwest' && r.lon >= -110 },
  { id: 'sierra', label: 'Sierra Nevada', expect: 'wet', members: (r) => r.region === 'us-west' && r.lon < -117 },
  { id: 'wasatch', label: 'Wasatch', expect: null, members: (r) => r.region === 'us-west' && r.lon >= -117 },
  { id: 'colorado', label: 'Colorado', expect: null, members: (r) => r.region === 'us-rockies' && r.lat < 41 },
  { id: 'n-rockies', label: 'Northern Rockies', expect: 'dry', members: (r) => r.region === 'us-rockies' && r.lat >= 41 },
  { id: 'pnw', label: 'Pacific Northwest', expect: 'dry', members: (r) => r.region === 'us-pnw' },
  { id: 'canada-west', label: 'Western Canada', expect: 'dry', members: (r) => r.region === 'canada-west' },
  { id: 'us-east', label: 'US East', expect: null, members: (r) => r.region === 'us-east' },
  { id: 'canada-east', label: 'Eastern Canada', expect: null, members: (r) => r.region === 'canada-east' },
  { id: 'europe', label: 'Alps and Pyrenees', expect: null, members: (r) => r.region === 'europe' },
  { id: 'japan', label: 'Japan', expect: null, members: (r) => r.region === 'japan' },
  { id: 'australia', label: 'Australia', expect: null, members: (r) => r.region === 'south-pacific' && r.lon < 160 },
  { id: 'new-zealand', label: 'New Zealand', expect: null, members: (r) => r.region === 'south-pacific' && r.lon >= 160 },
  { id: 'chile', label: 'Central Chile', expect: null, members: (r) => r.region === 'south-america' },
]

/** The analysis group a resort falls in; every resort falls in exactly one. */
const groupOf = (r: Resort) => GROUPS.find((g) => g.members(r))!

/** Every resort's seasons, as anomalies against its own neutral winters. */
interface ResortSeries {
  resort: Resort
  group: Group
  h: Hemisphere
  totals: Map<number, SeasonTotals>
  /** Where the precipitation every fit uses comes from. */
  source: 'SNOTEL' | 'POWER'
  /** The SNOTEL stations averaged, when `source` is SNOTEL. */
  stations: SnotelStation[]
  /** Seasonal precipitation from `source`, mm. */
  precipMm: Map<number, number>
  /** Standardised precipitation anomaly from `source`: (season - neutral mean) / neutral SD. */
  zPrecip: Map<number, number>
  /** The same from the reanalysis, kept to compare against SNOTEL. */
  zPrecipPower: Map<number, number>
  /** The same for reanalysis precipitation that fell at or below the snow line at the base. */
  zSnow: Map<number, number>
  /** Share of precipitation below the snow line, minus its neutral-winter mean. */
  dSnowFraction: Map<number, number>
  /** Mean temperature at the base, minus its neutral-winter mean, degrees C. */
  dTempC: Map<number, number>
  neutralPrecipMm: number
}

/** Standardise one quantity against the neutral seasons. */
function anomalies<T>(totals: Map<number, T>, neutral: number[], pick: (t: T) => number) {
  const base = neutral.filter((y) => totals.has(y)).map((y) => pick(totals.get(y)!))
  const m = mean(base)
  const s = sd(base)
  const z = new Map<number, number>()
  const d = new Map<number, number>()
  for (const [y, t] of totals) {
    z.set(y, (pick(t) - m) / s)
    d.set(y, pick(t) - m)
  }
  return { z, d, mean: m }
}

/** A fitted teleconnection: `z = s x gain`, through the origin. */
interface Fit {
  s: number
  se: number
}

/** How a model turns a season's ENSO state into the regressor. */
type GainFn = (e: SeasonEnso) => number

/** The app's gain: magnitude times flavour, from {@link teleconnectionGain}. */
const appGain: GainFn = (e) => e.gain

/** Strength ignored: every El Nino counts the same. */
const constantGain: GainFn = (e) => (e.phase === 'El Nino' ? 1 : 0)

/** Flavour ignored: magnitude alone. */
const magnitudeGain: GainFn = (e) => (e.phase === 'La Nina' ? -1 : 1) * e.magnitude

/** Fit one series on the given seasons. */
function fit(z: Map<number, number>, years: number[], enso: Map<number, SeasonEnso>, gain: GainFn): Fit {
  const ys = years.filter((y) => z.has(y) && enso.has(y))
  const { b, se } = slopeThroughOrigin(
    ys.map((y) => gain(enso.get(y)!)),
    ys.map((y) => z.get(y)!),
  )
  return { s: b, se }
}

/** A resort's sensitivity: its own fit, its group's, and the two pooled. */
interface Sensitivity {
  raw: Fit
  group: Fit
  /** Weight on the resort's own departure from its group. */
  w: number
  /** Shrinkage of the group toward zero; 1 when not shrinking. */
  b: number
  pooled: number
}

/**
 * Empirical-Bayes pooling of each resort toward its group.
 *
 * @remarks
 * - Resorts in one group share their winters, so their fits share most of their noise.
 * - Only the departure from the group mean is shrunk, by how much of its spread exceeds noise.
 * - The group's own fit is kept: that is the data, not a prior.
 */
function sensitivities(
  series: ResortSeries[],
  years: number[],
  enso: Map<number, SeasonEnso>,
  gain: GainFn,
  toZero = false,
): Map<string, Sensitivity> {
  const out = new Map<string, Sensitivity>()
  const groupFits = new Map<string, Fit>()
  for (const g of GROUPS) {
    const members = series.filter((s) => s.group.id === g.id)
    if (members.length === 0) continue
    const groupZ = new Map<number, number>()
    for (const y of years) {
      const vals = members.map((m) => m.zPrecip.get(y)).filter((v): v is number => v !== undefined)
      if (vals.length === members.length) groupZ.set(y, mean(vals))
    }
    groupFits.set(g.id, fit(groupZ, years, enso, gain))
  }
  // Between-group spread beyond noise; with toZero, each group is shrunk toward no signal by it.
  const fits = [...groupFits.values()]
  const tauG2 = Math.max(0, mean(fits.map((f) => f.s ** 2)) - mean(fits.map((f) => f.se ** 2)))
  for (const g of GROUPS) {
    const members = series.filter((s) => s.group.id === g.id)
    if (members.length === 0) continue
    const groupZ = new Map<number, number>()
    for (const y of years) {
      const vals = members.map((m) => m.zPrecip.get(y)).filter((v): v is number => v !== undefined)
      if (vals.length === members.length) groupZ.set(y, mean(vals))
    }
    const own = groupFits.get(g.id)!
    const shrink = toZero ? tauG2 / (tauG2 + own.se ** 2) : 1
    const groupFit = own
    const departures = members.map((m) => {
      const d = new Map<number, number>()
      for (const [y, gz] of groupZ) if (m.zPrecip.has(y)) d.set(y, m.zPrecip.get(y)! - gz)
      return fit(d, years, enso, gain)
    })
    // Between-resort spread beyond what noise alone would give.
    const tau2 =
      members.length > 2 ? Math.max(0, sd(departures.map((d) => d.s)) ** 2 - mean(departures.map((d) => d.se ** 2))) : 0
    members.forEach((m, i) => {
      const d = departures[i]
      // A resort sharing its group's only cell has no departure to weigh.
      const w = members.length === 1 || d.se === 0 ? 1 : tau2 / (tau2 + d.se ** 2)
      out.set(m.resort.id, {
        raw: fit(m.zPrecip, years, enso, gain),
        group: own,
        w,
        b: shrink,
        pooled: shrink * (groupFit.s + w * d.s),
      })
    })
  }
  return out
}

/** The value written to `resorts.ts`: pooled, clipped to the type's range, two decimals. */
const published = (s: number) => Math.round(Math.max(-1, Math.min(1, s)) * 100) / 100

/** Mean anomaly over a set of resorts in one season. */
function composite(series: ResortSeries[], year: number, pick: (s: ResortSeries) => Map<number, number>): number {
  const vals = series.map((s) => pick(s).get(year)).filter((v): v is number => v !== undefined)
  return vals.length ? mean(vals) : NaN
}

/** A pre-registered verdict from a bootstrap interval and the share of events that agree. */
function verdict(expectedSign: 1 | -1, ci: { lo: number; hi: number }, agreeShare: number): string {
  const excludesZero = ci.lo > 0 || ci.hi < 0
  const sign = ci.lo > 0 ? 1 : ci.hi < 0 ? -1 : 0
  if (excludesZero && sign === expectedSign && agreeShare >= 2 / 3) return '**Supported**'
  if (excludesZero && sign === -expectedSign) return '**Contradicted**'
  return '**Inconclusive**'
}

/** Markdown table from rows of cells. */
function table(head: string[], rows: (string | number)[][], align?: string[]): string {
  const a = align ?? head.map((_, i) => (i === 0 ? '---' : '---:'))
  return [`| ${head.join(' | ')} |`, `| ${a.join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

/** Nearest SNOTEL stations with a record long enough to cover the backtest. */
function nearbyStations(r: Resort, stations: SnotelStation[]): SnotelStation[] {
  const km = (s: SnotelStation) => {
    const dLat = ((s.lat - r.lat) * Math.PI) / 180
    const dLon = ((s.lon - r.lon) * Math.PI) / 180
    const a = Math.sin(dLat / 2) ** 2 + Math.cos((r.lat * Math.PI) / 180) * Math.cos((s.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
    return 6371 * 2 * Math.asin(Math.sqrt(a))
  }
  return stations
    .filter((s) => s.beginDate <= '1982-10-01' && km(s) <= 40)
    .sort((a, b) => km(a) - km(b))
    .slice(0, 3)
}

/** The groups the hypothesis is about, plus the two between them. */
const WESTERN_NA = new Set(['socal', 'new-mexico', 'sierra', 'wasatch', 'colorado', 'n-rockies', 'pnw', 'canada-west'])

/** Millimetres per inch; SNOTEL reports inches. */
const MM_PER_IN = 25.4

/** Winters a SNOTEL record needs before it replaces the reanalysis: all but a couple of the 44. */
const MIN_SNOTEL_WINTERS = 40

/**
 * The hand-set sensitivities this backtest replaced, as they stood at def84fb.
 *
 * @remarks
 * Frozen here because `--apply` overwrites the roster, and the baseline must not move with it.
 */
const EDITORIAL: Record<string, number> = editorial

/** States that hold a western US resort, for the SNOTEL listing. */
const SNOTEL_STATES = ['CA', 'UT', 'CO', 'NM', 'WY', 'MT', 'ID', 'WA', 'OR']

/** Western US regions, where SNOTEL can check the reanalysis. */
const SNOTEL_REGIONS = new Set(['us-west', 'us-rockies', 'us-southwest', 'us-pnw'])

/** Dec-Mar SNOTEL precipitation, averaged over the stations near one resort, mm. */
async function snotelSeasons(stations: SnotelStation[]): Promise<Map<number, number>> {
  const perStation = await Promise.all(stations.map((s) => getSnotelMonthlyPrecip(s.triplet)))
  const out = new Map<number, number>()
  for (let year = 1982; year <= 2025; year++) {
    const keys = [`${year - 1}-12`, `${year}-01`, `${year}-02`, `${year}-03`]
    const totals = perStation
      .map((m) => (keys.every((k) => m.has(k)) ? sum(keys.map((k) => m.get(k)!)) : NaN))
      .filter(Number.isFinite)
    if (totals.length > 0) out.set(year, mean(totals) * MM_PER_IN)
  }
  return out
}

/** One leave-one-season-out run: hold each El Nino season out, fit the rest, predict it. */
interface CvResult {
  model: string
  /** 1 - MSE / MSE of predicting zero (the neutral climatology). */
  skill: number
  rmse: number
  /** Mean across held-out seasons of the across-resort correlation of predicted and observed. */
  patternR: number
  perSeason: { year: number; rmse: number; r: number }[]
}

/** Score every model on every held-out El Nino season. */
function crossValidate(
  series: ResortSeries[],
  fitYears: number[],
  ninoYears: number[],
  enso: Map<number, SeasonEnso>,
  scoreOn: (s: ResortSeries) => boolean = () => true,
): CvResult[] {
  type Predictor = (train: number[], heldOut: number) => Map<string, number>
  const pooledWith =
    (gain: GainFn, toZero = false): Predictor =>
    (train, h) => {
      const sens = sensitivities(series, train, enso, gain, toZero)
      return new Map(series.map((s) => [s.resort.id, sens.get(s.resort.id)!.pooled * gain(enso.get(h)!)]))
    }
  const models: [string, Predictor][] = [
    ['Climatology (predict zero)', () => new Map(series.map((s) => [s.resort.id, 0]))],
    [
      'Editorial sensitivities, scale fitted on training seasons',
      (train, h) => {
        // The editorial values have no units, so they get one fitted scale factor.
        const xs: number[] = []
        const ys: number[] = []
        for (const s of series)
          for (const y of train)
            if (s.zPrecip.has(y)) {
              xs.push(EDITORIAL[s.resort.id] * appGain(enso.get(y)!))
              ys.push(s.zPrecip.get(y)!)
            }
        const k = slopeThroughOrigin(xs, ys).b
        return new Map(series.map((s) => [s.resort.id, k * EDITORIAL[s.resort.id] * appGain(enso.get(h)!)]))
      },
    ],
    [
      'Refit, each resort on its own',
      (train, h) =>
        new Map(series.map((s) => [s.resort.id, fit(s.zPrecip, train, enso, appGain).s * appGain(enso.get(h)!)])),
    ],
    ['Refit, pooled to group', pooledWith(appGain)],
    ['Refit, pooled, shrunk toward zero (published)', pooledWith(appGain, true)],
    ['Published, strength ignored', pooledWith(constantGain, true)],
    ['Published, flavour ignored', pooledWith(magnitudeGain, true)],
  ]
  return models.map(([model, predict]) => {
    let se = 0
    let se0 = 0
    let n = 0
    const perSeason = ninoYears.map((h) => {
      const pred = predict(
        fitYears.filter((y) => y !== h),
        h,
      )
      const obs: number[] = []
      const prd: number[] = []
      for (const s of series.filter(scoreOn)) {
        const o = s.zPrecip.get(h)
        if (o === undefined) continue
        obs.push(o)
        prd.push(pred.get(s.resort.id)!)
      }
      const e = sum(obs.map((o, i) => (o - prd[i]) ** 2))
      se += e
      se0 += sum(obs.map((o) => o * o))
      n += obs.length
      return { year: h, rmse: Math.sqrt(e / obs.length), r: sd(prd) > 0 ? pearson(prd, obs) : NaN }
    })
    const rs = perSeason.map((p) => p.r).filter(Number.isFinite)
    return { model, skill: 1 - se / se0, rmse: Math.sqrt(se / n), patternR: rs.length ? mean(rs) : NaN, perSeason }
  })
}

/** Rewrite each resort's `ensoSensitivity` in the roster, leaving every other line alone. */
async function applySensitivities(values: Map<string, number>) {
  const path = join(process.cwd(), 'src', 'lib', 'resorts.ts')
  const lines = (await readFile(path, 'utf8')).split('\n')
  let current: string | null = null
  let changed = 0
  for (let i = 0; i < lines.length; i++) {
    const id = /^ {4}id: '([^']+)',$/.exec(lines[i])
    if (id) current = id[1]
    const m = /^( {4}ensoSensitivity: )(-?\d+(?:\.\d+)?),$/.exec(lines[i])
    if (m && current && values.has(current)) {
      lines[i] = `${m[1]}${values.get(current)!.toFixed(2)},`
      changed++
      current = null
    }
  }
  if (changed !== values.size) throw new Error(`expected ${values.size} ensoSensitivity lines, rewrote ${changed}`)
  await writeFile(path, lines.join('\n'))
  console.log(`rewrote ${changed} ensoSensitivity values in src/lib/resorts.ts`)
}

/** Fit, test and tabulate, then optionally write the sensitivities back to the roster. */
async function main() {
  const apply = process.argv.includes('--apply')
  const [oni, nino] = await Promise.all([getOni(), getErsstNino()])
  const yearsBy: Record<Hemisphere, number[]> = {
    // POWER starts 1 Jan 1981: 1981-82 is the first whole Dec-Mar, 1981 the first Jun-Sep.
    north: Array.from({ length: 2025 - 1982 + 1 }, (_, i) => 1982 + i),
    south: Array.from({ length: 2025 - 1981 + 1 }, (_, i) => 1981 + i),
  }
  const ensoBy: Record<Hemisphere, Map<number, SeasonEnso>> = {
    north: seasonEnso('north', yearsBy.north, oni, nino),
    south: seasonEnso('south', yearsBy.south, oni, nino),
  }
  const phaseYears = (h: Hemisphere, phase: SeasonEnso['phase']) =>
    [...ensoBy[h].values()].filter((e) => e.phase === phase).map((e) => e.year)

  const stations = await getSnotelStations(SNOTEL_STATES)
  const series: ResortSeries[] = []
  for (const r of RESORTS) {
    const h = hemisphere(r)
    const totals = seasonTotals(h, await getPower(r))
    const neutral = phaseYears(h, 'Neutral')
    const powerPrecip = new Map([...totals].map(([y, t]) => [y, t.precipMm]))
    // Observed beats reanalysis where a long SNOTEL record sits near the mountain.
    const near = h === 'north' && SNOTEL_REGIONS.has(r.region) ? nearbyStations(r, stations) : []
    const snotel = near.length > 0 ? await snotelSeasons(near) : new Map<number, number>()
    const useSnotel = snotel.size >= MIN_SNOTEL_WINTERS
    const precipMm = useSnotel ? snotel : powerPrecip
    const p = anomalies(precipMm, neutral, (v) => v)
    const s = anomalies(totals, neutral, (t) => t.snowAtBaseMm)
    const f = anomalies(totals, neutral, (t) => (t.precipMm > 0 ? t.snowAtBaseMm / t.precipMm : 0))
    const t = anomalies(totals, neutral, (x) => x.meanTempC)
    series.push({
      resort: r,
      group: groupOf(r),
      h,
      totals,
      source: useSnotel ? 'SNOTEL' : 'POWER',
      stations: useSnotel ? near : [],
      precipMm,
      zPrecip: p.z,
      zPrecipPower: anomalies(powerPrecip, neutral, (v) => v).z,
      zSnow: s.z,
      dSnowFraction: f.d,
      dTempC: t.d,
      neutralPrecipMm: p.mean,
    })
  }

  const md: string[] = [
    '# ENSO backtest: generated tables',
    '',
    'Generated by `pnpm backtest`. Every number below is recomputed from the downloads on each run;',
    'the method and the verdicts are explained in [the write-up](README.md).',
    '',
  ]

  // Seasons and their ocean state.
  for (const h of ['north', 'south'] as const) {
    const enso = ensoBy[h]
    const ninos = phaseYears(h, 'El Nino')
    md.push(
      `## ${h === 'north' ? 'Northern winters (Dec–Mar)' : 'Austral seasons (Jun–Sep)'}: ENSO state`,
      '',
      `${ninos.length} El Niño, ${phaseYears(h, 'Neutral').length} neutral and ${phaseYears(h, 'La Nina').length} La Niña seasons in ${yearsBy[h][0]}–${yearsBy[h][yearsBy[h].length - 1]}.`,
      `Phase from the ${h === 'north' ? 'DJF' : 'JJA'} ONI; region anomalies are the ${h === 'north' ? 'DJF' : 'JJA'} mean of monthly ERSSTv5; gain is the app’s \`teleconnectionGain\`.`,
      'La Niña seasons are left out of every fit.',
      '',
      table(
        ['Season', 'ONI', 'Niño 3.4', 'Niño 1+2', 'Niño 4', 'Flavour', 'Magnitude', 'EP gradient', 'Gain'],
        ninos.map((y) => {
          const e = enso.get(y)!
          return [
            e.label,
            fmt(e.oni, 1),
            fmt(e.nino34),
            fmt(e.nino12),
            fmt(e.nino4),
            e.flavor,
            fmtU(e.magnitude),
            fmtU(e.epGradient),
            fmtU(e.gain),
          ]
        }),
      ),
      '',
    )
  }

  // Group composites in the El Nino seasons.
  for (const h of ['north', 'south'] as const) {
    const enso = ensoBy[h]
    const ninos = phaseYears(h, 'El Nino')
    const req = h === 'north' ? REQUIRED_NORTH : REQUIRED_SOUTH
    const groups = GROUPS.filter((g) => series.some((s) => s.group.id === g.id && s.h === h))
    md.push(
      `## ${h === 'north' ? 'Northern' : 'Austral'} precipitation anomaly by group (z, against neutral seasons)`,
      '',
      'Each cell is the mean over the group’s resorts of the standardised seasonal precipitation anomaly.',
      'Composite is the mean over every El Niño season, with its 90% bootstrap interval over seasons.',
      '',
      table(
        ['Group', 'Resorts', 'Expect', ...req.map((y) => enso.get(y)!.label), 'Composite', '90% CI', 'Wet seasons', 'Verdict'],
        groups.map((g) => {
          const members = series.filter((s) => s.group.id === g.id)
          const per = ninos.map((y) => composite(members, y, (s) => s.zPrecip))
          const ci = bootstrap(per, mean)
          return [
            g.label,
            members.length,
            g.expect ?? '—',
            ...req.map((y) => fmt(composite(members, y, (s) => s.zPrecip))),
            fmt(mean(per)),
            `${fmt(ci.lo)} to ${fmt(ci.hi)}`,
            `${per.filter((v) => v > 0).length}/${per.length}`,
            g.expect === null
              ? '—'
              : g.expect === 'wet'
                ? verdict(1, ci, per.filter((v) => v > 0).length / per.length)
                : verdict(-1, ci, per.filter((v) => v < 0).length / per.length),
          ]
        }),
      ),
      '',
    )
  }

  // Claim 1: north/south split.
  const north = series.filter((s) => s.h === 'north')
  const ensoN = ensoBy.north
  const ninosN = phaseYears('north', 'El Nino')
  const neutralN = phaseYears('north', 'Neutral')
  const south = north.filter((s) => s.group.expect === 'wet')
  const northTier = north.filter((s) => s.group.expect === 'dry')
  // Each group counts once, so six Sierra resorts sharing a storm track do not outvote Southern California.
  const tier = (members: ResortSeries[], y: number) =>
    mean([...new Set(members.map((m) => m.group.id))].map((id) => composite(members.filter((m) => m.group.id === id), y, (s) => s.zPrecip)))
  const split = (y: number) => tier(south, y) - tier(northTier, y)
  const splitPer = ninosN.map(split)
  const splitCi = bootstrap(splitPer, mean)
  const southPer = ninosN.map((y) => tier(south, y))
  const northPer = ninosN.map((y) => tier(northTier, y))
  // The weighting first tried, kept so the choice of weighting is visible.
  const splitByResort = ninosN.map((y) => composite(south, y, (s) => s.zPrecip) - composite(northTier, y, (s) => s.zPrecip))
  const splitByResortCi = bootstrap(splitByResort, mean)
  const southCi = bootstrap(southPer, mean)
  const northCi = bootstrap(northPer, mean)
  md.push(
    '## Claim 1: north/south split',
    '',
    `South tier: ${GROUPS.filter((g) => g.expect === 'wet').map((g) => g.label).join(', ')} (${south.length} resorts).`,
    `North tier: ${GROUPS.filter((g) => g.expect === 'dry').map((g) => g.label).join(', ')} (${northTier.length} resorts).`,
    'Each tier is the mean of its groups’ mean z, so every group counts once.',
    'Split = south tier minus north tier, per El Niño winter. ★ marks the five winters the job names.',
    '',
    table(
      ['Winter', 'South z', 'North z', 'Split'],
      ninosN.map((y) => [ensoN.get(y)!.label + (REQUIRED_NORTH.includes(y) ? ' ★' : ''), fmt(tier(south, y)), fmt(tier(northTier, y)), fmt(split(y))]),
    ),
    '',
    table(
      ['Quantity', 'Mean', '90% CI', 'Seasons agreeing', 'Verdict'],
      [
        ['South tier wetter', fmt(mean(southPer)), `${fmt(southCi.lo)} to ${fmt(southCi.hi)}`, `${southPer.filter((v) => v > 0).length}/${southPer.length}`, verdict(1, southCi, southPer.filter((v) => v > 0).length / southPer.length)],
        ['North tier drier', fmt(mean(northPer)), `${fmt(northCi.lo)} to ${fmt(northCi.hi)}`, `${northPer.filter((v) => v < 0).length}/${northPer.length}`, verdict(-1, northCi, northPer.filter((v) => v < 0).length / northPer.length)],
        ['Split', fmt(mean(splitPer)), `${fmt(splitCi.lo)} to ${fmt(splitCi.hi)}`, `${splitPer.filter((v) => v > 0).length}/${splitPer.length}`, verdict(1, splitCi, splitPer.filter((v) => v > 0).length / splitPer.length)],
        ['Split, every resort weighted equally instead', fmt(mean(splitByResort)), `${fmt(splitByResortCi.lo)} to ${fmt(splitByResortCi.hi)}`, `${splitByResort.filter((v) => v > 0).length}/${splitByResort.length}`, verdict(1, splitByResortCi, splitByResort.filter((v) => v > 0).length / splitByResort.length)],
      ],
    ),
    '',
  )

  // Claim 2: warm winters and elevation.
  const tempRows = GROUPS.filter((g) => north.some((s) => s.group.id === g.id)).map((g) => {
    const members = north.filter((s) => s.group.id === g.id)
    const per = ninosN.map((y) => composite(members, y, (s) => s.dTempC))
    const ci = bootstrap(per, mean)
    const fr = ninosN.map((y) => composite(members, y, (s) => s.dSnowFraction))
    return [g.label, fmtU(mean(members.map((m) => m.resort.baseElevationFt)), 0), fmt(mean(per)), `${fmt(ci.lo)} to ${fmt(ci.hi)}`, fmt(mean(fr) * 100, 1)]
  })
  // The app's warm-storm term: snow lost beyond the precipitation anomaly, against magnitude x (1 - resilience).
  const resilience = (r: Resort) => {
    const n = (v: number, lo: number, hi: number) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
    return 0.65 * n(r.baseElevationFt, 2000, 9500) + 0.35 * n(r.summitElevationFt, 4000, 13000)
  }
  const penaltyCases = ninosN.map((y) => ({
    y,
    xs: north.filter((s) => s.zSnow.has(y)).map((s) => ensoN.get(y)!.magnitude * (1 - resilience(s.resort))),
    ys: north.filter((s) => s.zSnow.has(y)).map((s) => s.zSnow.get(y)! - s.zPrecipPower.get(y)!),
  }))
  const pooledSlope = (cases: typeof penaltyCases) => ols(cases.flatMap((c) => c.xs), cases.flatMap((c) => c.ys)).b
  const penaltySlope = pooledSlope(penaltyCases)
  const penaltyCi = bootstrap(penaltyCases, pooledSlope)
  const penaltyAgree = penaltyCases.filter((c) => ols(c.xs, c.ys).b < 0).length
  // Does a high base actually keep its snow fraction better? Slope of the fraction change against base elevation.
  const elevCases = ninosN.map((y) => ({
    xs: north.filter((s) => s.dSnowFraction.has(y)).map((s) => s.resort.baseElevationFt / 1000),
    ys: north.filter((s) => s.dSnowFraction.has(y)).map((s) => s.dSnowFraction.get(y)! * 100),
  }))
  const elevSlope = (cases: typeof elevCases) => ols(cases.flatMap((c) => c.xs), cases.flatMap((c) => c.ys)).b
  const elevCi = bootstrap(elevCases, elevSlope)
  const warmPer = ninosN.map((y) => composite(north, y, (s) => s.dTempC))
  const warmCi = bootstrap(warmPer, mean)
  md.push(
    '## Claim 2: El Niño winters run warm, and base elevation decides the snow',
    '',
    `Snow at the base is precipitation on days whose mean temperature at the base elevation was at or below ${SNOW_LINE_C} °C.`,
    'Temperature is the reanalysis cell’s, lapsed to the base at 6.5 °C/km.',
    '',
    table(
      ['Group', 'Mean base ft', 'El Niño temp anomaly °C', '90% CI', 'Snow-fraction change, pts'],
      tempRows,
    ),
    '',
    table(
      ['Test', 'Estimate', '90% CI', 'Seasons agreeing', 'Verdict'],
      [
        ['All northern resorts warmer than neutral (°C)', fmt(mean(warmPer)), `${fmt(warmCi.lo)} to ${fmt(warmCi.hi)}`, `${warmPer.filter((v) => v > 0).length}/${warmPer.length}`, verdict(1, warmCi, warmPer.filter((v) => v > 0).length / warmPer.length)],
        ['Snow-fraction change per 1,000 ft of base (pts)', fmt(mean(elevCases.map((c) => ols(c.xs, c.ys).b))), `${fmt(elevCi.lo)} to ${fmt(elevCi.hi)}`, `${elevCases.filter((c) => ols(c.xs, c.ys).b > 0).length}/${elevCases.length}`, verdict(1, elevCi, elevCases.filter((c) => ols(c.xs, c.ys).b > 0).length / elevCases.length)],
        ['Warm-storm term: snow z minus precip z per unit of magnitude × (1 − resilience)', fmt(penaltySlope), `${fmt(penaltyCi.lo)} to ${fmt(penaltyCi.hi)}`, `${penaltyAgree}/${penaltyCases.length}`, verdict(-1, penaltyCi, penaltyAgree / penaltyCases.length)],
      ],
    ),
    '',
  )

  // Claim 3: strength scaling, and claim 4: flavour.
  const strength = ninosN.map((y) => ensoN.get(y)!.magnitude)
  const ep = ninosN.map((y) => ensoN.get(y)!.epGradient)
  const strengthCases = ninosN.map((y, i) => ({ x: strength[i], y: split(y), s: southPer[i] }))
  const caseSlope = (pick: 'y' | 's') => (c: typeof strengthCases) => ols(c.map((d) => d.x), c.map((d) => d[pick])).b
  const sSplitCi = bootstrap(strengthCases, caseSlope('y'))
  const sSouthCi = bootstrap(strengthCases, caseSlope('s'))
  const flavourCases = ninosN.map((y, i) => ({ x: ep[i], m: strength[i], y: split(y) }))
  // Flavour against the split after taking out what magnitude explains.
  const flavourSlope = (c: typeof flavourCases) => {
    const m = ols(c.map((d) => d.m), c.map((d) => d.y))
    return ols(c.map((d) => d.x), c.map((d, i) => d.y - m.a - m.b * c[i].m)).b
  }
  const fCi = bootstrap(flavourCases, flavourSlope)
  const strong = ninosN.filter((y) => Math.abs(ensoN.get(y)!.nino34) >= 2)
  const rest = ninosN.filter((y) => Math.abs(ensoN.get(y)!.nino34) < 2)
  const ep_ = ninosN.filter((y) => ensoN.get(y)!.flavor === 'Eastern Pacific')
  const cp_ = ninosN.filter((y) => ensoN.get(y)!.flavor !== 'Eastern Pacific')
  md.push(
    '## Claim 3: the effect scales with event strength',
    '',
    table(
      ['Test', 'Estimate', '90% CI', 'Verdict'],
      [
        ['Split per unit magnitude (OLS over El Niño winters)', fmt(caseSlope('y')(strengthCases)), `${fmt(sSplitCi.lo)} to ${fmt(sSplitCi.hi)}`, verdict(1, sSplitCi, 1)],
        ['South-tier z per unit magnitude', fmt(caseSlope('s')(strengthCases)), `${fmt(sSouthCi.lo)} to ${fmt(sSouthCi.hi)}`, verdict(1, sSouthCi, 1)],
        ['Spearman ρ, magnitude vs split', fmt(spearman(strength, splitPer)), '—', '—'],
        [`Mean split, Niño 3.4 ≥ 2.0 (${strong.map((y) => ensoN.get(y)!.label).join(', ')})`, fmt(mean(strong.map(split))), '—', '—'],
        [`Mean split, weaker events (n = ${rest.length})`, fmt(mean(rest.map(split))), '—', '—'],
      ],
    ),
    '',
    '## Claim 4: eastern-Pacific events express it more sharply',
    '',
    table(
      ['Test', 'Estimate', '90% CI', 'Verdict'],
      [
        ['Split per unit EP gradient, after magnitude', fmt(flavourSlope(flavourCases)), `${fmt(fCi.lo)} to ${fmt(fCi.hi)}`, verdict(1, fCi, 1)],
        [`Mean split, eastern-Pacific (${ep_.map((y) => ensoN.get(y)!.label).join(', ')})`, fmt(mean(ep_.map(split))), '—', '—'],
        [`Mean split, central-Pacific and mixed (n = ${cp_.length})`, fmt(mean(cp_.map(split))), '—', '—'],
      ],
    ),
    '',
  )

  // 2015-16 against the other very strong winters.
  const focus = GROUPS.filter((g) => ['socal', 'new-mexico', 'sierra', 'wasatch', 'colorado', 'n-rockies', 'pnw', 'canada-west'].includes(g.id))
  md.push(
    '## The 2015–16 miss',
    '',
    table(
      ['Group', ...[1983, 1998, 2016].map((y) => ensoN.get(y)!.label), '% of neutral mean, 2015–16'],
      focus.map((g) => {
        const members = north.filter((s) => s.group.id === g.id)
        const pct = mean(members.map((m) => (m.precipMm.get(2016)! / m.neutralPrecipMm - 1) * 100))
        return [g.label, ...[1983, 1998, 2016].map((y) => fmt(composite(members, y, (s) => s.zPrecip))), `${fmt(pct, 0)}%`]
      }),
    ),
    '',
  )

  // Out-of-sample check.
  const westernNA = (s: ResortSeries) => WESTERN_NA.has(s.group.id)
  const cvRuns: { title: string; h: Hemisphere; scoreOn?: (s: ResortSeries) => boolean }[] = [
    { title: 'every northern resort', h: 'north' },
    { title: 'western North America only', h: 'north', scoreOn: westernNA },
    { title: 'the US East and Eastern Canada', h: 'north', scoreOn: (s) => s.group.id === 'us-east' || s.group.id === 'canada-east' },
    { title: 'the Alps, Pyrenees and Japan', h: 'north', scoreOn: (s) => s.group.id === 'europe' || s.group.id === 'japan' },
    { title: 'every austral resort', h: 'south' },
  ]
  const cvBy = new Map<string, CvResult[]>()
  for (const run of cvRuns) {
    const hs = series.filter((s) => s.h === run.h)
    const ninos = phaseYears(run.h, 'El Nino')
    const fitYears = [...phaseYears(run.h, 'El Nino'), ...phaseYears(run.h, 'Neutral')].sort()
    const cv = crossValidate(hs, fitYears, ninos, ensoBy[run.h], run.scoreOn)
    cvBy.set(run.title, cv)
    md.push(
      `## Out of sample: leave one El Niño ${run.h === 'north' ? 'winter' : 'season'} out, scored on ${run.title} (${hs.filter(run.scoreOn ?? (() => true)).length} resorts)`,
      '',
      'For each El Niño season: fit on every other El Niño and neutral season, predict the held-out season at every resort.',
      'Skill = 1 − MSE / MSE of predicting zero, so 0 is no better than climatology and negative is worse.',
      'Pattern r is the across-resort correlation of predicted and observed anomalies in the held-out season.',
      '',
      table(
        ['Model', 'Skill', 'RMSE (z)', 'Mean pattern r'],
        cv.map((c) => [c.model, fmt(c.skill), fmtU(c.rmse), fmt(c.patternR)]),
        ['---', '---:', '---:', '---:'],
      ),
      '',
      table(
        ['Held-out', ...cv.slice(1).map((c) => c.model)],
        ninos.map((y, i) => [ensoBy[run.h].get(y)!.label, ...cv.slice(1).map((c) => fmt(c.perSeason[i].r))]),
      ),
      '',
    )
  }

  // SNOTEL cross-check of the reanalysis.
  const snotelRows: (string | number)[][] = []
  const agreement: number[] = []
  const fitYearsN = [...ninosN, ...neutralN]
  for (const s of north.filter((x) => SNOTEL_REGIONS.has(x.resort.region))) {
    if (s.source !== 'SNOTEL') {
      snotelRows.push([s.resort.name, 'none within 40 km with a record from 1982', '—', '—', fmt(fit(s.zPrecipPower, fitYearsN, ensoN, appGain).s), '—'])
      continue
    }
    const common = [...s.zPrecip.keys()].filter((y) => s.zPrecipPower.has(y))
    const r = pearson(common.map((y) => s.zPrecip.get(y)!), common.map((y) => s.zPrecipPower.get(y)!))
    agreement.push(r)
    snotelRows.push([
      s.resort.name,
      s.stations.map((n) => `${n.name} (${n.elevationFt} ft)`).join('; '),
      common.length,
      fmtU(r),
      fmt(fit(s.zPrecipPower, fitYearsN, ensoN, appGain).s),
      fmt(fit(s.zPrecip, fitYearsN, ensoN, appGain).s),
    ])
  }
  const sortedAgreement = [...agreement].sort((a, b) => a - b)
  md.push(
    '## Cross-check: reanalysis against SNOTEL',
    '',
    'Up to three SNOTEL stations within 40 km whose record starts by Oct 1982; Dec–Mar precipitation, averaged.',
    `Where they exist (${agreement.length} resorts), every fit above uses SNOTEL; elsewhere it uses the reanalysis.`,
    `Median correlation of the winter anomalies: ${fmtU(sortedAgreement[Math.floor(sortedAgreement.length / 2)])}; lowest ${fmtU(sortedAgreement[0])}.`,
    '',
    table(['Resort', 'SNOTEL stations', 'Winters', 'r', 'Raw s, reanalysis', 'Raw s, SNOTEL'], snotelRows, ['---', '---', '---:', '---:', '---:', '---:']),
    '',
  )

  // Sensitivities.
  const finalValues = new Map<string, number>()
  const sensRows: (string | number)[][] = []
  for (const h of ['north', 'south'] as const) {
    const hs = series.filter((s) => s.h === h)
    const fitYears = [...phaseYears(h, 'El Nino'), ...phaseYears(h, 'Neutral')]
    const sens = sensitivities(hs, fitYears, ensoBy[h], appGain)
    const conservative = sensitivities(hs, fitYears, ensoBy[h], appGain, true)
    for (const s of hs) {
      const v = sens.get(s.resort.id)!
      const c = conservative.get(s.resort.id)!
      const value = published(c.pooled)
      finalValues.set(s.resort.id, value)
      sensRows.push([
        s.resort.name,
        s.group.label,
        s.source,
        fmt(EDITORIAL[s.resort.id]),
        `${fmt(v.raw.s)} ± ${fmtU(v.raw.se)}`,
        `${fmt(v.group.s)} ± ${fmtU(v.group.se)}`,
        fmtU(v.w),
        fmt(published(v.pooled)),
        fmtU(c.b),
        `**${fmt(value)}**`,
      ])
    }
  }
  md.push(
    '## Re-derived sensitivities',
    '',
    '`s` is the slope of the standardised precipitation anomaly on the app’s gain, through the origin, over El Niño and neutral seasons.',
    'Pooled = group slope + w × (resort slope − group slope), where w is the share of between-resort spread that exceeds noise.',
    'Published = B × pooled, clipped to [−1, 1], where B is the share of between-group spread that exceeds noise.',
    'B is chosen by the out-of-sample check: in the north, pooled and published tie on pattern and published never loses on skill.',
    '± is one standard error.',
    '',
    table(['Resort', 'Group', 'Source', 'Editorial', 'Own fit', 'Group fit', 'w', 'Pooled', 'B', 'Published'], sensRows),
    '',
  )

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(join(OUT_DIR, 'results.md'), md.join('\n'))
  await writeFile(
    join(OUT_DIR, 'sensitivities.json'),
    JSON.stringify(Object.fromEntries(finalValues), null, 2) + '\n',
  )
  console.log(`wrote ${join('docs', 'enso-backtest', 'results.md')}`)
  if (apply) await applySensitivities(finalValues)
}

main()
