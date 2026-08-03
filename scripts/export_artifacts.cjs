const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { loadApp } = require('./app_runtime.cjs');

const args = new Set(process.argv.slice(2));
const quick = args.has('--quick');
const outputArg = process.argv.find(arg => arg.startsWith('--output='));
const outputPath = path.resolve(outputArg ? outputArg.slice('--output='.length) : path.join(__dirname, '..', 'build', 'artifacts.json'));

const runtime = loadApp();
const c = runtime.context;
const appPath = path.resolve(__dirname, '..', 'app', 'index.html');
const manuscriptSettings = c.manuscriptBenchmarkSettings();

const METHOD_LABELS = {
  cubic: 'NC-spline', makima: 'Makima', pchip: 'PCHIP', hyman: 'HF-spline',
  dehCubic: 'DEH-CM', hanGuo: 'HG-MDO', beamSP: 'CD-HBEP',
};
const METHODS = Array.from(c.manuscriptMethodOrder(), key => ({ key, label: METHOD_LABELS[key] }));

const CASES = [
  { key: 'smooth', label: 'Surge', file: 'case_smooth.pdf' },
  { key: 'mono', label: 'Peak', file: 'case_hyman_rpn.pdf' },
  { key: 'osc', label: 'Hump', file: 'case_oscillatory.pdf' },
  { key: 'turn', label: 'Arc', file: 'case_turn.pdf' },
  { key: 'wiggle', label: 'Oscillatory', file: 'case_wiggle.pdf' },
  { key: 'plateau', label: 'Turn', file: 'case_plateau.pdf' },
  { key: 'akima1970', label: 'Wiggle', file: 'case_akima_data.pdf' },
  { key: 'dehTitanium', label: 'Plateau', file: 'case_titanium_eos.pdf' },
];

const METRICS = ['E_band', 'M_chord', 'A_chord', 'R_len', 'A_mono', 'A_side'];
const knownSizes = quick ? [10, 30, 60] : manuscriptSettings.knownSizes;
const knownEvaluationSamples = quick ? 4001 : manuscriptSettings.knownEvaluationSamples;

function finiteObject(object, label) {
  for (const [key, value] of Object.entries(object)) {
    if (!Number.isFinite(value)) throw new Error(`${label}: ${key} is not finite`);
  }
  return object;
}

function computeCurve(methodKey, points) {
  runtime.setPoints(points);
  const curve = c.computeMethod(methodKey, points);
  if (!curve) throw new Error(`Method ${methodKey} did not return a curve`);
  return curve;
}

function newSolverDiagnostics() {
  return { constructions: 0, qpSolves: 0, equilibrationRetries: 0, fallbackCalls: 0, pangHanPivots: 0,
    maxKktResidual: 0, maxRawKktResidual: 0, maxPrimalViolation: 0, maxRawPrimalViolation: 0,
    qpSolvesPerConstruction: [], fastSweepsPerQp: [] };
}

function recordSolverDiagnostics(target, curve) {
  const info = curve && curve.info;
  if (!info || !Array.isArray(info.solverFastSweepCounts)) throw new Error('CD-HBEP solver diagnostics are unavailable');
  target.constructions++;
  target.qpSolves += info.solverQpSolves;
  target.equilibrationRetries += info.solverEquilibrationRetryCount || 0;
  target.fallbackCalls += info.solverFallbackCount;
  target.pangHanPivots += info.solverPangHanPivots;
  target.maxKktResidual = Math.max(target.maxKktResidual, info.solverKkt);
  target.maxRawKktResidual = Math.max(target.maxRawKktResidual, info.solverRawKkt);
  target.maxPrimalViolation = Math.max(target.maxPrimalViolation, info.solverMaxPrimal);
  target.maxRawPrimalViolation = Math.max(target.maxRawPrimalViolation, info.solverRawPrimal || 0);
  target.qpSolvesPerConstruction.push(info.solverQpSolves);
  target.fastSweepsPerQp.push(...Array.from(info.solverFastSweepCounts));
}

function sampledCurve(curve, points, count = 601) {
  const xs = c.makeGrid(points, count);
  const ys = xs.map(x => curve.eval(x));
  if (ys.some(value => !Number.isFinite(value))) throw new Error('Nonfinite sampled curve');
  return { x: Array.from(xs), y: Array.from(ys) };
}

const exampleResults = [];
const metricSums = Object.fromEntries(METHODS.map(method => [method.key, Object.fromEntries(METRICS.map(metric => [metric, 0]))]));
for (const item of CASES) {
  const points = c.parseData(runtime.examples[item.key]);
  const methods = {};
  for (const method of METHODS) {
    const curve = computeCurve(method.key, points);
    const metrics = finiteObject(c.metricForEval(points, curve, 900), `${item.label}/${method.label}`);
    for (const metric of METRICS) metricSums[method.key][metric] += metrics[metric];
    methods[method.key] = {
      label: method.label,
      curve: sampledCurve(curve, points),
      metrics,
      slopes: curve.slopes ? Array.from(curve.slopes) : null,
      active: method.key === 'beamSP' ? {
        envelope: Array.from(curve.info.activeEnvelope),
        monotonicity: Array.from(curve.info.activeSlopeBox),
        chordSide: Array.from(curve.info.activeChordSide),
        chordSideSlack: Array.from(curve.info.chordSideSlack || []),
      } : null,
    };
  }
  exampleResults.push({ ...item, points: points.map(point => ({ ...point })), methods });
}

