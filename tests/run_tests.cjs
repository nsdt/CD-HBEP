const assert = require('assert');
const { loadApp } = require('../scripts/app_runtime.cjs');

const runtime = loadApp();
const c = runtime.context;

function near(actual, expected, tol, message) {
  assert.ok(Math.abs(actual - expected) <= tol, `${message}: ${actual} vs ${expected}`);
}

function activeCollectionSignature(info, intervalCount, reflected = false) {
  return [info.activeEnvelope, info.activeSlopeBox, info.activeChordSide]
    .map(values => Array.from(values, e => reflected ? intervalCount - 1 - e : e)
      .sort((a, b) => a - b).join(','))
    .join('|');
}

function horizontalReflectionComparison(c, points, curve, samples = 401) {
  const reflectedPoints = points.slice().reverse().map(point => ({ x: -point.x, y: point.y }));
  const reflected = c.computeBeamOnlySP(reflectedPoints);
  const intervalCount = points.length - 1;
  const xRange = points[points.length - 1].x - points[0].x;
  const yValues = points.map(point => point.y);
  const yRange = Math.max(...yValues) - Math.min(...yValues);
  const valueScale = Math.max(yRange, Number.MIN_VALUE);
  const slopeScale = Math.max(yRange / xRange, Number.MIN_VALUE);
  let curveDifference = 0;
  for (let sample = 0; sample < samples; sample++) {
    const x = points[0].x + xRange * sample / Math.max(1, samples - 1);
    curveDifference = Math.max(curveDifference, Math.abs(curve.eval(x) - reflected.eval(-x)) / valueScale);
  }
  let slopeDifference = 0;
  for (let i = 0; i < points.length; i++) {
    slopeDifference = Math.max(slopeDifference,
      Math.abs(curve.slopes[i] + reflected.slopes[points.length - 1 - i]) / slopeScale);
  }
  const reflectedSlack = new Map(reflected.info.chordSideSlack.map(item => [intervalCount - 1 - item.e, item]));
  let slackDifference = 0;
  for (const item of curve.info.chordSideSlack) {
    const counterpart = reflectedSlack.get(item.e);
    if (!counterpart) {
      slackDifference = Infinity;
      break;
    }
    slackDifference = Math.max(slackDifference, Math.abs(item.effective - counterpart.effective) / valueScale);
  }
  return {
    reflected,
    activeMismatch: activeCollectionSignature(curve.info, intervalCount) !==
      activeCollectionSignature(reflected.info, intervalCount, true),
    curveDifference,
    slopeDifference,
    slackDifference,
    factorDifference: Math.abs((curve.info.bounds.sideRelaxationFactor ?? 1) -
      (reflected.info.bounds.sideRelaxationFactor ?? 1)),
  };
}

function verifySc(points, curve, label) {
  const info = curve.info;
  assert.ok(info.stats.maxViolation <= 1e-9, `${label}: bound violation ${info.stats.maxViolation}`);
  assert.ok(info.solverKkt <= 1e-7, `${label}: KKT residual ${info.solverKkt}`);
  assert.strictEqual(info.repairedBounds, 0, `${label}: silent bound repair`);
  const affine = c.sc2AffineNormalizeInput(points);
  const normalizedPoints = affine.points;
  const normalizedSlopes = curve.slopes.map(value => value / affine.slopeScale);
  const normalizedOpts = c.spOptions(normalizedPoints);
  Object.defineProperty(normalizedOpts, '_sc2Cache', {
    value: c.sc2PrepareData(normalizedPoints, true), enumerable: false,
  });

  const residual = c.sc2DetectActivations(
    normalizedPoints,
    normalizedSlopes,
    normalizedOpts,
    new Set(info.activeEnvelope),
    new Set(info.activeSlopeBox),
    new Set(info.activeChordSide),
  );
  assert.strictEqual(
    residual.addEnv.length + residual.addMono.length + residual.addSide.length,
    0,
    `${label}: residual activation`,
  );

  for (const e of info.activeEnvelope) {
    const env = c.sc2EnvelopeViolation(normalizedPoints, normalizedSlopes, e, normalizedOpts);
    assert.ok(env.amount <= 1e-9 && env.handleAmount <= 1e-9, `${label}: envelope guarantee e${e}`);
  }
  for (const e of info.activeSlopeBox) {
    const reverse = c.sc2ReverseMotion(normalizedPoints, normalizedSlopes, e, normalizedOpts);
    assert.ok(reverse.amount <= 1e-9, `${label}: monotonicity guarantee e${e}`);
  }
  for (const slack of info.chordSideSlack) {
    const side = c.sc2ChordSideDeviation(normalizedPoints, normalizedSlopes, slack.e, normalizedOpts);
    assert.ok(side.amount <= slack.effective / affine.yScale + 1e-9, `${label}: chord-side guarantee e${slack.e}`);
  }
}

// The app must contain one definition of every named function.
const names = [...runtime.source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
const counts = names.reduce((acc, name) => ((acc[name] = (acc[name] || 0) + 1), acc), {});
assert.deepStrictEqual(Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 1)), {});
const unusedNames = [...new Set(names)].filter(name => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (runtime.source.match(new RegExp(`\\b${escaped}\\b`, 'g')) || []).length === 1;
});
assert.deepStrictEqual(unusedNames, []);

// All manuscript examples and all app methods execute with finite values.
const methodKeys = ['linear', 'cubic', 'akima', 'makima', 'pchip', 'hyman', 'dehCubic', 'hanGuo', 'thesisFEM', 'beamSP'];
assert.deepStrictEqual(Array.from(c.manuscriptMethodOrder()), ['cubic', 'makima', 'pchip', 'hyman', 'dehCubic', 'hanGuo', 'beamSP']);
for (const [name, data] of Object.entries(runtime.examples)) {
  const points = c.parseData(data);
  runtime.setPoints(points);
  for (const key of methodKeys) {
    const curve = c.computeMethod(key, points);
    for (const x of c.makeGrid(points, 401)) assert.ok(Number.isFinite(curve.eval(x)), `${name}/${key}: nonfinite value`);
    if (curve.metricsSupported !== false) {
      const metrics = c.metricForEval(points, curve, 700);
      assert.ok(Object.values(metrics).every(Number.isFinite), `${name}/${key}: nonfinite metric`);
    }
    if (key === 'beamSP') {
      verifySc(points, curve, name);
      const compact = c.computeBeamOnlySP(points, { compact: true });
      assert.strictEqual(compact.slopes.length, curve.slopes.length);
      for (let i = 0; i < curve.slopes.length; i++) near(compact.slopes[i], curve.slopes[i], 1e-10, `${name}: compact slope ${i}`);
    }
  }
}

