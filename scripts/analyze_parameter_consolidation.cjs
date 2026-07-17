#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadApp } = require('./app_runtime.cjs');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const outputArg = args.find(arg => arg.startsWith('--output='));
const outputPath = path.resolve(root, outputArg ? outputArg.slice('--output='.length) : 'build/parameter_consolidation.json');
const runtime = loadApp();
const c = runtime.context;
const settings = c.manuscriptBenchmarkSettings();
const originalSpOptions = c.spOptions;
let currentOverrides = {};
c.spOptions = points => Object.assign(originalSpOptions(points), currentOverrides);

const parameterNames = [
  'baseBandFraction', 'flatRangeFraction', 'isolatedBandMultiplier', 'isolatedScoreOffset',
  'envelopeLocalFraction', 'envelopeRangeFraction', 'envelopeIsolationGain', 'handleBandMultiplier',
  'reverseLocalFraction', 'reverseIsolationGain', 'sideLocalFraction', 'sideRangeFraction',
];

const variants = [
  { key: 'handle-multiplier-removed', label: 'remove handle-band multiplier', overrides: { handleBandMultiplier: 1 } },
  { key: 'shared-iso-1.25', label: 'share isolation gains at 1.25', overrides: { envelopeIsolationGain: 1.25, reverseIsolationGain: 1.25 } },
  { key: 'shared-iso-1.5', label: 'share isolation gains at 1.5', overrides: { envelopeIsolationGain: 1.5, reverseIsolationGain: 1.5 } },
  { key: 'shared-iso-2', label: 'share isolation gains at 2', overrides: { envelopeIsolationGain: 2, reverseIsolationGain: 2 } },
  { key: 'envelope-iso-removed', label: 'remove envelope isolation gain', overrides: { envelopeIsolationGain: 0 } },
  { key: 'reverse-iso-removed', label: 'remove reverse isolation gain', overrides: { reverseIsolationGain: 0 } },
  { key: 'iso-multipliers-removed', label: 'remove both isolation gains', overrides: { envelopeIsolationGain: 0, reverseIsolationGain: 0 } },
  { key: 'iso-offset-removed', label: 'remove isolated-score offset', overrides: { isolatedScoreOffset: 0 } },
  { key: 'iso-widening-removed', label: 'remove isolated-band widening', overrides: { isolatedBandMultiplier: 0 } },
  { key: 'envelope-range-removed', label: 'remove envelope range fraction', overrides: { envelopeRangeFraction: 0 } },
  { key: 'envelope-range-shared-floor', label: 'derive envelope range fraction from local and flat fractions', overrides: { envelopeRangeFraction: 0.001 } },
  { key: 'envelope-local-removed', label: 'remove envelope local fraction', overrides: { envelopeLocalFraction: 0 } },
  { key: 'base-floor-removed', label: 'remove flat-interval range fraction', overrides: { flatRangeFraction: 0 } },
  { key: 'chord-range-removed', label: 'remove side range fraction', overrides: { sideRangeFraction: 0 } },
  { key: 'chord-range-shared-floor', label: 'derive side range fraction from local and flat fractions', overrides: { sideRangeFraction: 0.01 } },
  { key: 'chord-local-removed', label: 'remove side local fraction', overrides: { sideLocalFraction: 0 } },
  { key: 'shared-local-0.02', label: 'share envelope and reverse local fractions at 0.02', overrides: { reverseLocalFraction: 0.02 } },
  { key: 'shared-local-0.08', label: 'share envelope and reverse local fractions at 0.08', overrides: { envelopeLocalFraction: 0.08 } },
  { key: 'combined-minimal', label: 'remove handle multiplier and share isolation gains at 1.25',
    overrides: { handleBandMultiplier: 1, envelopeIsolationGain: 1.25, reverseIsolationGain: 1.25 } },
];

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

function summary(values) {
  return { median: quantile(values, 0.5), p95: quantile(values, 0.95), maximum: values.length ? Math.max(...values) : null };
}