const metricAverages = {};
for (const method of METHODS) {
  metricAverages[method.key] = Object.fromEntries(METRICS.map(metric => [metric, metricSums[method.key][metric] / CASES.length]));
}

const knownCases = Array.from(c.knownBenchmarkCases(), item => ({
  key: item.key,
  label: item.label,
  regularity: item.regularity,
  domain: Array.from(item.domain),
  formula: item.formula,
}));
for (const knownCase of knownCases) {
  const [a, b] = knownCase.domain;
  const referenceX = Array.from({ length: 601 }, (_, index) => a + (b - a) * index / 600);
  knownCase.referenceCurve = {
    x: referenceX,
    y: referenceX.map(x => c.knownBenchmarkValue(knownCase.key, x)),
  };
}
const knownValues = {};
for (const spacing of ['uniform', 'nonuniform']) {
  knownValues[spacing] = {};
  for (const knownCase of knownCases) {
    const byMethod = Object.fromEntries(METHODS.map(method => [method.key, { eInf: [], e2: [], hMax: [] }]));
    for (const n of knownSizes) {
      const points = Array.from(c.knownBenchmarkPoints(knownCase.key, n, spacing), point => ({ x: point.x, y: point.y }));
      for (const method of METHODS) {
        const curve = computeCurve(method.key, points);
        const errors = finiteObject(
          c.knownBenchmarkErrors(knownCase.key, points, curve, knownEvaluationSamples),
          `${spacing}/${knownCase.label}/${method.label}/N=${n}`,
        );
        byMethod[method.key].eInf.push(errors.eInf);
        byMethod[method.key].e2.push(errors.e2);
        byMethod[method.key].hMax.push(errors.hMax);
      }
    }
    knownValues[spacing][knownCase.key] = byMethod;
  }
}

const randomCases = quick ? 80 : manuscriptSettings.randomCases;
const randomCategories = c.randomBenchmarkCategories();
const randomSpacings = ['uniform', 'nonuniform'];
const randomGroupCount = randomCategories.length * randomSpacings.length;
const perGroup = Math.floor(randomCases / randomGroupCount);
const rng = c.seededRandom(manuscriptSettings.randomSeed);
const distributions = Object.fromEntries(METHODS.map(method => [method.key, Object.fromEntries(METRICS.map(metric => [metric, []]))]));
const ablationLabels = ['beam only', '+ envelope', '+ envelope + reverse', 'full CD-HBEP'];
const ablation = Object.fromEntries(ablationLabels.map(label => [label, Object.fromEntries(METRICS.map(metric => [metric, []]))]));
const randomSolverRaw = newSolverDiagnostics();
const randomSideRelaxation = {
  constructions: 0,
  relaxedConstructions: 0,
  relaxedIntervals: 0,
  maximumAnalyticalFactor: 1,
  maximumImplementationFactor: 1,
};
const randomReflectionRaw = newStabilityGroup('x-reflection-random',
  'horizontal reflection (seeded random benchmark)', 'affine invariance');

function pushMetrics(target, metrics) {
  for (const metric of METRICS) target[metric].push(metrics[metric]);
}

function scWithGuards(points, envelope, reverse, side) {
  runtime.setChecked('spOver', envelope);
  runtime.setChecked('spReverseGuard', reverse);
  runtime.setChecked('spChordSide', side);
  return computeCurve('beamSP', points);
}

function guardActiveCollections(curve) {
  return {
    envelope: Array.from(curve.info.activeEnvelope || []),
    reverse: Array.from(curve.info.activeSlopeBox || []),
    side: Array.from(curve.info.activeChordSide || []),
  };
}

function guardComparison(caseDefinition) {
  const points = Array.from(caseDefinition.points, point => ({ x: point.x, y: point.y }));
  const enabled = scWithGuards(points, true, true, true);
  const switches = {
    envelope: [false, true, true],
    reverse: [true, false, true],
    side: [true, true, false],
  }[caseDefinition.guard];
  if (!switches) throw new Error(`Unknown guard comparison: ${caseDefinition.guard}`);
  const disabled = scWithGuards(points, ...switches);
  const enabledActive = guardActiveCollections(enabled);
  if (!enabledActive[caseDefinition.guard].includes(caseDefinition.focusInterval)) {
    throw new Error(`${caseDefinition.key}: focus interval is not active for ${caseDefinition.guard}`);
  }
  const otherGuards = ['envelope', 'reverse', 'side'].filter(key => key !== caseDefinition.guard);
  const targetOnly = otherGuards.every(key => !enabledActive[key].includes(caseDefinition.focusInterval));
  const enabledCurve = sampledCurve(enabled, points, 1001);
  const disabledCurve = sampledCurve(disabled, points, 1001);
  const yValues = points.map(point => point.y);
  const yRange = Math.max(...yValues) - Math.min(...yValues) || 1;
  let maximumCurveDifference = 0;
  let xAtMaximum = enabledCurve.x[0];
  for (let index = 0; index < enabledCurve.x.length; index++) {
    const difference = Math.abs(enabledCurve.y[index] - disabledCurve.y[index]) / yRange;
    if (difference > maximumCurveDifference) {
      maximumCurveDifference = difference;
      xAtMaximum = enabledCurve.x[index];
    }
  }
  const metricKey = { envelope: 'E_band', reverse: 'A_mono', side: 'A_side' }[caseDefinition.guard];
  const enabledMetrics = finiteObject(c.metricForEval(points, enabled, 700), `${caseDefinition.key}/enabled`);
  const disabledMetrics = finiteObject(c.metricForEval(points, disabled, 700), `${caseDefinition.key}/disabled`);
  const interval = caseDefinition.focusInterval;
  const disabledFocusAudit = c.sc2GuardTriggerAudit(points, disabled, interval);
  const disabledTargetOnly = disabledFocusAudit[caseDefinition.guard].triggered
    && otherGuards.every(otherGuard => !disabledFocusAudit[otherGuard].triggered);
  const start = Math.max(0, interval - 1);
  const finish = Math.min(points.length - 1, interval + 2);
  return {
    ...Object.fromEntries(Object.entries(caseDefinition).filter(([key]) => key !== 'points')),
    points,
    targetOnly,
    focus: { xMin: points[start].x, xMax: points[finish].x },
    maximumCurveDifference,
    xAtMaximum,
    disabledFocusAudit,
    disabledTargetOnly,
    metric: {
      key: metricKey,
      enabled: enabledMetrics[metricKey],
      disabled: disabledMetrics[metricKey],
    },
    enabled: { curve: enabledCurve, active: enabledActive },
    disabled: { curve: disabledCurve, active: guardActiveCollections(disabled) },
  };
}