// The banded beam objective must match the element matrix stated in the
// manuscript.
{
  const points = [{ x: 0, y: 1 }, { x: 0.4, y: -0.5 }, { x: 1.7, y: 2 }, { x: 3, y: 1.25 }];
  runtime.setPoints(points);
  const n = points.length;
  const expectedBeam = { lower: Array(n - 1).fill(0), diag: Array(n).fill(0), upper: Array(n - 1).fill(0) };
  const expectedBeamG = Array(n).fill(0);
  for (let e = 0; e < n - 1; e++) {
    const h = points[e + 1].x - points[e].x;
    const delta = (points[e + 1].y - points[e].y) / h;
    expectedBeam.diag[e] += 4 / h; expectedBeam.diag[e + 1] += 4 / h;
    expectedBeam.lower[e] += 2 / h; expectedBeam.upper[e] += 2 / h;
    expectedBeamG[e] += -6 * delta / h; expectedBeamG[e + 1] += -6 * delta / h;
  }
  const beam = c.assembleBeamSlopeTri(points);
  for (let i = 0; i < n; i++) {
    near(beam.T.diag[i], expectedBeam.diag[i], 1e-12, `beam diagonal ${i}`);
    near(beam.g[i], expectedBeamG[i], 1e-12, `beam linear term ${i}`);
  }
  for (let i = 0; i < n - 1; i++) {
    near(beam.T.lower[i], expectedBeam.lower[i], 1e-12, `beam lower ${i}`);
    near(beam.T.upper[i], expectedBeam.upper[i], 1e-12, `beam upper ${i}`);
  }
  const beamSlopes = c.solveTridiagonalArrays(beam.T.lower, beam.T.diag, beam.T.upper, beam.g.map(value => -value));
  const naturalSlopes = c.makeNaturalCubic(points).slopes;
  for (let i = 0; i < n; i++) near(beamSlopes[i], naturalSlopes[i], 2e-12, `pure beam/natural slope ${i}`);
}

// The guaranteed fallback must solve mixed finite, one-sided, equality, and
// unrestricted boxes when the fast sweep budget is exhausted deliberately.
{
  const rng = c.seededRandom(915731);
  for (let trial = 0; trial < 250; trial++) {
    const n = 2 + Math.floor(rng() * 11);
    const off = Array.from({ length: n - 1 }, () => (0.05 + 1.2 * rng()) * (rng() < 0.5 ? -1 : 1));
    const diag = Array.from({ length: n }, (_, i) =>
      (i ? Math.abs(off[i - 1]) : 0) + (i < n - 1 ? Math.abs(off[i]) : 0) + 0.2 + 1.5 * rng());
    const q = Array.from({ length: n }, () => 6 * rng() - 3);
    const lower = Array(n), upper = Array(n);
    for (let i = 0; i < n; i++) {
      const kind = i === 0 ? 1 : Math.floor(5 * rng());
      if (kind === 0) { lower[i] = -Infinity; upper[i] = Infinity; }
      else if (kind === 1) { lower[i] = -2 * rng(); upper[i] = Infinity; }
      else if (kind === 2) { lower[i] = -Infinity; upper[i] = 2 * rng(); }
      else if (kind === 3) { lower[i] = -2 * rng(); upper[i] = 2 * rng(); }
      else { lower[i] = upper[i] = 2 * rng() - 1; }
    }
    const T = { lower: off.slice(), diag, upper: off.slice() };
    const fallback = c.solveBoxQPHybrid(T, q, lower, upper, null, { maxFastSweeps: 0 });
    assert.strictEqual(fallback.fallbackUsed, true, `forced fallback ${trial}`);
    assert.ok(fallback.maxPrimalViolation <= 1e-11, `forced fallback primal ${trial}`);
    assert.ok(fallback.maxKktViolation <= 1e-9, `forced fallback KKT ${trial}`);
    assert.ok(fallback.pangHanPivots <= 2 * fallback.reducedVariables, `forced fallback pivot bound ${trial}`);
    const ordinary = c.solveBoxQPHybrid(T, q, lower, upper, null);
    for (let i = 0; i < n; i++) near(fallback.theta[i], ordinary.theta[i], 2e-9, `fallback agreement ${trial}/${i}`);
  }
}

// The reverse-motion amount is half of the total variation beyond the endpoint
// change. It therefore retains the previous opposite-motion interpretation on
// nonflat intervals and detects nonconstant motion on exact-flat intervals.
{
  const flatPoints = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
  const flatOpts = c.spOptions(flatPoints);
  Object.defineProperty(flatOpts, '_sc2Cache', {
    value: c.sc2PrepareData(flatPoints, true), enumerable: false,
  });
  const flatReverse = c.sc2ReverseMotion(flatPoints, [1, -1], 0, flatOpts);
  near(flatReverse.totalVariation, 0.5, 1e-12, 'flat total variation');
  near(flatReverse.endpointVariation, 0, 1e-12, 'flat endpoint variation');
  near(flatReverse.amount, 0.25, 1e-12, 'flat excess-total-variation amount');

  const risingPoints = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const risingOpts = c.spOptions(risingPoints);
  Object.defineProperty(risingOpts, '_sc2Cache', {
    value: c.sc2PrepareData(risingPoints, true), enumerable: false,
  });
  const risingReverse = c.sc2ReverseMotion(risingPoints, [-1, 3], 0, risingOpts);
  near(risingReverse.totalVariation, 1.25, 1e-12, 'nonflat total variation');
  near(risingReverse.endpointVariation, 1, 1e-12, 'nonflat endpoint variation');
  near(risingReverse.amount, 0.125, 1e-12, 'nonflat reverse-motion amount');

  const plateauPoints = [0, 1, 1, 0].map((y, x) => ({ x, y }));
  runtime.setPoints(plateauPoints);
  const plateauCurve = c.computeBeamOnlySP(plateauPoints);
  assert.ok(plateauCurve.info.activeSlopeBox.includes(1), 'exact-flat interval activates the reverse guard');
  near(plateauCurve.slopes[1], 0, 1e-12, 'exact-flat left slope after activation');
  near(plateauCurve.slopes[2], 0, 1e-12, 'exact-flat right slope after activation');
  verifySc(plateauPoints, plateauCurve, 'exact-flat plateau');
}

// A constant data set has zero vertical range in both the manuscript
// definition and the executable tolerance model. Its exact-flat intervals do
// not activate because their total variation is also zero.
{
  const points = [{ x: 0, y: 2 }, { x: 0.2, y: 2 }, { x: 1.5, y: 2 }, { x: 3, y: 2 }];
  runtime.setPoints(points);
  assert.strictEqual(c.sc2PrepareData(points, true).yr, 0);
  const curve = c.computeBeamOnlySP(points);
  assert.strictEqual(curve.info.activeSlopeBox.length, 0);
  for (let i = 0; i < curve.slopes.length; i++) near(curve.slopes[i], 0, 1e-12, `constant slope ${i}`);
  verifySc(points, curve, 'constant data');
}