function activeSignature(info) {
  const sorted = values => Array.from(values || []).sort((left, right) => left - right).join(',');
  return `${sorted(info.activeEnvelope)}|${sorted(info.activeSlopeBox)}|${sorted(info.activeChordSide)}`;
}

function curveSample(points, curve, count = 121) {
  const xs = c.makeGrid(points, count);
  return { x: Array.from(xs), y: Array.from(xs, x => curve.eval(x)) };
}

function curveDifference(points, baseline, candidate) {
  const yValues = points.map(point => point.y);
  const yRange = Math.max(...yValues) - Math.min(...yValues) || 1;
  let maximum = 0;
  for (let index = 0; index < baseline.x.length; index++) {
    maximum = Math.max(maximum, Math.abs(baseline.y[index] - candidate.eval(baseline.x[index])) / yRange);
  }
  return maximum;
}

function slopeDifference(points, baseline, candidate) {
  const xRange = points.at(-1).x - points[0].x;
  const yValues = points.map(point => point.y);
  const scale = (Math.max(...yValues) - Math.min(...yValues)) / xRange || 1;
  let maximum = 0;
  for (let index = 0; index < baseline.length; index++) {
    maximum = Math.max(maximum, Math.abs(baseline[index] - candidate[index]) / scale);
  }
  return maximum;
}

function allRandomCases() {
  const categories = c.randomBenchmarkCategories();
  const spacings = ['uniform', 'nonuniform'];
  const total = quick ? 200 : settings.randomCases;
  const perGroup = Math.floor(total / (categories.length * spacings.length));
  const rng = c.seededRandom(settings.randomSeed);
  const cases = [];
  for (const spacing of spacings) {
    for (const category of categories) {
      for (let index = 0; index < perGroup; index++) {
        const nMin = category === 'mix' ? settings.randomMixNMin : settings.randomNMin;
        const nMax = category === 'mix' ? settings.randomMixNMax : settings.randomNMax;
        const n = nMin + Math.floor(rng() * (nMax - nMin + 1));
        cases.push({
          key: `${spacing}/${category}/${index}`,
          family: 'random',
          points: Array.from(c.randomBenchmarkPoints(rng, n, category, spacing), point => ({ ...point })),
        });
      }
    }
  }
  return cases;
}

function knownCases() {
  const cases = [];
  const sizes = quick ? [10, 30, 100] : settings.knownSizes;
  for (const spacing of ['uniform', 'nonuniform']) {
    for (const definition of c.knownBenchmarkCases()) {
      for (const n of sizes) {
        cases.push({
          key: `${spacing}/${definition.key}/N=${n}`,
          family: 'known',
          knownKey: definition.key,
          points: Array.from(c.knownBenchmarkPoints(definition.key, n, spacing), point => ({ ...point })),
        });
      }
    }
  }
  return cases;
}

function representativeCases() {
  const cases = Object.entries(runtime.examples).map(([key, text]) => ({
    key: `example/${key}`,
    family: 'representative',
    points: c.parseData(text),
  }));
  for (const item of c.guardMotivationCases()) {
    cases.push({ key: `motivation/${item.key}`, family: 'representative', points: Array.from(item.points, point => ({ ...point })) });
  }
  cases.push({
    key: 'regression/modified-arc',
    family: 'representative',
    points: c.parseData(`0, 2
0.048943, 1.690983
0.190983, 1.412215
0.412215, 1.190983
0.690983, 1.048943
1, 2
1.309017, 1.048943
1.587785, 1.190983
1.809017, 1.412215
1.951057, 1.690983
2, 2`),
  });
  return cases;
}

runtime.setChecked('spOver', true);
runtime.setChecked('spReverseGuard', true);
runtime.setChecked('spChordSide', true);
const cases = [...allRandomCases(), ...knownCases(), ...representativeCases()];
currentOverrides = {};
const baseline = [];
for (const item of cases) {
  const curve = c.computeBeamOnlySP(item.points);
  baseline.push({
    curve: curveSample(item.points, curve),
    slopes: Array.from(curve.slopes),
    signature: activeSignature(curve.info),
    activeCounts: [curve.info.activeEnvelope.length, curve.info.activeSlopeBox.length, curve.info.activeChordSide.length],
    metrics: c.metricForEval(item.points, curve, 300),
    errors: item.family === 'known'
      ? c.knownBenchmarkErrors(item.knownKey, item.points, curve, settings.knownEvaluationSamples)
      : null,
  });
}