const guardMotivation = Array.from(c.guardMotivationCases(), guardComparison);
for (const guard of ['envelope', 'reverse', 'side']) {
  if (!guardMotivation.some(item => item.guard === guard && item.targetOnly && item.disabledTargetOnly)) {
    throw new Error('No fixed nonredundancy witness remains for the ' + guard + ' guard');
  }
}
runtime.setChecked('spOver', true);
runtime.setChecked('spReverseGuard', true);
runtime.setChecked('spChordSide', true);

for (const spacing of randomSpacings) {
  for (const category of randomCategories) {
    for (let index = 0; index < perGroup; index++) {
      const nMin = category === 'mix' ? manuscriptSettings.randomMixNMin : manuscriptSettings.randomNMin;
      const nMax = category === 'mix' ? manuscriptSettings.randomMixNMax : manuscriptSettings.randomNMax;
      const n = nMin + Math.floor(rng() * (nMax - nMin + 1));
      const points = c.randomBenchmarkPoints(rng, n, category, spacing);
      runtime.setPoints(points);
      let beamCurve = null;
      for (const method of METHODS) {
        const curve = computeCurve(method.key, points);
        if (method.key === 'beamSP') {
          beamCurve = curve;
          recordSolverDiagnostics(randomSolverRaw, curve);
          const analyticalFactor = curve.info.bounds.sideRelaxationAnalyticalFactor ?? 1;
          const implementationFactor = curve.info.bounds.sideRelaxationFactor ?? analyticalFactor;
          const relaxedIntervals = curve.info.chordSideSlack.filter(item => item.relaxed).length;
          randomSideRelaxation.constructions++;
          randomSideRelaxation.relaxedConstructions += Number(analyticalFactor > 1 + 1e-12);
          randomSideRelaxation.relaxedIntervals += relaxedIntervals;
          randomSideRelaxation.maximumAnalyticalFactor = Math.max(randomSideRelaxation.maximumAnalyticalFactor, analyticalFactor);
          randomSideRelaxation.maximumImplementationFactor = Math.max(randomSideRelaxation.maximumImplementationFactor, implementationFactor);
        }
        const metrics = finiteObject(c.metricForEval(points, curve, 500), `${spacing}/${category}/${method.label}`);
        pushMetrics(distributions[method.key], metrics);
      }

      const reflection = { ax: -1, bx: 0, cy: 1, by: 0 };
      const reflectedPoints = transformPoints(points, reflection);
      const reflectedCurve = c.computeBeamOnlySP(reflectedPoints);
      recordStability([randomReflectionRaw], reflectedCurve, c.sc2CertificationAudit(reflectedPoints, reflectedCurve),
        affineComparison({ points, curve: beamCurve }, reflectedCurve, reflectedPoints, reflection),
        { seed: manuscriptSettings.randomSeed, spacing, category, index });

      pushMetrics(ablation['beam only'], c.metricForEval(points, c.makeNaturalCubic(points), 500));
      pushMetrics(ablation['+ envelope'], c.metricForEval(points, scWithGuards(points, true, false, false), 500));
      pushMetrics(ablation['+ envelope + reverse'], c.metricForEval(points, scWithGuards(points, true, true, false), 500));
      pushMetrics(ablation['full CD-HBEP'], c.metricForEval(points, scWithGuards(points, true, true, true), 500));
    }
  }
}
runtime.setChecked('spOver', true);
runtime.setChecked('spReverseGuard', true);
runtime.setChecked('spChordSide', true);

const galleryRng = c.seededRandom(manuscriptSettings.gallerySeed);
const gallery = [];
for (const category of randomCategories) {
  const row = { category, uniform: [], nonuniform: [] };
  for (const spacing of ['uniform', 'nonuniform']) {
    for (let index = 0; index < 3; index++) {
      const n = category === 'mix' ? 22 + Math.floor(galleryRng() * 7) : 12 + Math.floor(galleryRng() * 5);
      const galleryProfiles = spacing === 'uniform' ? [0, 4, 8] : [3, 10, 11];
      const options = category === 'mix' ? { mixProfileIndex: galleryProfiles[index] } : null;
      row[spacing].push(c.randomBenchmarkPoints(galleryRng, n, category, spacing, options).map(point => ({ ...point })));
    }
  }
  gallery.push(row);
}

function quantile(values, q) {
  const sorted = values.slice().sort((a, b) => a - b);
  const position = q * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}
const median = values => quantile(values, 0.5);