// Internal affine normalization must preserve the active interval indices and
// the transformed curve over extreme changes of units, origins, and sign.
{
  const transforms = [
    { ax: 1e-8, bx: 0, cy: 1, by: 0, tol: 2e-11 },
    { ax: 1e8, bx: 0, cy: 1, by: 0, tol: 2e-11 },
    { ax: 1, bx: 0, cy: 1e-8, by: 0, tol: 2e-11 },
    { ax: 1, bx: 0, cy: 1e8, by: 0, tol: 2e-11 },
    { ax: 1, bx: 0, cy: -1, by: 0, tol: 2e-11 },
    { ax: -1, bx: 0, cy: 1, by: 0, tol: 2e-11 },
    { ax: 1, bx: 1e8, cy: 1, by: 1e8, tol: 2e-6 },
  ];
  for (const [name, text] of Object.entries(runtime.examples)) {
    const points = c.parseData(text), base = c.computeBeamOnlySP(points);
    const x0 = points[0].x, x1 = points[points.length - 1].x;
    const yr = Math.max(...points.map(point => point.y)) - Math.min(...points.map(point => point.y));
    for (const transform of transforms) {
      const transformedPoints = points.map(point => ({
        x: transform.ax * point.x + transform.bx,
        y: transform.cy * point.y + transform.by,
      })).sort((a, b) => a.x - b.x);
      const transformed = c.computeBeamOnlySP(transformedPoints);
      assert.strictEqual(
        activeCollectionSignature(transformed.info, points.length - 1, transform.ax < 0),
        activeCollectionSignature(base.info, points.length - 1),
        `${name}: affine active-set invariance`,
      );
      for (let sample = 0; sample <= 100; sample++) {
        const x = x0 + (x1 - x0) * sample / 100;
        const expected = transform.cy * base.eval(x) + transform.by;
        const actual = transformed.eval(transform.ax * x + transform.bx);
        const scale = Math.max(1, Math.abs(transform.cy) * yr);
        assert.ok(Math.abs(actual - expected) / scale <= transform.tol, `${name}: affine curve invariance`);
      }
      const audit = c.sc2CertificationAudit(transformedPoints, transformed);
      assert.strictEqual(audit.residualActivations, 0, `${name}: affine residual activation`);
      assert.ok(audit.maxGuaranteeViolation <= 1e-9, `${name}: affine guarantee violation`);
    }
  }

  const parsed = c.parseData('0,0\n5e-12,1\n1e-11,0');
  assert.strictEqual(parsed.length, 3, 'input parsing must not merge distinct small-scale abscissae');
}

// Extreme knot ratios test conditioning rather than a change of coordinate
// units.  The residual certificate and every interval certificate must remain
// valid when h_max/h_min reaches 1e8.
{
  const rng = c.seededRandom(97531), ratio = 1e8;
  for (let trial = 0; trial < 24; trial++) {
    const n = 8 + Math.floor(rng() * 13);
    const source = c.randomBenchmarkPoints(rng, n, ['oscillatory', 'turn', 'wiggle', 'plateau'][trial % 4], 'uniform');
    const weights = Array.from({ length: n - 1 }, (_, index) => Math.exp(Math.log(ratio) * index / Math.max(1, n - 2)));
    for (let index = weights.length - 1; index > 0; index--) {
      const other = Math.floor(rng() * (index + 1));
      [weights[index], weights[other]] = [weights[other], weights[index]];
    }
    const total = weights.reduce((sum, value) => sum + value, 0), xs = [0];
    for (const weight of weights) xs.push(xs[xs.length - 1] + weight / total);
    xs[xs.length - 1] = 1;
    const points = source.map((point, index) => ({ x: xs[index], y: point.y }));
    const curve = c.computeBeamOnlySP(points), audit = c.sc2CertificationAudit(points, curve);
    assert.ok(curve.info.solverKkt <= 1e-9, `extreme knots: KKT residual ${trial}`);
    assert.ok(curve.info.solverMaxPrimal <= 1e-9, `extreme knots: primal residual ${trial}`);
    assert.strictEqual(audit.residualActivations, 0, `extreme knots: residual activation ${trial}`);
    assert.ok(audit.maxGuaranteeViolation <= 1e-9, `extreme knots: guarantee violation ${trial}`);
  }
}

// The sharp Hermite slope box and the one-sided chord bounds must give their
// stated full-interval guarantees, including the flat-interval box.
{
  const increasing = [{ x: 0, y: 0 }, { x: 1.7, y: 2.5 }];
  const delta = (increasing[1].y - increasing[0].y) / (increasing[1].x - increasing[0].x);
  for (const a of [0, 0.3, 1.5, 3]) {
    for (const b of [0, 0.7, 2.2, 3]) {
      const slopes = [a * delta, b * delta];
      for (let j = 0; j <= 200; j++) {
        assert.ok(c.derivativeValue(increasing, slopes, 0, j / 200) >= -1e-12, `increasing slope box a=${a}, b=${b}, j=${j}`);
      }
    }
  }

  const h = increasing[1].x - increasing[0].x;
  const eta = 0.17, s = 3 * eta / h;
  const convexSlopes = [delta - s, delta + s];
  const concaveSlopes = [delta + s, delta - s];
  for (let j = 0; j <= 200; j++) {
    const t = j / 200;
    assert.ok(c.sc2ChordDeviationValue(increasing, convexSlopes, 0, t) >= -eta - 1e-12, `convex chord bound j=${j}`);
    assert.ok(c.sc2ChordDeviationValue(increasing, concaveSlopes, 0, t) <= eta + 1e-12, `concave chord bound j=${j}`);
  }

  const flat = [{ x: 0, y: 4 }, { x: 1, y: 4 }];
  const flatOpts = c.spOptions(flat);
  const flatBounds = c.sc2BuildActiveBounds(flat, flatOpts, new Set(), new Set([0]), new Set());
  assert.deepStrictEqual(Array.from(flatBounds.lower), [0, 0]);
  assert.deepStrictEqual(Array.from(flatBounds.upper), [0, 0]);
}

