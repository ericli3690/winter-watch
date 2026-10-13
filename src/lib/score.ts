import type { EnsoState } from './enso'
import type { ResortForecast } from './forecast'
import { scoreLabel, type ScoreLabel } from './palette'
import { RESORTS } from './resorts'
import type {
  Access,
  MacroRegionId,
  PassId,
  Resort,
  Score,
  SignedUnit,
  Unit,
} from './types'

export type ScoreMode = 'seasonal' | 'live'

export interface ScoredResort {
  resort: Resort
  forecast: ResortForecast | null
  /** ENSO teleconnection + elevation resilience + snow climatology. */
  seasonalScore: Score
  /** From the live GFS run, or null when there is nothing to forecast. */
  liveScore: Score | null
  /** The score the current mode ranks on. */
  score: Score
  /** Teleconnection effect before elevation adjustments. */
  ensoEffect: SignedUnit
  /** How well the mountain's elevation absorbs a warm winter. */
  elevationResilience: Unit
  /**
   * Plain-language read on `score`.
   *
   * @remarks
   * Shares the value the map colours by, so a red dot is never "Favored".
   */
  verdict: ScoreLabel
  access: Access
}

/** What the map needs of a resort, which is less than a full tier board row. */
export interface MappableResort {
  resort: Resort
  score: Score
  verdict: ScoreLabel
  forecast?: ResortForecast | null
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const norm = (v: number, lo: number, hi: number) => clamp((v - lo) / (hi - lo), 0, 1)

/** Cost of a rising snow line at a mountain with no elevation to absorb it. */
const WARM_STORM_PENALTY = 18

/** How far the climatological baseline can move a resort off the backbone. */
const CLIMATOLOGY_WEIGHT = 12

/**
 * How strongly the canonical ENSO teleconnection is expressed this year.
 *
 * @remarks
 * - Magnitude scales the signal.
 * - Eastern-Pacific events express it more sharply than central-Pacific ones.
 * - An EP-loaded subtropical jet wets the southern tier and starves the north.
 */
export function teleconnectionGain(enso: EnsoState): SignedUnit {
  const flavorGain = 0.7 + 0.6 * enso.epGradient
  const sign = enso.phase === 'La Nina' ? -1 : 1
  return sign * enso.magnitude * flavorGain
}

/**
 * How well a mountain's elevation holds up in a warm winter.
 *
 * @remarks
 * - El Nino winters run warm, so snow height matters more than storm count.
 * - Base elevation outweighs summit.
 * - A high peak above a rainy base is still a rainy ski day.
 */
export function elevationResilience(r: Resort): Unit {
  const base = norm(r.baseElevationFt, 2000, 9500)
  const summit = norm(r.summitElevationFt, 4000, 13000)
  return 0.65 * base + 0.35 * summit
}

/**
 * Squash the raw teleconnection into [-1, 1] without a ceiling resorts can tie on.
 *
 * @remarks
 * - A hard clamp pinned every resort above sensitivity ~0.77 once a record event maxed the gain.
 * - tanh is near-linear below 0.5, so weak and moderate events score almost as before.
 * - It is strictly monotonic, so a more sensitive resort always outranks a less sensitive one.
 */
const saturate = (raw: number): SignedUnit => Math.tanh(raw)

export function seasonalScore(
  r: Resort,
  enso: EnsoState,
): { score: Score; effect: SignedUnit } {
  const effect = saturate(r.ensoSensitivity * teleconnectionGain(enso))
  const resilience = elevationResilience(r)

  // Teleconnection is the backbone: -1 -> 0, 0 -> 50, +1 -> 100.
  let score = 50 + 50 * effect

  // Less elevation to absorb a rising snow line costs more in a stronger event.
  score -= enso.magnitude * (1 - resilience) * WARM_STORM_PENALTY

  // A favored mediocre year at a 600 in mountain still beats a favored year
  // somewhere that averages 100 in.
  score += (norm(r.avgAnnualSnowIn, 90, 600) - 0.5) * CLIMATOLOGY_WEIGHT

  return { score: clamp(score, 0, 100), effect }
}

/**
 * Near-term score from the live GFS run, or null when the model shows
 * essentially nothing anywhere.
 *
 * @remarks
 * - In the preseason an empty model is a signal about the calendar.
 * - It says nothing about the mountain, so callers fall back to seasonal.
 */
export function liveScore(f: ResortForecast | null): Score | null {
  if (!f) return null
  // 24 in over 7 days is a very good week; treat that as the ceiling.
  const snow = norm(f.snowIn7d, 0, 24) * 78
  const depth = norm(f.snowIn16d, 0, 48) * 22
  const rainPenalty = clamp(f.rainRiskDays * 3, 0, 22)
  return clamp(snow + depth - rainPenalty, 0, 100)
}

/**
 * Decide whether there is enough snow in the model to rank on live data.
 *
 * @remarks
 * - Scoped to the resorts on screen, not the whole roster.
 * - In the northern preseason every US grid point reads zero.
 * - A Southern Hemisphere resort must not drag the US view into live mode.
 */
export function pickMode(
  resorts: Resort[],
  forecasts: Record<string, ResortForecast>,
): ScoreMode {
  const best = resorts.reduce(
    (m, r) => Math.max(m, forecasts[r.id]?.snowIn7d ?? 0),
    0,
  )
  return best >= 6 ? 'live' : 'seasonal'
}

/** How much of a live-mode score the model run carries, against the pattern. */
const LIVE_WEIGHT = 0.65

/**
 * Mix the live run into the seasonal signal.
 *
 * @remarks
 * - The run leads in live mode, but one run cannot decide the order alone.
 * - Shared, so the board and the summary never weight a run differently.
 */
export function blendScore(seasonal: Score, live: Score | null, mode: ScoreMode): Score {
  if (mode !== 'live' || live === null) return seasonal
  return live * LIVE_WEIGHT + seasonal * (1 - LIVE_WEIGHT)
}

/**
 * The ranking mode a view should default to.
 *
 * @remarks
 * - Live is a regional judgement: it asks whether this region's model has news.
 * - A pool spanning both hemispheres has no honest answer, so it stays seasonal.
 */
export function autoScoreMode(
  resorts: Resort[],
  forecasts: Record<string, ResortForecast>,
  macro: MacroRegionId | null,
): ScoreMode {
  return macro ? pickMode(resorts, forecasts) : 'seasonal'
}

export function scoreResorts(
  resorts: Resort[],
  pass: PassId,
  enso: EnsoState,
  forecasts: Record<string, ResortForecast>,
  mode: ScoreMode,
): ScoredResort[] {
  const scored = resorts.flatMap((resort) => {
    const access = resort.access[pass]
    if (!access) return []

    const forecast = forecasts[resort.id] ?? null
    const { score: seasonal, effect } = seasonalScore(resort, enso)
    const live = liveScore(forecast)

    const score = blendScore(seasonal, live, mode)

    return [
      {
        resort,
        forecast,
        seasonalScore: seasonal,
        liveScore: live,
        score,
        ensoEffect: effect,
        elevationResilience: elevationResilience(resort),
        verdict: scoreLabel(score),
        access,
      } satisfies ScoredResort,
    ]
  })

  return scored.sort((a, b) => b.score - a.score)
}

/**
 * A resort's place on the board its own page mirrors.
 *
 * @remarks
 * - Scoped to the macro region for the same reason `pickMode` is.
 * - Returns null when the tier does not reach the resort at all.
 */
export function rankInRegion(
  resort: Resort,
  pass: PassId,
  enso: EnsoState,
  forecasts: Record<string, ResortForecast>,
): {
  entry: ScoredResort
  board: ScoredResort[]
  rank: number
  mode: ScoreMode
} | null {
  const region = RESORTS.filter((r) => r.macro === resort.macro)
  const mode = pickMode(region, forecasts)
  const board = scoreResorts(region, pass, enso, forecasts, mode)
  const index = board.findIndex((s) => s.resort.id === resort.id)
  if (index === -1) return null
  return { entry: board[index], board, rank: index + 1, mode }
}