function summarizeSolverDiagnostics(raw) {
  const summary = values => ({ median: median(values), p95: quantile(values, 0.95), maximum: Math.max(...values) });
  return {
    constructions: raw.constructions,
    qpSolves: raw.qpSolves,
    equilibrationRetries: raw.equilibrationRetries,
    fallbackCalls: raw.fallbackCalls,
    pangHanPivots: raw.pangHanPivots,
    maxKktResidual: raw.maxKktResidual,
    maxRawKktResidual: raw.maxRawKktResidual,
    maxPrimalViolation: raw.maxPrimalViolation,
    maxRawPrimalViolation: raw.maxRawPrimalViolation,
    qpSolvesPerConstruction: summary(raw.qpSolvesPerConstruction),
    fastSweepsPerQp: summary(raw.fastSweepsPerQp),
  };
}

const timingSizes = quick ? [10, 100, 1000] : manuscriptSettings.timingSizes;
const timingRepeats = quick ? 1 : manuscriptSettings.timingRepeats;
const timingMethods = METHODS;
const timing = Object.fromEntries(timingMethods.map(method => [method.key, []]));
const timingQ1 = Object.fromEntries(timingMethods.map(method => [method.key, []]));
const timingQ3 = Object.fromEntries(timingMethods.map(method => [method.key, []]));
const timingSolverRaw = newSolverDiagnostics();
const timingRng = c.seededRandom(manuscriptSettings.timingSeed);
for (const n of timingSizes) {
  const dataSets = Array.from(c.timingBenchmarkDataSets(timingRng, n));
  for (const method of timingMethods) {
    const dataMedians = [];
    for (const dataSet of dataSets) {
      const points = dataSet.points;
      c.computeMethod(method.key, points);
      const samples = [];
      for (let repeat = 0; repeat < timingRepeats; repeat++) {
        const start = performance.now();
        const curve = c.computeMethod(method.key, points);
        samples.push((performance.now() - start) / 1000);
        if (method.key === 'beamSP') recordSolverDiagnostics(timingSolverRaw, curve);
      }
      dataMedians.push(median(samples));
    }
    timing[method.key].push(median(dataMedians));
    timingQ1[method.key].push(quantile(dataMedians, 0.25));
    timingQ3[method.key].push(quantile(dataMedians, 0.75));
  }
}

function linearRegressionSlope(xs, ys) {
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < xs.length; index++) {
    numerator += (xs[index] - meanX) * (ys[index] - meanY);
    denominator += (xs[index] - meanX) ** 2;
  }
  if (!(denominator > 0)) throw new Error('Timing regression requires at least two distinct problem sizes.');
  return numerator / denominator;
}

let timingRegressionIndices = timingSizes.map((size, index) => ({ size, index })).filter(item => item.size >= 5000);
if (timingRegressionIndices.length < 2) {
  timingRegressionIndices = timingSizes.map((size, index) => ({ size, index })).slice(-Math.min(3, timingSizes.length));
}
const timingRegressionX = timingRegressionIndices.map(item => Math.log10(item.size));
const timingRegression = {
  minimumN: timingRegressionIndices[0].size,
  pointCount: timingRegressionIndices.length,
  slopes: Object.fromEntries(timingMethods.map(method => [
    method.key,
    linearRegressionSlope(timingRegressionX, timingRegressionIndices.map(item => Math.log10(Math.max(timing[method.key][item.index], 1e-15)))),
  ])),
};

function numericalSummary(values) {
  if (!values.length) return { median: null, p95: null, maximum: null };
  return { median: median(values), p95: quantile(values, 0.95), maximum: Math.max(...values) };
}

function newStabilityGroup(key, label, family, parameter = '') {
  return { key, label, family, parameter, trials: 0, failures: 0, equilibrationRetries: 0, fallbackCalls: 0,
    activeSetChanges: 0, residualActivationFailures: 0, guaranteeFailures: 0,
    curveDifferences: [], slopeDifferences: [], slackDifferences: [], kktResiduals: [], rawKktResiduals: [],
    primalResiduals: [], rawPrimalResiduals: [], guaranteeViolations: [], records: [] };
}

function uniqueGroups(groups) { return [...new Set(groups)]; }

function activeSignature(info, intervalCount = null, reflected = false) {
  const sorted = values => Array.from(values || [], interval => reflected ? intervalCount - 1 - interval : interval)
    .sort((a, b) => a - b).join(',');
  return `${sorted(info.activeEnvelope)}|${sorted(info.activeSlopeBox)}|${sorted(info.activeChordSide)}`;
}

function pointRange(points, coordinate) {
  const values = points.map(point => point[coordinate]);
  return Math.max(...values) - Math.min(...values);
}