// The linear-time natural and not-a-knot solvers must reproduce the former
// dense formulations on representative small nonuniform problems.
{
  const denseNaturalSecond = points => {
    const n = points.length;
    const h = Array.from({ length: n - 1 }, (_, i) => points[i + 1].x - points[i].x);
    const A = c.zeros(n, n), rhs = Array(n).fill(0);
    A[0][0] = 1; A[n - 1][n - 1] = 1;
    for (let i = 1; i < n - 1; i++) {
      A[i][i - 1] = h[i - 1]; A[i][i] = 2 * (h[i - 1] + h[i]); A[i][i + 1] = h[i];
      rhs[i] = 6 * ((points[i + 1].y - points[i].y) / h[i] - (points[i].y - points[i - 1].y) / h[i - 1]);
    }
    return c.solveLinear(A, rhs);
  };
  const denseNotAKnotSlopes = points => {
    const n = points.length;
    const h = Array.from({ length: n - 1 }, (_, i) => points[i + 1].x - points[i].x);
    const d = h.map((value, i) => (points[i + 1].y - points[i].y) / value);
    const A = c.zeros(n, n), rhs = Array(n).fill(0);
    A[0][0] = -h[1]; A[0][1] = h[0] + h[1]; A[0][2] = -h[0];
    for (let i = 1; i < n - 1; i++) {
      A[i][i - 1] = h[i - 1]; A[i][i] = 2 * (h[i - 1] + h[i]); A[i][i + 1] = h[i];
      rhs[i] = 6 * (d[i] - d[i - 1]);
    }
    A[n - 1][n - 3] = -h[n - 2]; A[n - 1][n - 2] = h[n - 3] + h[n - 2]; A[n - 1][n - 1] = -h[n - 3];
    const M = c.solveLinear(A, rhs), slopes = Array(n).fill(0);
    slopes[0] = d[0] - h[0] * (2 * M[0] + M[1]) / 6;
    for (let i = 1; i < n - 1; i++) {
      const left = d[i - 1] + h[i - 1] * (M[i - 1] + 2 * M[i]) / 6;
      const right = d[i] - h[i] * (2 * M[i] + M[i + 1]) / 6;
      slopes[i] = 0.5 * (left + right);
    }
    slopes[n - 1] = d[n - 2] + h[n - 2] * (M[n - 2] + 2 * M[n - 1]) / 6;
    return slopes;
  };
  const rng = c.seededRandom(314159);
  for (let n = 4; n <= 12; n++) {
    const points = c.randomBenchmarkPoints(rng, n, 'oscillatory', 'nonuniform');
    const natural = c.makeNaturalCubic(points).second, denseNatural = denseNaturalSecond(points);
    const notAKnot = c.notAKnotCubicSlopes(points), denseNotAKnot = denseNotAKnotSlopes(points);
    for (let i = 0; i < n; i++) {
      near(natural[i], denseNatural[i], 2e-9, `natural tridiagonal n=${n}, i=${i}`);
      near(notAKnot[i], denseNotAKnot[i], 2e-9, `not-a-knot tridiagonal n=${n}, i=${i}`);
    }
  }
}

// DEH regression: the final 1989 algorithm retains the paper's relaxed
// nonzero derivative near this nonmonotone Manni example; the old box-only
// implementation forced the same derivative to zero.
{
  const points = c.parseData(runtime.examples.osc);
  const slopes = c.dehCubicMonotoneSlopes(points);
  near(slopes[3], 3.489207271481794, 1e-10, 'DEH final cubic regression');
}

// Han--Guo regression: Eq. (3) minimizes the derivative oscillation I_1 on
// nonuniform knots.  Check the published normal equations on all four scalar
// examples from Section 5 and retain an independent fixed slope regression for
// the monotone example in Fig. 2.
{
  const paperCases = [
    {
      label: 'glucose',
      x: [0.5, 3.5, 6, 8.5, 11, 14, 17, 20],
      y: [93, 104, 120, 98, 86, 102, 81, 90],
    },
    {
      label: 'monotone',
      x: [0, 3, 5, 6, 8, 11],
      y: [0, 1, 2, 4, 5, 6],
    },
    {
      label: 'semicircle',
      x: [0, 0.3, 1, 1.8, 3, 4.2, 5, 5.7, 6],
      y: [0, 0.3, 1, 1.8, 3, 4.2, 5, 5.7, 6].map(x => Math.sqrt(Math.max(0, 9 - (x - 3) ** 2))),
    },
    {
      label: 'inverse-square',
      x: [0.1, 0.2, 0.6, 1.0, 1.2, 1.4],
      y: [0.1, 0.2, 0.6, 1.0, 1.2, 1.4].map(x => 1 / (x * x)),
    },
  ];
  for (const item of paperCases) {
    const points = item.x.map((x, index) => ({ x, y: item.y[index] }));
    const slopes = c.hanGuoMinimalDerivativeOscillationSlopes(points);
    const curve = c.makeHanGuoMDO(points);
    const h = item.x.slice(1).map((x, index) => x - item.x[index]);
    const delta = h.map((value, index) => (item.y[index + 1] - item.y[index]) / value);
    near(4 * slopes[0] - slopes[1], 3 * delta[0], 2e-11, `${item.label}: Han--Guo left equation`);
    for (let i = 1; i < points.length - 1; i++) {
      const span = h[i - 1] + h[i];
      const mu = h[i - 1] / span;
      const lambda = h[i] / span;
      near(-mu * slopes[i - 1] + 4 * slopes[i] - lambda * slopes[i + 1],
        3 * (item.y[i + 1] - item.y[i - 1]) / span, 2e-11,
        `${item.label}: Han--Guo interior equation ${i}`);
    }
    near(-slopes[slopes.length - 2] + 4 * slopes[slopes.length - 1],
      3 * delta[delta.length - 1], 2e-11, `${item.label}: Han--Guo right equation`);
    for (const point of points) near(curve.eval(point.x), point.y, 2e-11, `${item.label}: Han--Guo interpolation`);
  }
  const monotone = paperCases[1];
  const monotonePoints = monotone.x.map((x, index) => ({ x, y: monotone.y[index] }));
  const expected = [
    0.36101083032490977,
    0.44404332129963897,
    0.8989169675090252,
    0.8989169675090252,
    0.44404332129963897,
    0.3610108303249097,
  ];
  const actual = c.hanGuoMinimalDerivativeOscillationSlopes(monotonePoints);
  for (let i = 0; i < expected.length; i++) near(actual[i], expected[i], 2e-14, `Han--Guo fixed slope ${i}`);

  const twoPoint = [{ x: -2, y: 7 }, { x: 3, y: -1 }];
  const twoPointSlope = (twoPoint[1].y - twoPoint[0].y) / (twoPoint[1].x - twoPoint[0].x);
  assert.deepStrictEqual(Array.from(c.hanGuoMinimalDerivativeOscillationSlopes(twoPoint)), [twoPointSlope, twoPointSlope]);

  const ax = 3.7, bx = -4.2, ay = -2.5, by = 8.3;
  const transformed = monotonePoints.map(point => ({ x: ax * point.x + bx, y: ay * point.y + by }));
  const transformedSlopes = c.hanGuoMinimalDerivativeOscillationSlopes(transformed);
  for (let i = 0; i < expected.length; i++) near(transformedSlopes[i], ay * expected[i] / ax, 2e-13, `Han--Guo affine slope ${i}`);
}

// A_side and the chord-side guard share the manuscript's local classifier.
{
  const consistent = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 3 }];
  const inconsistent = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 1 }];
  assert.strictEqual(c.metricChordSideSign(consistent, 1), 1);
  assert.strictEqual(c.metricChordSideSign(inconsistent, 1), 0);
}