function guardContrast(item) {
  runtime.setChecked('spOver', true);
  runtime.setChecked('spReverseGuard', true);
  runtime.setChecked('spChordSide', true);
  const enabled = c.computeBeamOnlySP(item.points);
  const activeKey = { envelope: 'activeEnvelope', reverse: 'activeSlopeBox', side: 'activeChordSide' }[item.guard];
  const otherKeys = {
    envelope: ['activeSlopeBox', 'activeChordSide'],
    reverse: ['activeEnvelope', 'activeChordSide'],
    side: ['activeEnvelope', 'activeSlopeBox'],
  }[item.guard];
  const targetOnly = enabled.info[activeKey].includes(item.focusInterval) &&
    otherKeys.every(key => !enabled.info[key].includes(item.focusInterval));
  runtime.setChecked({ envelope: 'spOver', reverse: 'spReverseGuard', side: 'spChordSide' }[item.guard], false);
  const disabled = c.computeBeamOnlySP(item.points);
  const enabledSample = curveSample(item.points, enabled, 601);
  return { targetOnly, contrast: curveDifference(item.points, enabledSample, disabled) };
}

currentOverrides = {};
const motivationCases = Array.from(c.guardMotivationCases());
const baselineContrasts = Object.fromEntries(motivationCases.map(item => [item.key, guardContrast(item)]));