function affineComparison(base, transformedCurve, transformedPoints, transform) {
  const { points, curve } = base;
  const reflected = transform.ax < 0, intervalCount = points.length - 1;
  const xRange = points[points.length - 1].x - points[0].x;
  const yRange = pointRange(points, 'y');
  let curveDifference = 0;
  for (let index = 0; index <= 120; index++) {
    const x = points[0].x + xRange * index / 120;
    const expected = transform.cy * curve.eval(x) + transform.by;
    const actual = transformedCurve.eval(transform.ax * x + transform.bx);
    const denominator = yRange > 0 ? Math.abs(transform.cy) * yRange : Math.max(1, Math.abs(expected));
    curveDifference = Math.max(curveDifference, Math.abs(actual - expected) / denominator);
  }
  let slopeDifference = 0;
  for (let index = 0; index < curve.slopes.length; index++) {
    const expected = transform.cy * curve.slopes[index] / transform.ax;
    const transformedIndex = reflected ? curve.slopes.length - 1 - index : index;
    const denominator = yRange > 0 ? Math.abs(transform.cy) * yRange / (Math.abs(transform.ax) * xRange) : 1;
    slopeDifference = Math.max(slopeDifference, Math.abs(transformedCurve.slopes[transformedIndex] - expected) / denominator);
  }
  const normalizedSlack = (info, mapReflection = false) => {
    const scale = info.normalization.yScale;
    return new Map((info.chordSideSlack || []).map(item => [mapReflection ? intervalCount - 1 - item.e : item.e,
      [item.nominal / scale, item.effective / scale]]));
  };
  const baseSlack = normalizedSlack(curve.info), transformedSlack = normalizedSlack(transformedCurve.info, reflected);
  const activeChanged = activeSignature(curve.info) !== activeSignature(transformedCurve.info, intervalCount, reflected);
  let slackDifference = activeChanged ? null : 0;
  const intervals = new Set([...baseSlack.keys(), ...transformedSlack.keys()]);
  if (!activeChanged) for (const interval of intervals) {
    const left = baseSlack.get(interval), right = transformedSlack.get(interval);
    slackDifference = Math.max(slackDifference, Math.abs(left[0] - right[0]), Math.abs(left[1] - right[1]));
  }
  return { curveDifference, slopeDifference, slackDifference,
    activeChanged };
}

function recordStability(groups, curve, audit, comparison = null, extra = {}) {
  for (const group of uniqueGroups(groups)) {
    group.trials++;
    group.equilibrationRetries += curve.info.solverEquilibrationRetryCount || 0;
    group.fallbackCalls += curve.info.solverFallbackCount;
    if (comparison && comparison.activeChanged) group.activeSetChanges++;
    if (audit.residualActivations) group.residualActivationFailures++;
    if (audit.maxGuaranteeViolation > 1e-9) group.guaranteeFailures++;
    if (comparison) {
      group.curveDifferences.push(comparison.curveDifference);
      group.slopeDifferences.push(comparison.slopeDifference);
      if (Number.isFinite(comparison.slackDifference)) group.slackDifferences.push(comparison.slackDifference);
    }
    group.kktResiduals.push(curve.info.solverKkt);
    group.rawKktResiduals.push(curve.info.solverRawKkt || 0);
    group.primalResiduals.push(curve.info.solverMaxPrimal);
    group.rawPrimalResiduals.push(curve.info.solverRawPrimal || 0);
    group.guaranteeViolations.push(audit.maxGuaranteeViolation);
    group.records.push({ kktResidual: curve.info.solverKkt, rawKktResidual: curve.info.solverRawKkt || 0,
      primalResidual: curve.info.solverMaxPrimal,
      rawPrimalResidual: curve.info.solverRawPrimal || 0,
      equilibrationRetries: curve.info.solverEquilibrationRetryCount || 0,
      fallbackCalls: curve.info.solverFallbackCount, residualActivations: audit.residualActivations,
      guaranteeViolation: audit.maxGuaranteeViolation,
      activeChanged: comparison ? comparison.activeChanged : null,
      curveDifference: comparison ? comparison.curveDifference : null,
      slopeDifference: comparison ? comparison.slopeDifference : null,
      slackDifference: comparison ? comparison.slackDifference : null, ...extra });
  }
}

function recordStabilityFailure(groups, error, extra = {}) {
  for (const group of uniqueGroups(groups)) {
    group.trials++;
    group.failures++;
    group.records.push({ failure: String(error && error.message ? error.message : error), ...extra });
  }
}

function finishStabilityGroup(group) {
  const successful = group.trials - group.failures;
  return { key: group.key, label: group.label, family: group.family, parameter: group.parameter,
    trials: group.trials, successful, failures: group.failures,
    equilibrationRetries: group.equilibrationRetries, fallbackCalls: group.fallbackCalls,
    activeSetChanges: group.activeSetChanges,
    activeSetChangeRate: successful > 0 && group.curveDifferences.length ? group.activeSetChanges / successful : null,
    residualActivationFailures: group.residualActivationFailures, guaranteeFailures: group.guaranteeFailures,
    curveDifference: numericalSummary(group.curveDifferences), slopeDifference: numericalSummary(group.slopeDifferences),
    slackDifference: numericalSummary(group.slackDifferences), kktResidual: numericalSummary(group.kktResiduals),
    rawKktResidual: numericalSummary(group.rawKktResiduals),
    primalResidual: numericalSummary(group.primalResiduals), rawPrimalResidual: numericalSummary(group.rawPrimalResiduals),
    guaranteeViolation: numericalSummary(group.guaranteeViolations),
    records: group.records };
}

function makeStabilityCases(count, seed) {
  const rng = c.seededRandom(seed), categories = ['oscillatory', 'turn', 'wiggle', 'plateau'];
  const cases = [];
  for (let index = 0; index < count; index++) {
    const n = manuscriptSettings.randomNMin + Math.floor(rng() * (manuscriptSettings.randomNMax - manuscriptSettings.randomNMin + 1));
    const points = c.randomBenchmarkPoints(rng, n, categories[index % categories.length], index % 2 ? 'nonuniform' : 'uniform');
    const curve = c.computeBeamOnlySP(points);
    cases.push({ points, curve });
  }
  return { cases, rng };
}