// Accumulated chord deviation is integrated exactly after splitting the
// cubic deviation at its interior sign change.
{
  const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const slopes = [0, 0];
  const curve = { eval: x => c.hermiteValueAt(points, slopes, 0, x), slopes };
  const metrics = c.metricForEval(points, curve, 31);
  near(metrics.A_chord, 1 / 16, 2e-15, 'analytic accumulated chord deviation');
  const derivativeScale = 40 / 7;
  const deficitRoot = (1 - Math.sqrt(1 - 4 / derivativeScale)) / 2;
  const expectedMonotoneDeficit = 2 * (deficitRoot - derivativeScale * deficitRoot ** 2 / 2 + derivativeScale * deficitRoot ** 3 / 3);
  near(metrics.A_mono, expectedMonotoneDeficit, 2e-15, 'analytic accumulated monotone-speed deficit');

  const sidePoints = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 4 }];
  const sideSlopes = [0, 0, 0];
  const sideCurve = {
    eval: x => {
      const interval = x <= 1 ? 0 : 1;
      return c.hermiteValueAt(sidePoints, sideSlopes, interval, x - interval);
    },
    slopes: sideSlopes,
  };
  near(c.metricForEval(sidePoints, sideCurve, 31).A_side, 1 / 64, 2e-15, 'analytic accumulated chord-side deviation');
}

// Every behavioral diagnostic is dimensionless and invariant under
// independent affine changes of the axes.
{
  const points = [{ x: 0.2, y: -1 }, { x: 1.1, y: 0.7 }, { x: 2.8, y: -0.2 }, { x: 4.5, y: 2.1 }];
  const base = c.makeNaturalCubic(points);
  const metrics = c.metricForEval(points, base, 700);
  const ax = 3.7, bx = -2.4, ay = -5.2, by = 8.1;
  const transformedPoints = points.map(point => ({ x: ax * point.x + bx, y: ay * point.y + by }));
  const transformedSlopes = base.slopes.map(slope => ay * slope / ax);
  const transformedCurve = { eval: x => {
    const originalX = (x - bx) / ax;
    return ay * base.eval(originalX) + by;
  }, slopes: transformedSlopes };
  const transformedMetrics = c.metricForEval(transformedPoints, transformedCurve, 700);
  for (const key of ['E_band', 'M_chord', 'A_chord', 'R_len', 'A_mono', 'A_side']) {
    near(transformedMetrics[key], metrics[key], 2e-11, `dimensionless metric ${key}`);
  }
}

// The browser controls and exporter share one manuscript benchmark profile.
{
  const settings = c.manuscriptBenchmarkSettings();
  assert.deepStrictEqual({
    randomSeed: settings.randomSeed,
    randomCases: settings.randomCases,
    randomNMin: settings.randomNMin,
    randomNMax: settings.randomNMax,
    randomMixNMin: settings.randomMixNMin,
    randomMixNMax: settings.randomMixNMax,
    gallerySeed: settings.gallerySeed,
    timingSeed: settings.timingSeed,
    timingRepeats: settings.timingRepeats,
  }, {
    randomSeed: 123456,
    randomCases: 2000,
    randomNMin: 8,
    randomNMax: 20,
    randomMixNMin: 18,
    randomMixNMax: 36,
    gallerySeed: 987654,
    timingSeed: 246810,
    timingRepeats: 5,
  });
  assert.deepStrictEqual(Array.from(settings.timingSizes), [10, 100, 1000, 5000, 10000, 50000, 100000]);
  const activationControls = [
    ['spBaseBandFraction', 'baseBandFraction', 0.0075, 0.009],
    ['spFlatRangeFraction', 'flatRangeFraction', 0.05, 0.06],
    ['spIsolatedBandMultiplier', 'isolatedBandMultiplier', 2.5, 2.8],
    ['spIsolatedScoreOffset', 'isolatedScoreOffset', 0.35, 0.42],
    ['spEnvelopeLocalFraction', 'envelopeLocalFraction', 0.02, 0.03],
    ['spEnvelopeRangeFraction', 'envelopeRangeFraction', 0.002, 0.003],
    ['spEnvelopeIsolationGain', 'envelopeIsolationGain', 1.25, 1.4],
    ['spHandleBandMultiplier', 'handleBandMultiplier', 1.5, 1.7],
    ['spReverseLocalFraction', 'reverseLocalFraction', 0.08, 0.09],
    ['spReverseIsolationGain', 'reverseIsolationGain', 2.0, 2.2],
    ['spSideLocalFraction', 'sideLocalFraction', 0.20, 0.24],
    ['spSideRangeFraction', 'sideRangeFraction', 0.07, 0.08],
  ];
  const optionPoints = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  for (const [id, key, defaultValue, changedValue] of activationControls) {
    near(c.spOptions(optionPoints)[key], defaultValue, 1e-15, `default activation constant ${key}`);
    runtime.setValue(id, changedValue);
    near(c.spOptions(optionPoints)[key], changedValue, 1e-15, `editable activation constant ${key}`);
    runtime.setValue(id, defaultValue);
  }
  const activationDefinitions = Array.from(c.activationParameterDefinitions());
  assert.strictEqual(activationDefinitions.length, 12);
  assert.deepStrictEqual(activationDefinitions.map(item => item.key), activationControls.map(item => item[1]));
  assert.deepStrictEqual({ ...c.activationReferenceConfiguration() },
    Object.fromEntries(activationControls.map(([, key, value]) => [key, value])));
  const activationSettings = c.activationValidationSettings();
  assert.strictEqual(activationSettings.globalCandidates, 1024);
  assert.strictEqual(activationSettings.calibrationRandomCases, 200);
  assert.strictEqual(activationSettings.holdoutRandomCases, 500);
  const sobol = Array.from(c.digitallyShiftedSobolPoints(32, 12, activationSettings.sobolSeed), point => Array.from(point));
  assert.strictEqual(sobol.length, 32);
  assert(sobol.every(point => point.length === 12 && point.every(value => value >= 0 && value < 1)));
  assert.strictEqual(new Set(sobol.map(point => point.join(','))).size, sobol.length);
  const searched = { ...c.activationConfigurationFromUnitPoint(sobol[0], 0.5, 2) };
  for (const definition of activationDefinitions) {
    assert(searched[definition.key] >= 0.5 * definition.reference && searched[definition.key] <= 2 * definition.reference,
      `${definition.key}: Sobol-mapped value lies outside the validation domain`);
  }
  const holdoutCases = Array.from(c.activationHoldoutCases());
  assert.strictEqual(holdoutCases.length, 4);
  for (const item of holdoutCases) {
    const points = Array.from(c.activationHoldoutPoints(item.key, 45, 'nonuniform'));
    const curve = c.computeBeamOnlySP(points);
    const errors = c.activationHoldoutErrors(item.key, points, curve, 1001);
    assert(Number.isFinite(errors.eInf) && Number.isFinite(errors.e2));
    assert(Number.isFinite(c.activationBeamIntervention(curve)) && c.activationBeamIntervention(curve) >= 0);
  }

  const timingDataSets = Array.from(c.timingBenchmarkDataSets(c.seededRandom(settings.timingSeed), 30));
  assert.strictEqual(timingDataSets.length, 14);
  assert.strictEqual(timingDataSets.filter(item => item.family === 'continuous').length, 6);
  assert.strictEqual(timingDataSets.filter(item => item.family === 'discrete').length, 8);
  assert(timingDataSets.every(item => item.points.length === 30));
  assert.strictEqual(new Set(timingDataSets.map(item => item.key)).size, 14);
  const thresholdPoints = [{ x: 0, y: 0 }, { x: 0.5, y: 0.01 }, { x: 1, y: 1 }];
  const thresholdOptions = c.spOptions(thresholdPoints);
  thresholdOptions._sc2Cache = c.sc2PrepareData(thresholdPoints, true);
  near(c.sc2ActivationThreshold(thresholdPoints, 0, thresholdOptions, 'reverse'), 0.004, 1e-15,
    'reverse range floor is derived from omega_rev^loc omega_flat R_y');
  near(c.sc2ChordSideThreshold(thresholdPoints, 0, thresholdOptions), 0.07, 1e-15,
    'chord-side range term dominates the removed epsilon multiple');
  for (const legacyId of ['spBaseBandPct', 'spRevYrScale', 'spChordSideTolScale', 'spRoughW', 'spTurnBoost',
    'spEndW', 'spShortBoost', 'spTightRadius', 'spMono', 'spAdaptiveMono', 'spChordCap',
    'spLocalTarget', 'spSlopeMu', 'spWiggleTolPct', 'spChordCapPct', 'spChordCapMinPct',
    'spChordCapTurn', 'spBeamKappa']) {
    assert.ok(!runtime.source.includes(legacyId), `legacy option remains in app source: ${legacyId}`);
  }
  for (const id of ['knownN', 'knownSpacing', 'knownSmoothWaveBtn', 'knownSmoothArcBtn',
    'knownLocalizedPeakBtn', 'knownSmoothPlateausBtn', 'knownMonotoneSigmoidBtn', 'knownBoundaryLayerBtn']) {
    assert.ok(runtime.source.includes(`'${id}'`) || runtime.source.includes(`${id}:`),
      `missing exact-function app binding ${id}`);
  }
}

