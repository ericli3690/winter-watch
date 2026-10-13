/** Sum of a list. */
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

/** Arithmetic mean; NaN for an empty list. */
export const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN)

/** Sample standard deviation (n - 1). */
export function sd(xs: number[]): number {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1))
}

/** Pearson correlation. */
export function pearson(xs: number[], ys: number[]): number {
  const mx = mean(xs)
  const my = mean(ys)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
    syy += (ys[i] - my) ** 2
  }
  return sxy / Math.sqrt(sxx * syy)
}

/** Ranks, ties averaged, for Spearman's rho. */
function ranks(xs: number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0])
  const out = new Array<number>(xs.length)
  for (let i = 0; i < order.length; ) {
    let j = i
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++
    for (let k = i; k <= j; k++) out[order[k][1]] = (i + j) / 2 + 1
    i = j + 1
  }
  return out
}

/** Spearman rank correlation. */
export const spearman = (xs: number[], ys: number[]) => pearson(ranks(xs), ranks(ys))

/** Least squares through the origin: `y = b x`, with the slope's standard error. */
export function slopeThroughOrigin(xs: number[], ys: number[]): { b: number; se: number } {
  const sxx = sum(xs.map((x) => x * x))
  const b = sum(xs.map((x, i) => x * ys[i])) / sxx
  const resid = ys.map((y, i) => y - b * xs[i])
  const s2 = sum(resid.map((r) => r * r)) / (xs.length - 1)
  return { b, se: Math.sqrt(s2 / sxx) }
}

/** Ordinary least squares `y = a + b x`, with the slope's standard error. */
export function ols(xs: number[], ys: number[]): { a: number; b: number; se: number } {
  const mx = mean(xs)
  const my = mean(ys)
  const sxx = sum(xs.map((x) => (x - mx) ** 2))
  const b = sum(xs.map((x, i) => (x - mx) * (ys[i] - my))) / sxx
  const a = my - b * mx
  const resid = ys.map((y, i) => y - a - b * xs[i])
  const s2 = sum(resid.map((r) => r * r)) / (xs.length - 2)
  return { a, b, se: Math.sqrt(s2 / sxx) }
}

/** Deterministic PRNG, so the bootstrap gives the same numbers on every run. */
export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Percentile bootstrap over winters: resample the cases, recompute the statistic.
 *
 * @remarks
 * - Winters are the unit of independence, not resorts.
 * - Resorts in one winter share its weather, so resampling them would overstate n.
 */
export function bootstrap<T>(
  cases: T[],
  statistic: (sample: T[]) => number,
  draws = 5000,
  seed = 1997,
): { lo: number; hi: number } {
  const rand = mulberry32(seed)
  const stats: number[] = []
  for (let d = 0; d < draws; d++) {
    const sample = cases.map(() => cases[Math.floor(rand() * cases.length)])
    const s = statistic(sample)
    if (Number.isFinite(s)) stats.push(s)
  }
  stats.sort((a, b) => a - b)
  return { lo: stats[Math.floor(stats.length * 0.05)], hi: stats[Math.floor(stats.length * 0.95)] }
}

/** Signed fixed-point, for anomalies; locale-free by construction. */
export const fmt = (n: number, digits = 2) =>
  Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(digits) : 'n/a'

/** Unsigned fixed-point, for magnitudes and counts. */
export const fmtU = (n: number, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : 'n/a')