function evaluateVariant(variant) {
  currentOverrides = variant.overrides;
  runtime.setChecked('spOver', true);
  runtime.setChecked('spReverseGuard', true);
  runtime.setChecked('spChordSide', true);
  const curveDifferences = [];
  const slopeDifferences = [];
  const metricChanges = Object.fromEntries(['E_band', 'M_chord', 'A_chord', 'R_len', 'A_mono', 'A_side'].map(key => [key, []]));
  const activeTotals = [0, 0, 0];
  let activeSetChanges = 0;
  let failures = 0;
  let certificateFailures = 0;
  let maximumCase = null;
  const knownRatios = [];
  let knownWorseMeaningfully = 0;
  let knownBetterMeaningfully = 0;
  let maximumKnownRatio = { ratio: 0, key: null };
  let maximumKnownIncrease = { increase: -Infinity, key: null, baseline: null, candidate: null };
  const familyChanges = { random: [], known: [], representative: [] };
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index];
    try {
      const curve = c.computeBeamOnlySP(item.points);
      const audit = c.sc2CertificationAudit(item.points, curve);
      if (audit.residualActivations || audit.maxGuaranteeViolation > 1e-9) certificateFailures++;
      const candidateSample = curveSample(item.points, curve);
      const difference = curveDifference(item.points, baseline[index].curve, curve);
      const slope = slopeDifference(item.points, baseline[index].slopes, curve.slopes);
      curveDifferences.push(difference);
      slopeDifferences.push(slope);
      familyChanges[item.family].push(difference);
      if (!maximumCase || difference > maximumCase.difference) {
        maximumCase = {
          key: item.key,
          difference,
          points: item.points,
          baseline: baseline[index].curve,
          candidate: candidateSample,
          baselineActiveSignature: baseline[index].signature,
          candidateActiveSignature: activeSignature(curve.info),
        };
      }
      if (activeSignature(curve.info) !== baseline[index].signature) activeSetChanges++;
      activeTotals[0] += curve.info.activeEnvelope.length;
      activeTotals[1] += curve.info.activeSlopeBox.length;
      activeTotals[2] += curve.info.activeChordSide.length;
      const metrics = c.metricForEval(item.points, curve, 300);
      for (const key of Object.keys(metricChanges)) metricChanges[key].push(metrics[key] - baseline[index].metrics[key]);
      if (item.family === 'known') {
        const errors = c.knownBenchmarkErrors(item.knownKey, item.points, curve, settings.knownEvaluationSamples);
        const baseError = baseline[index].errors.eInf;
        const increase = errors.eInf - baseError;
        if (increase > maximumKnownIncrease.increase) {
          maximumKnownIncrease = { increase, key: item.key, baseline: baseError, candidate: errors.eInf };
        }
        if (baseError >= 1e-8) {
          const ratio = errors.eInf / baseError;
          knownRatios.push(ratio);
          if (ratio > maximumKnownRatio.ratio) maximumKnownRatio = { ratio, key: item.key };
        }
        const meaningfulTolerance = Math.max(0.1 * baseError, 1e-8);
        if (increase > meaningfulTolerance) knownWorseMeaningfully++;
        if (increase < -meaningfulTolerance) knownBetterMeaningfully++;
      }
    } catch (error) {
      failures++;
    }
  }
  const baselineActiveTotals = baseline.reduce((totals, item) => totals.map((value, index) => value + item.activeCounts[index]), [0, 0, 0]);
  const motivation = motivationCases.map(item => {
    const result = guardContrast(item);
    return {
      key: item.key,
      targetOnly: result.targetOnly,
      contrast: result.contrast,
      ratioToBaseline: result.contrast / baselineContrasts[item.key].contrast,
    };
  });
  runtime.setChecked('spOver', true);
  runtime.setChecked('spReverseGuard', true);
  runtime.setChecked('spChordSide', true);
  return {
    ...variant,
    constructions: cases.length,
    failures,
    certificateFailures,
    activeSetChanges,
    activeSetChangeRate: activeSetChanges / cases.length,
    curveDifference: summary(curveDifferences),
    slopeDifference: summary(slopeDifferences),
    maximumCase,
    familyCurveDifference: Object.fromEntries(Object.entries(familyChanges).map(([key, values]) => [key, summary(values)])),
    activeCountChange: {
      envelope: activeTotals[0] - baselineActiveTotals[0],
      reverse: activeTotals[1] - baselineActiveTotals[1],
      side: activeTotals[2] - baselineActiveTotals[2],
    },
    metricChange: Object.fromEntries(Object.entries(metricChanges).map(([key, values]) => [key, summary(values)])),
    knownAccuracy: {
      configurations: knownRatios.length,
      geometricMeanRatio: Math.exp(knownRatios.reduce((sum, value) => sum + Math.log(value), 0) / knownRatios.length),
      maximumRatio: maximumKnownRatio,
      maximumAbsoluteIncrease: maximumKnownIncrease,
      meaningfullyWorse: knownWorseMeaningfully,
      meaningfullyBetter: knownBetterMeaningfully,
    },
    motivation,
    motivationPreserved: motivation.filter(item => item.targetOnly && item.ratioToBaseline >= 0.5).length,
  };
}

const results = variants.map(evaluateVariant);
currentOverrides = {};
const defaults = originalSpOptions([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
const report = {
  schema: 1,
  source: {
    app: 'app/index.html',
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'app', 'index.html'))).digest('hex'),
  },
  settings: {
    quick,
    randomCases: cases.filter(item => item.family === 'random').length,
    knownConfigurations: cases.filter(item => item.family === 'known').length,
    representativeCases: cases.filter(item => item.family === 'representative').length,
    curveSamples: 121,
    knownEvaluationSamples: settings.knownEvaluationSamples,
  },
  defaults: Object.fromEntries(parameterNames.map(name => [name, defaults[name]])),
  baselineMotivation: baselineContrasts,
  results,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.table(results.map(item => ({
  variant: item.key,
  changed: item.activeSetChanges,
  maxCurve: item.curveDifference.maximum.toExponential(3),
  knownMaxRatio: item.knownAccuracy.maximumRatio.ratio.toFixed(3),
  knownMaxIncrease: item.knownAccuracy.maximumAbsoluteIncrease.increase.toExponential(2),
  motivation: `${item.motivationPreserved}/6`,
  failures: item.failures + item.certificateFailures,
})));
console.log(JSON.stringify({ output: outputPath, ...report.settings }));