function transformPoints(points, transform) {
  return points.map(point => ({ x: transform.ax * point.x + transform.bx, y: transform.cy * point.y + transform.by }))
    .sort((left, right) => left.x - right.x);
}

function runAffineConfiguration(baseCases, groups, transformForCase, parameter) {
  for (let index = 0; index < baseCases.length; index++) {
    const base = baseCases[index], transform = transformForCase(base, index);
    try {
      const points = transformPoints(base.points, transform);
      const curve = c.computeBeamOnlySP(points);
      const audit = c.sc2CertificationAudit(points, curve);
      recordStability(groups, curve, audit, affineComparison(base, curve, points, transform), { parameter, transform });
    } catch (error) { recordStabilityFailure(groups, error, { parameter, transform }); }
  }
}

function extremeKnotPoints(points, ratio, rng) {
  const intervals = points.length - 1;
  const weights = Array.from({ length: intervals }, (_, index) => Math.exp(Math.log(ratio) * index / Math.max(1, intervals - 1)));
  for (let index = weights.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1));
    [weights[index], weights[other]] = [weights[other], weights[index]];
  }
  const total = weights.reduce((sum, value) => sum + value, 0), xs = [0];
  for (const weight of weights) xs.push(xs[xs.length - 1] + weight / total);
  xs[xs.length - 1] = 1;
  return points.map((point, index) => ({ x: xs[index], y: point.y }));
}

function qpDiagonalRatio(points) {
  const affine = c.sc2AffineNormalizeInput(points);
  const diagonal = c.assembleBeamSlopeTri(affine.points).T.diag;
  return Math.max(...diagonal) / Math.min(...diagonal);
}

const stabilityQuick = quick;
const affineTrials = stabilityQuick ? 12 : manuscriptSettings.affineTrialsPerConfiguration;
const conditioningTrials = stabilityQuick ? 20 : manuscriptSettings.conditioningTrialsPerRatio;
const thresholdCandidates = stabilityQuick ? 80 : manuscriptSettings.thresholdCandidateCases;
const thresholdSelected = stabilityQuick ? 12 : manuscriptSettings.thresholdSelectedCases;
const affineScales = stabilityQuick ? [1e-8, 1, 1e8] : manuscriptSettings.affineScales;
const originShifts = stabilityQuick ? [-1e8, 1e8] : manuscriptSettings.originShiftFactors;
const meshRatios = manuscriptSettings.meshRatios;
const thresholdPerturbations = stabilityQuick ? [1e-10, 1e-6] : manuscriptSettings.thresholdPerturbations;
const stabilityBase = makeStabilityCases(affineTrials, manuscriptSettings.stabilitySeed);
const stabilityDetailedGroups = [], stabilitySummaryGroups = [];
const addSummary = (key, label, family) => {
  const group = newStabilityGroup(key, label, family);
  stabilitySummaryGroups.push(group);
  return group;
};
const addDetail = (key, label, family, parameter) => {
  const group = newStabilityGroup(key, label, family, parameter);
  stabilityDetailedGroups.push(group);
  return group;
};
const xScaleSummary = addSummary('x-scale', 'horizontal unit scaling', 'affine invariance');
for (const scale of affineScales) {
  const detail = addDetail(`x-scale-${scale}`, `horizontal scale ${scale}`, 'affine invariance', String(scale));
  runAffineConfiguration(stabilityBase.cases, [detail, xScaleSummary], () => ({ ax: scale, bx: 0, cy: 1, by: 0 }), scale);
}
const yScaleSummary = addSummary('y-scale', 'vertical unit scaling', 'affine invariance');
for (const scale of affineScales) {
  const detail = addDetail(`y-scale-${scale}`, `vertical scale ${scale}`, 'affine invariance', String(scale));
  runAffineConfiguration(stabilityBase.cases, [detail, yScaleSummary], () => ({ ax: 1, bx: 0, cy: scale, by: 0 }), scale);
}
const xShiftSummary = addSummary('x-shift', 'horizontal-origin translation', 'affine invariance');
for (const factor of originShifts) {
  const detail = addDetail(`x-shift-${factor}`, `horizontal shift ${factor}`, 'affine invariance', String(factor));
  runAffineConfiguration(stabilityBase.cases, [detail, xShiftSummary], base => ({ ax: 1,
    bx: factor * (base.points[base.points.length - 1].x - base.points[0].x), cy: 1, by: 0 }), factor);
}
const yShiftSummary = addSummary('y-shift', 'vertical-origin translation', 'affine invariance');
for (const factor of originShifts) {
  const detail = addDetail(`y-shift-${factor}`, `vertical shift ${factor}`, 'affine invariance', String(factor));
  runAffineConfiguration(stabilityBase.cases, [detail, yShiftSummary], base => ({ ax: 1, bx: 0, cy: 1,
    by: factor * pointRange(base.points, 'y') }), factor);
}
const reflectionSummary = addSummary('y-reflection', 'vertical reflection', 'affine invariance');
const reflectionDetail = addDetail('y-reflection-minus-one', 'vertical reflection', 'affine invariance', '-1');
runAffineConfiguration(stabilityBase.cases, [reflectionDetail, reflectionSummary], () => ({ ax: 1, bx: 0, cy: -1, by: 0 }), -1);

