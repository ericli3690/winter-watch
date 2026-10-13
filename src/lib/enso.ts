import { cacheLife, cacheTag } from 'next/cache'
import {
  classifyPhase,
  classifyStrength,
  eventMagnitude,
  type EnsoPhase,
  type EnsoStrength,
} from './enso-scale'
import type { Unit } from './types'

export { classifyPhase, classifyStrength }
export type { EnsoPhase, EnsoStrength }

/** CPC refreshes the weekly SST file each Monday; ONI updates monthly. */
export const CPC_WEEKLY_SST_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for'
export const CPC_ONI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt'

export interface NinoRegions {
  /** Sea surface temperature anomaly, degrees C, vs the 1991-2020 base period. */
  nino12: number
  nino3: number
  nino34: number
  nino4: number
}

/** Eastern-Pacific vs Central-Pacific ("Modoki") flavour. */
export type EnsoFlavor = 'Eastern Pacific' | 'Central Pacific' | 'Mixed'

export interface EnsoState extends NinoRegions {
  /** ISO date of the week the CPC observation is centred on. */
  weekEnding: string
  phase: EnsoPhase
  strength: EnsoStrength
  flavor: EnsoFlavor
  /**
   * Normalised event magnitude, from the Nino 3.4 anomaly.
   *
   * @remarks
   * 2.0 C, the "very strong" threshold, maps to 1.0.
   */
  magnitude: Unit
  /**
   * East-west gradient. High = eastern-Pacific flavour, which historically
   * loads the subtropical jet across the southern US tier.
   */
  epGradient: Unit
  /** Most recent Oceanic Nino Index 3-month season, e.g. "JJA 2026". */
  oniSeason: string | null
  oniValue: number | null
  /**
   * Trailing 12 weeks, oldest first, for the share card's strip.
   *
   * @remarks
   * The page's timeline draws the whole record via {@link getNino34Record}.
   */
  nino34History: { week: string; anomaly: number }[]
  fetchedAt: string
}

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
}

/** `09SEP2026` -> `2026-09-09`. */
function parseCpcDate(token: string): string | null {
  const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(token)
  if (!m) return null
  const month = MONTHS[m[2]]
  if (month === undefined) return null
  return new Date(Date.UTC(Number(m[3]), month, Number(m[1]))).toISOString().slice(0, 10)
}

interface WeeklyRow extends NinoRegions {
  week: string
}

/**
 * Parse the CPC weekly Nino-region file.
 *
 * @remarks
 * - The file is fixed-width and columns collide on a negative anomaly.
 * - `22.4-0.1` is two values, so this pulls signed decimals, not whitespace.
 * - Column order: Nino1+2, Nino3, Nino3.4, Nino4, each an (SST, anomaly) pair.
 */
export function parseWeeklySst(text: string): WeeklyRow[] {
  const rows: WeeklyRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d{2}[A-Z]{3}\d{4})\s+(.+)$/.exec(line)
    if (!m) continue
    const week = parseCpcDate(m[1])
    if (!week) continue
    const nums = m[2].match(/-?\d+\.\d+/g)
    if (!nums || nums.length < 8) continue
    const v = nums.map(Number)
    rows.push({ week, nino12: v[1], nino3: v[3], nino34: v[5], nino4: v[7] })
  }
  return rows
}

/** `  JJA 2026  29.09   1.80` -> season + anomaly. */
export function parseOni(text: string): { season: string; value: number }[] {
  const out: { season: string; value: number }[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z]{3})\s+(\d{4})\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$/.exec(line)
    if (!m) continue
    out.push({ season: `${m[1]} ${m[2]}`, value: Number(m[4]) })
  }
  return out
}

const clamp01 = (n: number): Unit => Math.min(1, Math.max(0, n))

/**
 * Classify the event's flavour from the east-west warming gradient.
 *
 * @remarks
 * - Eastern-Pacific events warm Nino 1+2 far more than Nino 4.
 * - That spread is the cleanest single-number proxy for flavour.
 */
