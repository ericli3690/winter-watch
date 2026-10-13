import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CPC_ONI_URL, CPC_WEEKLY_SST_URL, parseOni, parseWeeklySst } from '../../src/lib/enso'
import type { Resort } from '../../src/lib/types'

/** Raw downloads, so a rerun reads disk rather than hitting NOAA, NRCS and NASA again. */
const CACHE_DIR = join(process.cwd(), '.cache', 'enso-backtest')

/** Where the generated write-up tables live. */
export const OUT_DIR = join(process.cwd(), 'docs', 'enso-backtest')

/** First day requested, so the 1980-81 water year is complete where a source has it. */
export const RECORD_START = '1980-10-01'

/** Last day requested: the end of the 2025 austral season. */
export const RECORD_END = '2025-09-30'

/** CPC monthly ERSSTv5 Nino-region anomalies against 1991-2020, back to 1950. */
export const CPC_ERSST_NINO_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/ersst5.nino.mth.91-20.ascii'

/** NRCS Air and Water Database REST API for SNOTEL. */
const AWDB_URL = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1'

/** Feet per metre. */
const FT_PER_M = 3.28084

/** Wait, between rate-limited retries. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Fetch text through the on-disk cache, backing off when a service rate-limits. */
async function cached(key: string, url: string): Promise<string> {
  const path = join(CACHE_DIR, key)
  try {
    return await readFile(path, 'utf8')
  } catch {
    // Not cached yet.
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'winter-watch backtest (github.com/ray-cj-huang/winter-watch)' },
      signal: AbortSignal.timeout(120_000),
    })
    if (res.ok) {
      const text = await res.text()
      await mkdir(CACHE_DIR, { recursive: true })
      await writeFile(path, text)
      return text
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const wait = 2 ** attempt * 5_000
      console.error(`${res.status} from ${new URL(url).host}; retrying in ${wait / 1000}s`)
      await sleep(wait)
      continue
    }
    throw new Error(`${url} -> ${res.status} ${await res.text()}`)
  }
}

/** One month of Nino-region anomalies, degrees C. */
export interface NinoMonth {
  year: number
  month: number
  nino12: number
  nino3: number
  nino4: number
  nino34: number
}

/** `YR MON NINO1+2 ANOM NINO3 ANOM NINO4 ANOM NINO3.4 ANOM`, one row per month. */
export function parseErsstNino(text: string): NinoMonth[] {
  const out: NinoMonth[] = []
  for (const line of text.split('\n')) {
    const v = line.trim().split(/\s+/).map(Number)
    if (v.length !== 10 || v.some(Number.isNaN)) continue
    out.push({ year: v[0], month: v[1], nino12: v[3], nino3: v[5], nino4: v[7], nino34: v[9] })
  }
  return out
}

/** Every month of the CPC ERSSTv5 Nino-region file. */
export async function getErsstNino(): Promise<NinoMonth[]> {
  return parseErsstNino(await cached('ersst5-nino.txt', CPC_ERSST_NINO_URL))
}

/** Every season of the CPC ONI, through the app's own parser. */
export async function getOni(): Promise<{ season: string; value: number }[]> {
  return parseOni(await cached('oni.txt', CPC_ONI_URL))
}

/** The weekly file is the one the app reads, so the current-state ranking uses it too. */
export async function getWeeklySst() {
  return parseWeeklySst(await cached(`wksst-${new Date().toISOString().slice(0, 10)}.txt`, CPC_WEEKLY_SST_URL))
}

/** Daily values at one resort. */
export interface DailySeries {
  /** ISO dates, one per day of the record. */
  time: string[]
  precipMm: (number | null)[]
  /** Daily mean temperature at the resort's base. */
  tempC: (number | null)[]
}

/** NASA POWER daily point API: MERRA-2, with precipitation bias-corrected to GPCP; no key needed. */
const POWER_URL = 'https://power.larc.nasa.gov/api/temporal/daily/point'