const combinedSummary = addSummary('combined-affine', 'combined affine transformation', 'affine invariance');
const combinedDetail = addDetail('combined-affine-random', 'combined affine transformations', 'affine invariance', 'seeded mixture');
const combinedRng = stabilityBase.rng;
runAffineConfiguration(stabilityBase.cases, [combinedDetail, combinedSummary], base => {
  const ax = affineScales[Math.floor(combinedRng() * affineScales.length)];
  const yMagnitude = affineScales[Math.floor(combinedRng() * affineScales.length)];
  const cy = (combinedRng() < 0.5 ? -1 : 1) * yMagnitude;
  const xRange = base.points[base.points.length - 1].x - base.points[0].x, yRange = pointRange(base.points, 'y');
  return { ax, bx: (combinedRng() < 0.5 ? -1 : 1) * 1e4 * ax * xRange,
    cy, by: (combinedRng() < 0.5 ? -1 : 1) * 1e4 * Math.abs(cy) * yRange };
}, 'seeded mixture');

const constantSummary = addSummary('constant-data', 'constant-ordinate affine case', 'affine invariance');
const constantDetail = addDetail('constant-data', 'constant-ordinate affine case', 'affine invariance', 'constant');
for (let index = 0; index < affineTrials; index++) {
  const source = stabilityBase.cases[index], level = 2 * combinedRng() - 1;
  const points = source.points.map(point => ({ x: point.x, y: level }));
  const base = { points, curve: c.computeBeamOnlySP(points) };
  const ax = affineScales[index % affineScales.length], cy = index % 2 ? -1e8 : 1e-8;
  const transform = { ax, bx: 0, cy, by: 1e4 };
  try {
    const transformedPoints = transformPoints(points, transform), curve = c.computeBeamOnlySP(transformedPoints);
    recordStability([constantDetail, constantSummary], curve, c.sc2CertificationAudit(transformedPoints, curve),
      affineComparison(base, curve, transformedPoints, transform), { transform });
  } catch (error) { recordStabilityFailure([constantDetail, constantSummary], error, { transform }); }
}

const conditionRng = c.seededRandom(manuscriptSettings.stabilitySeed ^ 0x9e3779b9);
for (const ratio of meshRatios) {
  const summary = addSummary(`mesh-${ratio}`, `mesh ratio ${ratio}`, 'nonuniform conditioning');
  const detail = addDetail(`mesh-${ratio}`, `mesh ratio ${ratio}`, 'nonuniform conditioning', String(ratio));
  for (let index = 0; index < conditioningTrials; index++) {
    const n = manuscriptSettings.randomNMin + Math.floor(conditionRng() * (manuscriptSettings.randomNMax - manuscriptSettings.randomNMin + 1));
    const source = c.randomBenchmarkPoints(conditionRng, n, ['oscillatory', 'turn', 'wiggle', 'plateau'][index % 4], 'uniform');
    const points = extremeKnotPoints(source, ratio, conditionRng);
    const diagonalRatio = qpDiagonalRatio(points);
    try {
      const curve = c.computeBeamOnlySP(points), audit = c.sc2CertificationAudit(points, curve);
      recordStability([detail, summary], curve, audit, null, { ratio, diagonalRatio });
    } catch (error) { recordStabilityFailure([detail, summary], error, { ratio, diagonalRatio }); }
  }
}

