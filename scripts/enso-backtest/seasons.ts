import { classifyFlavor, type EnsoState } from '../../src/lib/enso'
import { classifyPhase, classifyStrength, eventMagnitude, type EnsoPhase } from '../../src/lib/enso-scale'
import { teleconnectionGain } from '../../src/lib/score'
import type { Resort } from '../../src/lib/types'
import type { DailySeries, NinoMonth } from './data'

/** Which half of the year a resort skis in. */
export type Hemisphere = 'north' | 'south'

/** Hemisphere by latitude. */
export const hemisphere = (r: Resort): Hemisphere => (r.lat < 0 ? 'south' : 'north')

/**
 * The season each hemisphere is scored over.
 *
 * @remarks
 * - North: Dec-Mar, the window the job asks for, labelled by its January.
 * - South: Jun-Sep of the year the event develops, its own ski season.
 * - ENSO is read from DJF in the north and JJA in the south, the 3-month mean inside each season.
 */
export const SEASON_MONTHS: Record<Hemisphere, { months: number[]; oni: string; ninoMonths: number[] }> = {
  north: { months: [12, 1, 2, 3], oni: 'DJF', ninoMonths: [12, 1, 2] },
  south: { months: [6, 7, 8, 9], oni: 'JJA', ninoMonths: [6, 7, 8] },
}

/** One season's ocean state, in the shape the app's scoring takes. */
export interface SeasonEnso {
  /** Calendar year of the season's last month: 1983 is Dec 1982 to Mar 1983 in the north. */
  year: number
  label: string
  oni: number
  phase: EnsoPhase
  nino34: number
  nino12: number
  nino4: number
  /** The app's own gain for this state, from {@link teleconnectionGain}. */
  gain: number
  magnitude: number
  epGradient: number
  flavor: EnsoState['flavor']
}

/** Calendar year a month belongs to, for a season that may wrap the new year. */
const monthYear = (seasonYear: number, month: number, months: number[]) =>
  months[0] > months[months.length - 1] && month >= months[0] ? seasonYear - 1 : seasonYear

/** `1982–83` in the north, `1982` in the south. */
export const seasonLabel = (h: Hemisphere, year: number) =>
  h === 'north' ? `${year - 1}–${String(year).slice(2)}` : `${year}`

/** ENSO state for every season in the record, built from ONI and monthly ERSST. */
export function seasonEnso(
  h: Hemisphere,
  years: number[],
  oni: { season: string; value: number }[],
  nino: NinoMonth[],
): Map<number, SeasonEnso> {
  const spec = SEASON_MONTHS[h]
  const oniBy = new Map(oni.map((o) => [o.season, o.value]))
  const ninoBy = new Map(nino.map((n) => [`${n.year}-${n.month}`, n]))
  const out = new Map<number, SeasonEnso>()
  for (const year of years) {
    const o = oniBy.get(`${spec.oni} ${year}`)
    const months = spec.ninoMonths.map((m) => ninoBy.get(`${monthYear(year, m, spec.ninoMonths)}-${m}`))
    if (o === undefined || months.some((m) => !m)) continue
    const avg = (k: 'nino12' | 'nino34' | 'nino4') => months.reduce((a, m) => a + m![k], 0) / months.length
    const regions = { nino12: avg('nino12'), nino3: NaN, nino34: avg('nino34'), nino4: avg('nino4') }
    const { flavor, epGradient } = classifyFlavor(regions)
    const phase = classifyPhase(o)
    const magnitude = eventMagnitude(regions.nino34)
    // Only the fields teleconnectionGain reads are meaningful here.
    const state = { ...regions, phase, magnitude, epGradient, flavor, strength: classifyStrength(o) } as EnsoState
    out.set(year, {
      year,
      label: seasonLabel(h, year),
      oni: o,
      phase,
      nino34: regions.nino34,
      nino12: regions.nino12,
      nino4: regions.nino4,
      gain: teleconnectionGain(state),
      magnitude,
      epGradient,
      flavor,
    })
  }
  return out
}

/** Seasonal totals at one resort. */
export interface SeasonTotals {
  precipMm: number
  /** Precipitation on days whose mean temperature at the base was at or below the rain/snow line. */
  snowAtBaseMm: number
  meanTempC: number
}

/**
 * Daily mean temperature at or below which a day's precipitation counts as snow.
 *
 * @remarks
 * - +1 C is a common daily-mean rain/snow partition in hydrology.
 * - It is a proxy: precipitation is the reanalysis cell's, the temperature is lapsed to the base.
 */
export const SNOW_LINE_C = 1

/** Aggregate a daily series into one total per season year. */
export function seasonTotals(h: Hemisphere, daily: DailySeries): Map<number, SeasonTotals> {
  const { months } = SEASON_MONTHS[h]
  const acc = new Map<number, { p: number; s: number; t: number; n: number; days: number }>()
  for (let i = 0; i < daily.time.length; i++) {
    const [y, m] = daily.time[i].split('-').map(Number)
    if (!months.includes(m)) continue
    const seasonYear = months[0] > months[months.length - 1] && m >= months[0] ? y + 1 : y
    const p = daily.precipMm[i]
    const t = daily.tempC[i]
    const a = acc.get(seasonYear) ?? { p: 0, s: 0, t: 0, n: 0, days: 0 }
    a.days++
    if (p !== null && t !== null) {
      a.p += p
      if (t <= SNOW_LINE_C) a.s += p
      a.t += t
      a.n++
    }
    acc.set(seasonYear, a)
  }
  const out = new Map<number, SeasonTotals>()
  for (const [year, a] of acc) {
    // A season cut off by the record's edges is not a season.
    if (a.days < 118 || a.n < a.days * 0.95) continue
    out.set(year, { precipMm: a.p, snowAtBaseMm: a.s, meanTempC: a.t / a.n })
  }
  return out
}