/** Standard atmosphere lapse rate, to carry the cell's temperature up to the base. */
const LAPSE_C_PER_M = 0.0065

/**
 * Daily POWER precipitation and temperature, the latter lapsed to the resort's base.
 *
 * @remarks
 * - POWER reports the cell's mean elevation, typically far below a base area.
 * - The temperature is moved to the base at {@link LAPSE_C_PER_M}; precipitation is the cell's.
 * - The record starts on 1 Jan 1981, so 1981-82 is the first full northern winter.
 */
export async function getPower(r: Resort): Promise<DailySeries> {
  const params = new URLSearchParams({
    parameters: 'PRECTOTCORR,T2M',
    community: 'AG',
    latitude: String(r.lat),
    longitude: String(r.lon),
    start: '19810101',
    end: RECORD_END.replaceAll('-', ''),
    format: 'JSON',
  })
  const text = await cached(`power-${r.id}.json`, `${POWER_URL}?${params}`)
  const json = JSON.parse(text) as {
    geometry: { coordinates: [number, number, number] }
    properties: { parameter: { PRECTOTCORR: Record<string, number>; T2M: Record<string, number> } }
  }
  const cellM = json.geometry.coordinates[2]
  const lapse = (r.baseElevationFt / FT_PER_M - cellM) * LAPSE_C_PER_M
  const { PRECTOTCORR, T2M } = json.properties.parameter
  const days = Object.keys(PRECTOTCORR).sort()
  // POWER marks missing values with -999.
  const valid = (v: number | undefined) => (v === undefined || v <= -999 ? null : v)
  return {
    time: days.map((d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`),
    precipMm: days.map((d) => valid(PRECTOTCORR[d])),
    tempC: days.map((d) => {
      const t = valid(T2M[d])
      return t === null ? null : t - lapse
    }),
  }
}

/** A SNOTEL site, as the AWDB station listing describes it. */
export interface SnotelStation {
  triplet: string
  name: string
  elevationFt: number
  lat: number
  lon: number
  beginDate: string
}

/** Every SNOTEL station in the states that hold a western US resort. */
export async function getSnotelStations(states: string[]): Promise<SnotelStation[]> {
  const triplets = states.map((s) => `*:${s}:SNTL`).join(',')
  const params = new URLSearchParams({
    stationTriplets: triplets,
    returnForecastPointMetadata: 'false',
    returnReservoirMetadata: 'false',
    returnStationElements: 'false',
  })
  const text = await cached(`snotel-stations-${states.join('-')}.json`, `${AWDB_URL}/stations?${params}`)
  const json = JSON.parse(text) as {
    stationTriplet: string
    name: string
    elevation: number
    latitude: number
    longitude: number
    beginDate: string
  }[]
  return json.map((s) => ({
    triplet: s.stationTriplet,
    name: s.name,
    elevationFt: s.elevation,
    lat: s.latitude,
    lon: s.longitude,
    beginDate: s.beginDate.slice(0, 10),
  }))
}

/** Monthly precipitation totals at one SNOTEL station, inches, keyed `YYYY-MM`. */
export async function getSnotelMonthlyPrecip(triplet: string): Promise<Map<string, number>> {
  const params = new URLSearchParams({
    stationTriplets: triplet,
    elements: 'PRCP',
    duration: 'MONTHLY',
    beginDate: RECORD_START,
    endDate: RECORD_END,
  })
  const text = await cached(`snotel-${triplet.replaceAll(':', '_')}.json`, `${AWDB_URL}/data?${params}`)
  const json = JSON.parse(text) as {
    data?: { values: { year: number; month: number; value: number | null }[] }[]
  }[]
  const out = new Map<string, number>()
  for (const v of json[0]?.data?.[0]?.values ?? []) {
    if (v.value === null || v.value === undefined) continue
    out.set(`${v.year}-${String(v.month).padStart(2, '0')}`, v.value)
  }
  return out
}