// The six guard-motivation examples are reproducible members of the fixed
// benchmark profile (plus Arc), and their highlighted intervals are activated
// by exactly one guard in the complete method.
{
  const cases = Array.from(c.guardMotivationCases());
  assert.deepStrictEqual(cases.map(item => item.key), [
    'envelope-flat-runs',
    'envelope-alternating',
    'reverse-largest-increase',
    'reverse-only-turn',
    'side-arc',
    'side-largest-change',
  ]);
  const activeKey = { envelope: 'activeEnvelope', reverse: 'activeSlopeBox', side: 'activeChordSide' };
  const toggleId = { envelope: 'spOver', reverse: 'spReverseGuard', side: 'spChordSide' };
  const retainedCounterexamples = new Set();
  for (const item of cases) {
    runtime.setChecked('spOver', true);
    runtime.setChecked('spReverseGuard', true);
    runtime.setChecked('spChordSide', true);
    const enabled = c.computeBeamOnlySP(item.points);
    assert.ok(enabled.info[activeKey[item.guard]].includes(item.focusInterval),
      `${item.key}: highlighted guard is inactive`);
    for (const other of ['envelope', 'reverse', 'side'].filter(guard => guard !== item.guard)) {
      assert.ok(!enabled.info[activeKey[other]].includes(item.focusInterval),
        `${item.key}: highlighted interval is not guard-specific`);
    }
    runtime.setChecked(toggleId[item.guard], false);
    const disabled = c.computeBeamOnlySP(item.points);
    const audit = c.sc2GuardTriggerAudit(item.points, disabled, item.focusInterval);
    if (audit[item.guard].triggered) {
      for (const other of ['envelope', 'reverse', 'side'].filter(guard => guard !== item.guard)) {
        assert.ok(!audit[other].triggered, item.key + ': omitted-guard artifact also triggers ' + other);
      }
      retainedCounterexamples.add(item.guard);
    }
    const yValues = item.points.map(point => point.y);
    const yRange = Math.max(...yValues) - Math.min(...yValues) || 1;
    let difference = 0;
    for (const x of c.makeGrid(item.points, 601)) {
      difference = Math.max(difference, Math.abs(enabled.eval(x) - disabled.eval(x)) / yRange);
    }
    assert.ok(difference > 1e-3, `${item.key}: guard comparison is not visually distinct`);
  }
  assert.deepStrictEqual(Array.from(retainedCounterexamples).sort(), ['envelope', 'reverse', 'side'],
    'the fixed examples do not witness nonredundancy of all three guards');
  runtime.setChecked('spOver', true);
  runtime.setChecked('spReverseGuard', true);
  runtime.setChecked('spChordSide', true);
}

// User-reported modified Arc case: local chord-side certification must prevent
// the large downward swing without relying on a five-difference run.
{
  const points = c.parseData(`0, 2
0.048943, 1.690983
0.190983, 1.412215
0.412215, 1.190983
0.690983, 1.048943
1, 2
1.309017, 1.048943
1.587785, 1.190983
1.809017, 1.412215
1.951057, 1.690983
2, 2`);
  runtime.setPoints(points);
  const curve = c.computeBeamOnlySP(points);
  verifySc(points, curve, 'modified Arc');
  assert.deepStrictEqual(Array.from(curve.info.activeChordSide), [1, 3, 6, 8]);
  for (const x of [0.10, 0.15, 0.20, 1.80, 1.85, 1.90]) {
    assert.ok(curve.eval(x) >= 1.35, `modified Arc: downward swing at x=${x}`);
  }
}

// Plateau generation must produce multiple exact flat runs at distinct levels,
// and must not collapse to a merely monotone sigmoid-like data set.
{
  const rng = c.seededRandom(20260710);
  for (const spacing of ['uniform', 'nonuniform']) {
    for (let trial = 0; trial < 200; trial++) {
      const n = 8 + Math.floor(rng() * 13);
      const points = c.randomBenchmarkPoints(rng, n, 'plateau', spacing);
      const runs = [];
      for (let start = 0; start < points.length;) {
        let end = start + 1;
        while (end < points.length && Math.abs(points[end].y - points[start].y) <= 1e-12) end++;
        if (end - start >= 2) runs.push({ length: end - start, level: points[start].y });
        start = end;
      }
      assert.ok(runs.length >= 3, `${spacing} plateau ${trial}: fewer than three flat runs`);
      assert.ok(new Set(runs.map(run => run.level.toFixed(12))).size >= 3, `${spacing} plateau ${trial}: levels are not distinct`);
      const changes = runs.slice(1).map((run, index) => Math.sign(run.level - runs[index].level));
      assert.ok(changes.some(sign => sign > 0) && changes.some(sign => sign < 0), `${spacing} plateau ${trial}: monotone levels`);
    }
  }
}

