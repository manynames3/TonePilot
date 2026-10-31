// Measured colour cast → white-balance correction.
//
// The analyzer measures the CIELAB a*/b* of bright, nearly colourless surfaces in the
// Lightroom-rendered preview (white clothing, trim, sky). A neutral should read a* = b* = 0;
// a residual is a cast. To remove it we need how Lightroom's sliders move a neutral's
// a*/b*, which comes from colour science rather than guesswork:
//   • Temperature follows the Planckian (black-body) locus.
//   • Tint is a perpendicular offset from that locus; per Adobe's DNG specification one
//     tint step is 1/3000 of a CIE 1960 uv unit (kTintScale = −3000).
// The two sliders interact (removing magenta also pushes neutrals yellow), so both are
// solved together from the local 2×2 Jacobian at the photo's current Temperature.

function planckXY(T) {
  const x = T <= 4000 ? -0.2661239e9 / T ** 3 - 0.2343589e6 / T ** 2 + 0.8776956e3 / T + 0.179910
    : -3.0258469e9 / T ** 3 + 2.1070379e6 / T ** 2 + 0.2226347e3 / T + 0.240390;
  const y = T <= 2222 ? -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683
    : T <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}
const xyToUv = ([x, y]) => { const d = -2 * x + 12 * y + 3; return [4 * x / d, 6 * y / d]; };
const uvToXy = ([u, v]) => { const d = 2 * u - 8 * v + 4; return [3 * u / d, 2 * v / d]; };
function labOffset([x, y], [wx, wy]) {
  const f = t => Math.cbrt(t);
  const X = x / y, Z = (1 - x - y) / y, WX = wx / wy, WZ = (1 - wx - wy) / wy;
  return [500 * (f(X / WX) - 1), 200 * (1 - f(Z / WZ))];
}

const TINT_UV = 1 / 3000;   // one Lightroom tint step, in CIE 1960 uv (DNG kTintScale)

// How a neutral's [a*, b*] moves per +1 mired of warmer Temperature setting and per +1 tint.
export function sliderJacobian(kelvin) {
  const T = Math.min(12000, Math.max(2500, kelvin));
  const white = planckXY(T);
  const m = 1e6 / T;
  const warm = labOffset(planckXY(1e6 / (m + 1)), white);   // light 1 mired cooler ≈ setting 1 mired warmer
  const [u, v] = xyToUv(white), [u1, v1] = xyToUv(planckXY(T * 1.001));
  const n = Math.hypot(u1 - u, v1 - v);
  let perp = [-(v1 - v) / n, (u1 - u) / n];
  const probe = labOffset(uvToXy([u + perp[0] * TINT_UV, v + perp[1] * TINT_UV]), white);
  if (probe[0] < 0) { perp = [-perp[0], -perp[1]]; }               // +tint must read as magenta (+a*)
  const tint = labOffset(uvToXy([u + perp[0] * TINT_UV, v + perp[1] * TINT_UV]), white);
  return {perMired: warm, perTint: tint};
}

// Settings change that cancels a measured cast. Returns {mired, kelvin, tint} where
// mired > 0 means a warmer setting (higher Kelvin).
export function correctionForCast({a, b}, kelvin) {
  const {perMired: [am, bm], perTint: [at, bt]} = sliderJacobian(kelvin);
  const det = am * bt - at * bm;
  const mired = (-a * bt + at * b) / det;      // solve [am at; bm bt]·[m t] = [−a −b]
  const tint = (-am * b + a * bm) / det;
  const newKelvin = 1e6 / (1e6 / kelvin - mired);
  return {mired, tint, kelvin: newKelvin - kelvin};
}

// Relative (JPEG/HEIC/TIFF) white balance has no published scale; treated provisionally as
// ≈ 1 mired per IncrementalTemperature step and 1 tint step per IncrementalTint step.
export function relativeCorrectionForCast(cast) {
  const c = correctionForCast(cast, 5500);
  return {temperature: c.mired, tint: c.tint};
}

// Which measurement to trust as the white reference, if any.
export const CAST_LIMITS = Object.freeze({minWhiteShare: 0.02, minNeutralShare: 0.08, minCast: 1.5});
export function measuredCast(metrics) {
  if (!metrics) return null;
  const reliable = !metrics?.width || Math.max(metrics.width, metrics.height || 0) >= 500;
  if (!reliable) return null;
  const w = metrics.whites, n = metrics.neutral;
  const ref = w?.fraction >= CAST_LIMITS.minWhiteShare ? {...w, source: 'white surfaces'}
    : n?.fraction >= CAST_LIMITS.minNeutralShare ? {...n, source: 'neutral areas'} : null;
  if (!ref || Math.hypot(ref.a, ref.b) < CAST_LIMITS.minCast) return null;
  return ref;
}

export function describeCast({a, b}) {
  const parts = [];
  if (Math.abs(a) >= 0.8) parts.push(a > 0 ? 'magenta' : 'green');
  if (Math.abs(b) >= 0.8) parts.push(b > 0 ? 'warm' : 'cool');
  return parts.join(' and ') || 'slightly off-neutral';
}

// A gross-regression alarm, not a skin-quality score. Compare only adequately sampled,
// similarly sized white selections; different selections cannot establish a colour change.
export function whiteCastRegression(before, after) {
  const valid = m => m && (!m.width || Math.max(m.width, m.height || 0) >= 500) &&
    m.whites?.fraction >= CAST_LIMITS.minWhiteShare && Number.isFinite(m.whites.a) && Number.isFinite(m.whites.b);
  if (!valid(before) || !valid(after)) return false;
  const a = before.whites, b = after.whites, ratio = b.fraction / a.fraction;
  return ratio >= 0.5 && ratio <= 2 && Math.hypot(b.a, b.b) - Math.hypot(a.a, a.b) >= CAST_LIMITS.minCast;
}