export function classifyFlavor(r: NinoRegions): { flavor: EnsoFlavor; epGradient: Unit } {
  const spread = r.nino12 - r.nino4
  const epGradient = clamp01(spread / 3)
  if (spread >= 1.5) return { flavor: 'Eastern Pacific', epGradient }
  if (spread <= -0.5) return { flavor: 'Central Pacific', epGradient }
  return { flavor: 'Mixed', epGradient }
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'winter-watch (github.com/ray-cj-huang/winter-watch)' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.text()
}

/**
 * Every parsable week of the CPC record, back to 1981.
 *
 * @remarks
 * - Shared, so the state and the long record cost one fetch between them.
 * - Remote, not in-memory: callers throw on failure, so a stampede is an outage.
 */
async function getWeeklyRows(): Promise<WeeklyRow[]> {
  'use cache: remote'
  cacheLife('hours')
  cacheTag('noaa', 'noaa-enso')

  const rows = parseWeeklySst(await getText(CPC_WEEKLY_SST_URL))
  if (rows.length === 0) throw new Error('CPC weekly SST file contained no parsable rows')
  return rows
}

/** Days between consecutive CPC weeks, which the record derives its dates from. */
const WEEK_DAYS = 7

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10)

/**
 * The Nino 3.4 record, dates derived rather than listed.
 *
 * @remarks
 * - The chart is interactive, so unlike the page copy this has to reach the browser.
 * - Sending 2,351 dates alongside the values costs several times what it saves.
 */
export interface Nino34Series {
  /** ISO date of the first week. */
  start: string
  /** Days from one week to the next, applied to `start` for every index. */
  step: number
  anomalies: number[]
}

/**
 * The whole Nino 3.4 record, for the timeline.
 *
 * @remarks
 * Every gap in 45 years has been exactly a week, and deriving the dates from
 * that is what keeps the payload small. A drifting axis would be wrong without
 * looking wrong, so an uneven file fails loudly instead.
 */
export async function getNino34Record(): Promise<Nino34Series> {
  'use cache: remote'
  cacheLife('hours')
  cacheTag('noaa', 'noaa-enso')

  const rows = await getWeeklyRows()
  const start = rows[0].week
  const end = rows[rows.length - 1].week
  const derivedEnd = addDays(start, (rows.length - 1) * WEEK_DAYS)
  if (derivedEnd !== end) {
    throw new Error(`CPC weekly file is unevenly spaced: derived ${derivedEnd}, found ${end}`)
  }

  return { start, step: WEEK_DAYS, anomalies: rows.map((r) => r.nino34) }
}

/**
 * Live ENSO state from NOAA CPC.
 *
 * @remarks
 * - Cached for an hour and tagged `noaa-enso`.
 * - The scheduled refresh pulls the new week the moment CPC publishes it.
 * - Remote, not in-memory: this throws on failure, so a stampede is an outage.
 */
export async function getEnsoState(): Promise<EnsoState> {
  'use cache: remote'
  cacheLife('hours')
  cacheTag('noaa', 'noaa-enso')

  const [rows, oniText] = await Promise.all([
    getWeeklyRows(),
    getText(CPC_ONI_URL).catch(() => ''),
  ])

  const latest = rows[rows.length - 1]
  const { flavor, epGradient } = classifyFlavor(latest)
  const oni = parseOni(oniText)
  const latestOni = oni.length > 0 ? oni[oni.length - 1] : null

  return {
    ...latest,
    weekEnding: latest.week,
    phase: classifyPhase(latest.nino34),
    strength: classifyStrength(latest.nino34),
    flavor,
    epGradient,
    magnitude: eventMagnitude(latest.nino34),
    oniSeason: latestOni?.season ?? null,
    oniValue: latestOni?.value ?? null,
    nino34History: rows.slice(-12).map((r) => ({ week: r.week, anomaly: r.nino34 })),
    fetchedAt: new Date().toISOString(),
  }
}