function thresholdBoundary(base) {
  const margin = c.sc2ClosestActivationMargin(base.points, base.curve.info.thetaBeam);
  if (!margin) return null;
  const ordinate = Math.min(base.points.length - 1, margin.e + 1), yRange = pointRange(base.points, 'y');
  if (!(yRange > 0)) return null;
  const baseSignature = activeSignature(base.curve.info);
  for (const magnitude of [1e-4, 1e-3, 1e-2, 5e-2, 2e-1]) {
    for (const direction of [-1, 1]) {
      const endpoint = direction * magnitude;
      const endpointPoints = base.points.map(point => ({ ...point }));
      endpointPoints[ordinate].y += endpoint * yRange;
      let endpointCurve;
      try { endpointCurve = c.computeBeamOnlySP(endpointPoints); } catch (_) { continue; }
      if (activeSignature(endpointCurve.info) === baseSignature) continue;
      let same = 0, different = endpoint;
      for (let iteration = 0; iteration < 48; iteration++) {
        const middle = 0.5 * (same + different), middlePoints = base.points.map(point => ({ ...point }));
        middlePoints[ordinate].y += middle * yRange;
        let middleCurve;
        try { middleCurve = c.computeBeamOnlySP(middlePoints); } catch (_) { return null; }
        if (activeSignature(middleCurve.info) === baseSignature) same = middle;
        else different = middle;
      }
      const boundaryAmplitude = 0.5 * (same + different), points = base.points.map(point => ({ ...point }));
      points[ordinate].y += boundaryAmplitude * yRange;
      return { points, ordinate, yRange,
        boundaryAmplitude: Math.abs(boundaryAmplitude), initialGuard: margin.type, initialInterval: margin.e };
    }
  }
  return null;
}
const thresholdPool = [];
for (const base of makeStabilityCases(thresholdCandidates, manuscriptSettings.stabilitySeed ^ 0x85ebca6b).cases) {
  if (thresholdPool.length >= thresholdSelected) break;
  const boundary = thresholdBoundary(base);
  if (boundary) thresholdPool.push(boundary);
}
const thresholdSummary = addSummary('threshold-perturbation', 'near-threshold ordinate perturbation', 'activation sensitivity');
for (const amplitude of thresholdPerturbations) {
  const detail = addDetail(`threshold-${amplitude}`, `threshold perturbation ${amplitude}`, 'activation sensitivity', String(amplitude));
  for (const base of thresholdPool) {
    const leftPoints = base.points.map(point => ({ ...point })), rightPoints = base.points.map(point => ({ ...point }));
    leftPoints[base.ordinate].y -= amplitude * base.yRange;
    rightPoints[base.ordinate].y += amplitude * base.yRange;
    let leftCurve = null, rightCurve = null, leftError = null, rightError = null;
    try { leftCurve = c.computeBeamOnlySP(leftPoints); } catch (error) { leftError = error; }
    try { rightCurve = c.computeBeamOnlySP(rightPoints); } catch (error) { rightError = error; }
    if (leftCurve && rightCurve) {
      const comparison = affineComparison({ points: leftPoints, curve: leftCurve }, rightCurve, rightPoints,
        { ax: 1, bx: 0, cy: 1, by: 0 });
      const extra = { amplitude, boundaryAmplitude: base.boundaryAmplitude,
        guard: base.initialGuard, interval: base.initialInterval };
      recordStability([detail, thresholdSummary], leftCurve, c.sc2CertificationAudit(leftPoints, leftCurve), comparison, { ...extra, side: -1 });
      recordStability([detail, thresholdSummary], rightCurve, c.sc2CertificationAudit(rightPoints, rightCurve), comparison, { ...extra, side: 1 });
    } else {
      const extra = { amplitude, boundaryAmplitude: base.boundaryAmplitude,
        guard: base.initialGuard, interval: base.initialInterval };
      if (leftCurve) recordStability([detail, thresholdSummary], leftCurve,
        c.sc2CertificationAudit(leftPoints, leftCurve), null, { ...extra, side: -1 });
      else recordStabilityFailure([detail, thresholdSummary], leftError, { ...extra, side: -1 });
      if (rightCurve) recordStability([detail, thresholdSummary], rightCurve,
        c.sc2CertificationAudit(rightPoints, rightCurve), null, { ...extra, side: 1 });
      else recordStabilityFailure([detail, thresholdSummary], rightError, { ...extra, side: 1 });
    }
  }
}
const stabilityValidation = {
  settings: { seed: manuscriptSettings.stabilitySeed, affineTrialsPerConfiguration: affineTrials,
    conditioningTrialsPerRatio: conditioningTrials, thresholdCandidateCases: thresholdCandidates,
    thresholdSelectedCases: thresholdPool.length, affineScales, originShiftFactors: originShifts,
    meshRatios, thresholdPerturbations },
  thresholdSelection: numericalSummary(thresholdPool.map(item => item.boundaryAmplitude)),
  summary: [finishStabilityGroup(randomReflectionRaw), ...stabilitySummaryGroups.map(finishStabilityGroup)],
  detailedLog: stabilityDetailedGroups.map(finishStabilityGroup),
};

runtime.setPoints(c.parseData(runtime.examples.smooth));
const defaultOptions = c.spOptions();
randomSideRelaxation.analyticalUpperBound = defaultOptions.sideLocalFraction > 0
  ? Math.max(1, 1 / (4 * defaultOptions.sideLocalFraction)) : Infinity;
const cpuInfo = os.cpus();
const timingEnvironment = {
  runtime: 'Node.js VM execution of app/index.html',
  node: process.version,
  v8: process.versions.v8,
  platform: process.platform,
  architecture: process.arch,
  operatingSystem: os.version(),
  operatingSystemRelease: os.release(),
  cpu: cpuInfo.length ? cpuInfo[0].model : 'unknown',
  logicalProcessors: cpuInfo.length,
  totalMemoryGiB: os.totalmem() / (2 ** 30),
};
const artifact = {
  schema: 1,
  source: {
    app: 'app/index.html',
    sha256: crypto.createHash('sha256').update(fs.readFileSync(appPath)).digest('hex'),
  },
  settings: {
    randomSeed: manuscriptSettings.randomSeed,
    randomCases: perGroup * randomGroupCount,
    randomCategories,
    randomCasesPerClassSpacing: perGroup,
    randomNMin: manuscriptSettings.randomNMin,
    randomNMax: manuscriptSettings.randomNMax,
    randomMixNMin: manuscriptSettings.randomMixNMin,
    randomMixNMax: manuscriptSettings.randomMixNMax,
    gallerySeed: manuscriptSettings.gallerySeed,
    timingSeed: manuscriptSettings.timingSeed,
    metrics: METRICS,
    knownSizes,
    knownEvaluationSamples,
    metricQuadrature: manuscriptSettings.metricQuadrature,
    knownErrorQuadrature: manuscriptSettings.knownErrorQuadrature,
    stabilitySeed: manuscriptSettings.stabilitySeed,
    defaultOptions,
  },
  methods: METHODS,
  knownAccuracy: { cases: knownCases, sizes: knownSizes, evaluationSamples: knownEvaluationSamples, values: knownValues },
  cases: exampleResults,
  metricAverages,
  randomBenchmark: { distributions, sideRelaxation: randomSideRelaxation },
  ablation,
  guardMotivation,
  gallery,
  timing: {
    sizes: timingSizes,
    repeats: timingRepeats,
    continuousCases: 6,
    discreteCases: 8,
    values: timing,
    q1: timingQ1,
    q3: timingQ3,
    logLogRegression: timingRegression,
    environment: timingEnvironment,
  },
  solverDiagnostics: {
    randomBenchmark: summarizeSolverDiagnostics(randomSolverRaw),
    timingBenchmark: summarizeSolverDiagnostics(timingSolverRaw),
  },
  stabilityValidation,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(artifact)}\n`, 'utf8');
console.log(JSON.stringify({ output: outputPath, cases: artifact.settings.randomCases, appSha256: artifact.source.sha256 }));