// The mixed random class combines all four base generators with reproducible,
// nonnegative weights from balanced, dominant, paired, and plateau-accented profiles.
{
  assert.deepStrictEqual(Array.from(c.randomBenchmarkCategories()),
    ['oscillatory', 'turn', 'wiggle', 'plateau', 'mix']);
  const rng = c.seededRandom(20260715);
  let concentrated = false;
  let balanced = false;
  let plateauDominant = false;
  const profileNames = new Set();
  for (const spacing of ['uniform', 'nonuniform']) {
    for (let trial = 0; trial < 160; trial++) {
      const n = 18 + Math.floor(rng() * 19);
      const points = c.randomBenchmarkPoints(rng, n, 'mix', spacing);
      assert.strictEqual(points.length, n, `${spacing} mix ${trial}: point count`);
      for (let i = 0; i < n - 1; i++) assert.ok(points[i + 1].x > points[i].x, `${spacing} mix ${trial}: knot order`);
      assert.ok(points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)), `${spacing} mix ${trial}: finite values`);
      assert.ok(Math.max(...points.map(point => point.y)) - Math.min(...points.map(point => point.y)) > 1e-8,
        `${spacing} mix ${trial}: constant mixture`);
      assert.strictEqual(points.mixWeights.length, 4, `${spacing} mix ${trial}: weight count`);
      near(points.mixWeights.reduce((sum, value) => sum + value, 0), 1, 2e-15, `${spacing} mix ${trial}: weight sum`);
      assert.ok(points.mixWeights.every(value => value >= 0 && value <= 1), `${spacing} mix ${trial}: weight bounds`);
      assert.ok(typeof points.mixProfile === 'string' && points.mixProfile.length > 0, `${spacing} mix ${trial}: profile name`);
      assert.ok(Number.isInteger(points.mixProfileIndex) && points.mixProfileIndex >= 0 && points.mixProfileIndex < 12,
        `${spacing} mix ${trial}: profile index`);
      profileNames.add(points.mixProfile);
      const largest = Math.max(...points.mixWeights);
      concentrated ||= largest > 0.7;
      balanced ||= largest < 0.4;
      plateauDominant ||= points.mixWeights[3] > 0.8;
    }
  }
  assert.ok(concentrated, 'mixed generator did not produce a concentrated mixture');
  assert.ok(balanced, 'mixed generator did not produce a balanced mixture');
  assert.ok(plateauDominant, 'mixed generator did not produce a plateau-dominant mixture');
  assert.strictEqual(profileNames.size, 12, 'not every mixed profile was sampled');

  const first = c.randomBenchmarkPoints(c.seededRandom(998877), 17, 'mix', 'nonuniform');
  const second = c.randomBenchmarkPoints(c.seededRandom(998877), 17, 'mix', 'nonuniform');
  assert.deepStrictEqual(Array.from(first, point => ({ ...point })), Array.from(second, point => ({ ...point })),
    'mixed generator reproducibility');
  assert.deepStrictEqual(Array.from(first.mixWeights), Array.from(second.mixWeights), 'mixed weight reproducibility');
  assert.strictEqual(first.mixProfile, second.mixProfile, 'mixed profile reproducibility');
  assert.strictEqual(first.mixProfileIndex, second.mixProfileIndex, 'mixed profile-index reproducibility');

  const forcedPlateau = c.randomBenchmarkPoints(c.seededRandom(1234), 28, 'mix', 'uniform', { mixProfileIndex: 4 });
  assert.strictEqual(forcedPlateau.mixProfile, 'plateau-dominant');
  assert.ok(forcedPlateau.mixWeights[3] > 0.8, 'forced plateau profile lost plateau dominance');
}

// The known-function benchmark must remain reproducible and must measure
// interpolation error against functions that are hidden from construction.
{
  const knownCases = Array.from(c.knownBenchmarkCases());
  assert.strictEqual(c.manuscriptBenchmarkSettings().knownEvaluationSamples, 12001,
    'known-function reference-grid count');
  assert.strictEqual(c.activationValidationSettings().knownEvaluationSamples,
    c.manuscriptBenchmarkSettings().knownEvaluationSamples,
    'activation validation and known-function benchmark must share the reference-grid count');
  assert.deepStrictEqual(knownCases.map(item => item.key), [
    'smoothWave',
    'smoothArc',
    'localizedPeak',
    'smoothPlateaus',
    'monotoneSigmoid',
    'boundaryLayer',
  ]);
  for (const knownCase of knownCases) {
    for (const spacing of ['uniform', 'nonuniform']) {
      const points = Array.from(c.knownBenchmarkPoints(knownCase.key, 30, spacing), point => ({ x: point.x, y: point.y }));
      assert.strictEqual(points.length, 30);
      near(points[0].x, 0, 1e-15, `${knownCase.key}/${spacing}: left endpoint`);
      near(points[points.length - 1].x, 1, 1e-15, `${knownCase.key}/${spacing}: right endpoint`);
      for (let i = 0; i < points.length - 1; i++) assert.ok(points[i + 1].x > points[i].x, `${knownCase.key}/${spacing}: knot order ${i}`);
      runtime.setPoints(points);
      for (const key of c.manuscriptMethodOrder()) {
        const curve = c.computeMethod(key, points);
        const errors = c.knownBenchmarkErrors(knownCase.key, points, curve, 4001);
        assert.ok(Number.isFinite(errors.eInf) && errors.eInf >= 0, `${knownCase.key}/${spacing}/${key}: eInf`);
        assert.ok(Number.isFinite(errors.e2) && errors.e2 >= 0, `${knownCase.key}/${spacing}/${key}: e2`);
        assert.ok(Number.isFinite(errors.hMax) && errors.hMax > 0, `${knownCase.key}/${spacing}/${key}: hMax`);
        for (const point of points) near(curve.eval(point.x), c.knownBenchmarkValue(knownCase.key, point.x), 2e-9, `${knownCase.key}/${spacing}/${key}: interpolation`);
      }
    }
  }
  const quadraturePoints = Array.from(c.knownBenchmarkPoints('monotoneSigmoid', 30, 'nonuniform'), point => ({ x: point.x, y: point.y }));
  runtime.setPoints(quadraturePoints);
  const quadratureCurve = c.computeMethod('cubic', quadraturePoints);
  const coarseErrorSampling = c.knownBenchmarkErrors('monotoneSigmoid', quadraturePoints, quadratureCurve, 1001);
  const fineErrorSampling = c.knownBenchmarkErrors('monotoneSigmoid', quadraturePoints, quadratureCurve, 4001);
  near(coarseErrorSampling.e2, fineErrorSampling.e2, 1e-14,
    'known-function e2 is independent of the eInf sampling grid under fixed normalization');
  near(c.knownBenchmarkValue('smoothPlateaus', 0.1), 0, 1e-15, 'known plateau lower level');
  near(c.knownBenchmarkValue('smoothPlateaus', 0.45), 1, 1e-15, 'known plateau upper level');
  near(c.knownBenchmarkValue('smoothPlateaus', 0.85), 0.35, 1e-15, 'known plateau final level');
  near(c.knownBenchmarkValue('monotoneSigmoid', 0), 0, 1e-15, 'known sigmoid left endpoint');
  near(c.knownBenchmarkValue('monotoneSigmoid', 0.5), 0.5, 1e-15, 'known sigmoid midpoint');
  near(c.knownBenchmarkValue('monotoneSigmoid', 1), 1, 1e-15, 'known sigmoid right endpoint');
  near(c.knownBenchmarkValue('boundaryLayer', 0), 1, 1e-15, 'known boundary-layer left endpoint');
  near(c.knownBenchmarkValue('boundaryLayer', 1), 0, 1e-15, 'known boundary-layer right endpoint');
  near(c.knownBenchmarkValue('smoothArc', 0), 1, 1e-15, 'known lifted-arc left endpoint');
  near(c.knownBenchmarkValue('smoothArc', 0.5), 1, 1e-15, 'known arc midpoint');
  near(c.knownBenchmarkValue('smoothArc', 1), 1, 1e-15, 'known lifted-arc right endpoint');
  near(c.knownBenchmarkValue('smoothArc', 0.25), c.knownBenchmarkValue('smoothArc', 0.75), 1e-15,
    'known arc symmetry');
  const adjacentArcAbscissa = 0.690983 / 2;
  const smoothLowerArcValue = x => 1 - (Math.sqrt(1.21 - (2 * x - 1) ** 2) - Math.sqrt(0.21)) / (1.1 - Math.sqrt(0.21));
  near(c.knownBenchmarkValue('smoothArc', adjacentArcAbscissa), smoothLowerArcValue(adjacentArcAbscissa), 2e-15,
    'known lifted arc leaves the adjacent Arc location unchanged');
}

// Manuscript-scale seeded random regression. No empty-box repair is permitted;
// secondary chord-side bounds may only increase their explicitly reported slack.
{
  const rng = c.seededRandom(123456);
  let cases = 0;
  let relaxed = 0;
  let relaxedConstructions = 0;
  let maxAnalyticalSideFactor = 1;
  let maxImplementationSideFactor = 1;
  let maxRounds = 0;
  let fallbackCalls = 0;
  let qpSolves = 0;
  let maxKktResidual = 0;
  let maxRawKktResidual = 0;
  let maxPrimalViolation = 0;
  let reflectionActiveMismatches = 0;
  let maxReflectionCurveDifference = 0;
  let maxReflectionSlopeDifference = 0;
  let maxReflectionSlackDifference = 0;
  let maxReflectionFactorDifference = 0;
  for (const spacing of ['uniform', 'nonuniform']) {
    for (const category of c.randomBenchmarkCategories()) {
      for (let j = 0; j < 200; j++) {
        const nMin = category === 'mix' ? 18 : 8;
        const nMax = category === 'mix' ? 36 : 20;
        const n = nMin + Math.floor(rng() * (nMax - nMin + 1));
        const points = c.randomBenchmarkPoints(rng, n, category, spacing);
        runtime.setPoints(points);
        const curve = c.computeBeamOnlySP(points);
        verifySc(points, curve, `${spacing}/${category}/${j}`);
        const reflection = horizontalReflectionComparison(c, points, curve);
        const reflectedPoints = points.slice().reverse().map(point => ({ x: -point.x, y: point.y }));
        verifySc(reflectedPoints, reflection.reflected, `${spacing}/${category}/${j}/reflected`);
        reflectionActiveMismatches += Number(reflection.activeMismatch);
        maxReflectionCurveDifference = Math.max(maxReflectionCurveDifference, reflection.curveDifference);
        maxReflectionSlopeDifference = Math.max(maxReflectionSlopeDifference, reflection.slopeDifference);
        maxReflectionSlackDifference = Math.max(maxReflectionSlackDifference, reflection.slackDifference);
        maxReflectionFactorDifference = Math.max(maxReflectionFactorDifference, reflection.factorDifference);
        relaxed += curve.info.chordSideSlack.filter(item => item.relaxed).length;
        const analyticalSideFactor = curve.info.bounds.sideRelaxationAnalyticalFactor ?? 1;
        const implementationSideFactor = curve.info.bounds.sideRelaxationFactor ?? analyticalSideFactor;
        relaxedConstructions += Number(analyticalSideFactor > 1 + 1e-12);
        maxAnalyticalSideFactor = Math.max(maxAnalyticalSideFactor, analyticalSideFactor);
        maxImplementationSideFactor = Math.max(maxImplementationSideFactor, implementationSideFactor);
        maxRounds = Math.max(maxRounds, curve.info.roundsUsed);
        fallbackCalls += curve.info.solverFallbackCount;
        qpSolves += curve.info.solverQpSolves;
        maxKktResidual = Math.max(maxKktResidual, curve.info.solverKkt);
        maxRawKktResidual = Math.max(maxRawKktResidual, curve.info.solverRawKkt);
        maxPrimalViolation = Math.max(maxPrimalViolation, curve.info.solverMaxPrimal);
        cases++;
      }
    }
  }
  assert.strictEqual(cases, 2000);
  assert.strictEqual(fallbackCalls, 0, 'manuscript random benchmark fallback count');
  assert.strictEqual(reflectionActiveMismatches, 0, 'horizontal-reflection active collections');
  assert.ok(maxReflectionCurveDifference <= 5e-12, `horizontal-reflection curve difference ${maxReflectionCurveDifference}`);
  assert.ok(maxReflectionSlopeDifference <= 5e-10, `horizontal-reflection slope difference ${maxReflectionSlopeDifference}`);
  assert.ok(maxReflectionSlackDifference <= 5e-12, `horizontal-reflection slack difference ${maxReflectionSlackDifference}`);
  assert.ok(maxReflectionFactorDifference <= 5e-12, `horizontal-reflection factor difference ${maxReflectionFactorDifference}`);
  assert.strictEqual(relaxedConstructions, 493, 'random constructions with chord-side relaxation');
  assert.ok(maxAnalyticalSideFactor <= 5 / 3 + 1e-12, `analytical chord-side factor ${maxAnalyticalSideFactor}`);
  near(maxAnalyticalSideFactor, 5 / 3, 1e-12, 'analytical chord-side factor reaches upper bound');
  assert.ok(maxImplementationSideFactor <= 5 / 3 + 1e-12, `rounding-safe chord-side factor ${maxImplementationSideFactor}`);
  console.log(JSON.stringify({ cases, relaxedChordSideConstructions: relaxedConstructions,
    relaxedChordSideBounds: relaxed, maxAnalyticalSideFactor, maxImplementationSideFactor, maxActiveSetRounds: maxRounds,
    qpSolves, fallbackCalls, maxKktResidual, maxRawKktResidual, maxPrimalViolation,
    reflectionActiveMismatches, maxReflectionCurveDifference, maxReflectionSlopeDifference,
    maxReflectionSlackDifference, maxReflectionFactorDifference }));
}

console.log('CD-HBEP tests passed');
