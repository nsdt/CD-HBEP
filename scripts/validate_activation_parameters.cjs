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
const outputPath = path.resolve(root, outputArg ? outputArg.slice('--output='.length) : 'build/activation_parameter_validation.json');
const runtime = loadApp();
const c = runtime.context;
const definitions = Array.from(c.activationParameterDefinitions(), item => ({ ...item }));
const referenceConfiguration = { ...c.activationReferenceConfiguration() };
const sourceSettings = { ...c.activationValidationSettings() };
const settings = quick ? {
  ...sourceSettings,
  globalCandidates: 24,
  localCandidates: 16,
  calibrationRandomCases: 20,
  holdoutRandomCases: 20,
  calibrationKnownSizes: [30],
  holdoutKnownSizes: [45],
  knownEvaluationSamples: 1001,
} : sourceSettings;
const metricNames = ['E_band', 'M_chord', 'A_chord', 'R_len', 'A_mono', 'A_side'];

runtime.setChecked('spOver', true);
runtime.setChecked('spReverseGuard', true);
runtime.setChecked('spChordSide', true);

function applyConfiguration(configuration) {
  for (const definition of definitions) runtime.setValue(definition.elementId, configuration[definition.key]);
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position), upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

function summarize(values) {
  return {
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    maximum: values.length ? Math.max(...values) : null,
  };
}

function geometricMean(values) {
  return Math.exp(values.reduce((sum, value) => sum + Math.log(Math.max(value, Number.MIN_VALUE)), 0) / Math.max(1, values.length));
}

function makeRandomCases(count, seed, suite) {
  const categories = Array.from(c.randomBenchmarkCategories());
  const spacings = ['uniform', 'nonuniform'];
  const groups = categories.length * spacings.length;
  if (count % groups !== 0) throw new Error(`${suite} random count must be divisible by ${groups}`);
  const perGroup = count / groups, rng = c.seededRandom(seed), cases = [];
  for (const spacing of spacings) {
    for (const category of categories) {
      for (let index = 0; index < perGroup; index++) {
        const nMin = category === 'mix' ? 18 : 8;
        const nMax = category === 'mix' ? 36 : 20;
        const n = nMin + Math.floor(rng() * (nMax - nMin + 1));
        cases.push({
          key: `${suite}/random/${spacing}/${category}/${index}`,
          points: Array.from(c.randomBenchmarkPoints(rng, n, category, spacing), point => ({ ...point })),
        });
      }
    }
  }
  return cases;
}

function makeCalibrationExactCases() {
  const cases = [];
  for (const spacing of ['uniform', 'nonuniform']) {
    for (const definition of c.knownBenchmarkCases()) {
      for (const n of settings.calibrationKnownSizes) {
        const points = Array.from(c.knownBenchmarkPoints(definition.key, n, spacing), point => ({ ...point }));
        cases.push({
          key: `calibration/exact/${spacing}/${definition.key}/N=${n}`,
          points,
          errors: curve => c.knownBenchmarkErrors(definition.key, points, curve, settings.knownEvaluationSamples),
        });
      }
    }
  }
  return cases;
}

function makeHoldoutExactCases() {
  const cases = [];
  for (const spacing of ['uniform', 'nonuniform']) {
    for (const definition of c.activationHoldoutCases()) {
      for (const n of settings.holdoutKnownSizes) {
        const points = Array.from(c.activationHoldoutPoints(definition.key, n, spacing), point => ({ ...point }));
        cases.push({
          key: `holdout/exact/${spacing}/${definition.key}/N=${n}`,
          points,
          errors: curve => c.activationHoldoutErrors(definition.key, points, curve, settings.knownEvaluationSamples),
        });
      }
    }
  }
  return cases;
}

function makeSuite(name, randomCases, exactCases) {
  return { name, randomCases, exactCases };
}

function certificateRecord(points, curve) {
  const audit = c.sc2CertificationAudit(points, curve);
  const info = curve.info;
  return {
    failed: audit.residualActivations !== 0 || audit.maxGuaranteeViolation > settings.certificateTolerance ||
      info.solverKkt > settings.certificateTolerance || info.solverMaxPrimal > settings.certificateTolerance,
    residualActivations: audit.residualActivations,
    guaranteeViolation: audit.maxGuaranteeViolation,
    normalizedKkt: info.solverKkt,
    normalizedPrimal: info.solverMaxPrimal,
    fallbackCalls: info.solverFallbackCount,
  };
}

function buildReference(suite) {
  applyConfiguration(referenceConfiguration);
  const exact = suite.exactCases.map(item => {
    const curve = c.computeBeamOnlySP(item.points);
    return { key: item.key, errors: item.errors(curve) };
  });
  const random = suite.randomCases.map(item => {
    const curve = c.computeBeamOnlySP(item.points);
    return {
      key: item.key,
      metrics: c.metricForEval(item.points, curve, settings.metricSamples),
      beamIntervention: c.activationBeamIntervention(curve),
    };
  });
  const metricP95 = Object.fromEntries(metricNames.map(metric => [metric, quantile(random.map(item => item.metrics[metric]), 0.95)]));
  return {
    exact,
    random,
    aggregates: {
      metricP95,
      beamIntervention: summarize(random.map(item => item.beamIntervention)),
    },
  };
}

function evaluateConfiguration(configuration, suite, reference) {
  applyConfiguration(configuration);
  const accuracyRatios = [], eInfRatios = [], e2Ratios = [];
  const metrics = Object.fromEntries(metricNames.map(metric => [metric, []]));
  const beamInterventions = [], activeFractions = [];
  const certificate = { failures: 0, exceptions: 0, residualActivations: 0, maxGuaranteeViolation: 0,
    maxNormalizedKkt: 0, maxNormalizedPrimal: 0, fallbackCalls: 0 };
  for (let index = 0; index < suite.exactCases.length; index++) {
    const item = suite.exactCases[index];
    try {
      const curve = c.computeBeamOnlySP(item.points), errors = item.errors(curve), base = reference.exact[index].errors;
      const eInfRatio = errors.eInf / Math.max(base.eInf, 1e-15);
      const e2Ratio = errors.e2 / Math.max(base.e2, 1e-15);
      eInfRatios.push(eInfRatio); e2Ratios.push(e2Ratio); accuracyRatios.push(eInfRatio, e2Ratio);
      const record = certificateRecord(item.points, curve);
      certificate.failures += record.failed ? 1 : 0;
      certificate.residualActivations += record.residualActivations;
      certificate.maxGuaranteeViolation = Math.max(certificate.maxGuaranteeViolation, record.guaranteeViolation);
      certificate.maxNormalizedKkt = Math.max(certificate.maxNormalizedKkt, record.normalizedKkt);
      certificate.maxNormalizedPrimal = Math.max(certificate.maxNormalizedPrimal, record.normalizedPrimal);
      certificate.fallbackCalls += record.fallbackCalls;
    } catch (error) {
      certificate.failures++; certificate.exceptions++;
    }
  }
  for (const item of suite.randomCases) {
    try {
      const curve = c.computeBeamOnlySP(item.points), values = c.metricForEval(item.points, curve, settings.metricSamples);
      for (const metric of metricNames) metrics[metric].push(values[metric]);
      beamInterventions.push(c.activationBeamIntervention(curve));
      const intervalCount = Math.max(1, item.points.length - 1);
      const active = new Set([...(curve.info.activeEnvelope || []), ...(curve.info.activeSlopeBox || []), ...(curve.info.activeChordSide || [])]);
      activeFractions.push(active.size / intervalCount);
      const record = certificateRecord(item.points, curve);
      certificate.failures += record.failed ? 1 : 0;
      certificate.residualActivations += record.residualActivations;
      certificate.maxGuaranteeViolation = Math.max(certificate.maxGuaranteeViolation, record.guaranteeViolation);
      certificate.maxNormalizedKkt = Math.max(certificate.maxNormalizedKkt, record.normalizedKkt);
      certificate.maxNormalizedPrimal = Math.max(certificate.maxNormalizedPrimal, record.normalizedPrimal);
      certificate.fallbackCalls += record.fallbackCalls;
    } catch (error) {
      certificate.failures++; certificate.exceptions++;
    }
  }
  const metricP95 = Object.fromEntries(metricNames.map(metric => [metric, quantile(metrics[metric], 0.95)]));
  const shapeTailRatio = Object.fromEntries(metricNames.map(metric => [metric,
    metricP95[metric] / Math.max(reference.aggregates.metricP95[metric], 1e-15)]));
  const result = {
    accuracy: {
      geometricMeanRatio: geometricMean(accuracyRatios),
      p95Ratio: quantile(accuracyRatios, 0.95),
      eInfP95Ratio: quantile(eInfRatios, 0.95),
      e2P95Ratio: quantile(e2Ratios, 0.95),
    },
    shape: {
      p95: metricP95,
      p95Ratio: shapeTailRatio,
      maximumP95Ratio: Math.max(...Object.values(shapeTailRatio)),
    },
    beamIntervention: summarize(beamInterventions),
    activeFraction: summarize(activeFractions),
    certificate,
  };
  result.objectives = [result.accuracy.p95Ratio, result.shape.maximumP95Ratio, result.beamIntervention.p95];
  result.stable = certificate.failures === 0 && certificate.exceptions === 0;
  return result;
}

function dominates(left, right) {
  return left.every((value, index) => value <= right[index]) && left.some((value, index) => value < right[index]);
}

function clearlyDominates(left, right, tolerance) {
  return left.every((value, index) => value <= right[index] * (1 + tolerance)) &&
    left.some((value, index) => value < right[index] * (1 - tolerance));
}

function markPareto(records, key) {
  const stable = records.filter(record => record[key].stable);
  for (const record of records) {
    record[key].pareto = record[key].stable && !stable.some(other => other !== record && dominates(other[key].objectives, record[key].objectives));
  }
}

function candidateConfigurations(count, lower, upper, seed) {
  const points = c.digitallyShiftedSobolPoints(count, definitions.length, seed);
  return points.map((point, index) => ({
    id: index + 1,
    unitPoint: Array.from(point),
    configuration: { ...c.activationConfigurationFromUnitPoint(point, lower, upper) },
  }));
}

function progress(label, completed, total) {
  if (completed === total || completed === 1 || completed % Math.max(1, Math.floor(total / 16)) === 0) {
    process.stdout.write(`${label}: ${completed}/${total}\n`);
  }
}

const calibrationSuite = makeSuite('calibration',
  makeRandomCases(settings.calibrationRandomCases, settings.calibrationRandomSeed, 'calibration'), makeCalibrationExactCases());
const holdoutSuite = makeSuite('holdout',
  makeRandomCases(settings.holdoutRandomCases, settings.holdoutRandomSeed, 'holdout'), makeHoldoutExactCases());
const calibrationReference = buildReference(calibrationSuite);
const holdoutReference = buildReference(holdoutSuite);

const globalCandidates = candidateConfigurations(settings.globalCandidates, settings.globalLowerMultiplier,
  settings.globalUpperMultiplier, settings.sobolSeed);
for (let index = 0; index < globalCandidates.length; index++) {
  globalCandidates[index].calibration = evaluateConfiguration(globalCandidates[index].configuration, calibrationSuite, calibrationReference);
  progress('global calibration', index + 1, globalCandidates.length);
}
for (let index = 0; index < globalCandidates.length; index++) {
  globalCandidates[index].holdout = evaluateConfiguration(globalCandidates[index].configuration, holdoutSuite, holdoutReference);
  progress('global hold-out', index + 1, globalCandidates.length);
}

const referenceRecord = {
  id: 0,
  configuration: referenceConfiguration,
  calibration: evaluateConfiguration(referenceConfiguration, calibrationSuite, calibrationReference),
  holdout: evaluateConfiguration(referenceConfiguration, holdoutSuite, holdoutReference),
};
const allGlobal = [referenceRecord, ...globalCandidates];
markPareto(allGlobal, 'calibration');
markPareto(allGlobal, 'holdout');
const tolerance = settings.dominanceRelativeTolerance;
for (const record of globalCandidates) {
  record.dominatesReference = {
    calibration: dominates(record.calibration.objectives, referenceRecord.calibration.objectives),
    holdout: dominates(record.holdout.objectives, referenceRecord.holdout.objectives),
    both: dominates(record.calibration.objectives, referenceRecord.calibration.objectives) &&
      dominates(record.holdout.objectives, referenceRecord.holdout.objectives),
    clearlyBoth: clearlyDominates(record.calibration.objectives, referenceRecord.calibration.objectives, tolerance) &&
      clearlyDominates(record.holdout.objectives, referenceRecord.holdout.objectives, tolerance),
  };
}

const localCandidates = candidateConfigurations(settings.localCandidates, settings.localLowerMultiplier,
  settings.localUpperMultiplier, settings.sobolSeed ^ 0x9e3779b9);
for (let index = 0; index < localCandidates.length; index++) {
  localCandidates[index].calibration = evaluateConfiguration(localCandidates[index].configuration, calibrationSuite, calibrationReference);
  progress('local calibration', index + 1, localCandidates.length);
}

const oneAtATime = [];
for (const definition of definitions) {
  for (const multiplier of [0.9, 1.1]) {
    const configuration = { ...referenceConfiguration, [definition.key]: referenceConfiguration[definition.key] * multiplier };
    oneAtATime.push({ parameter: definition.key, multiplier, configuration,
      calibration: evaluateConfiguration(configuration, calibrationSuite, calibrationReference) });
  }
}

function localSummary(records) {
  const stable = records.filter(record => record.calibration.stable);
  const objectiveColumns = [0, 1, 2].map(index => summarize(stable.map(record =>
    record.calibration.objectives[index] / referenceRecord.calibration.objectives[index])));
  return { candidates: records.length, stable: stable.length, objectiveRatios: {
    accuracy: objectiveColumns[0], shapeTail: objectiveColumns[1], beamIntervention: objectiveColumns[2],
  }};
}

const report = {
  schema: 1,
  source: {
    app: 'app/index.html',
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'app', 'index.html'))).digest('hex'),
  },
  settings: { ...settings, quick, dimensions: definitions.length,
    calibrationExactCases: calibrationSuite.exactCases.length, holdoutExactCases: holdoutSuite.exactCases.length,
    shapeMetrics: metricNames,
    objectives: ['95th percentile ratio of paired exact-function errors', 'largest 95th-percentile shape-metric ratio',
      '95th percentile dimensionless beam intervention'],
  },
  definitions,
  reference: referenceRecord,
  globalCandidates,
  local: { summary: localSummary(localCandidates), candidates: localCandidates, oneAtATime },
  conclusions: {
    referenceParetoCalibration: referenceRecord.calibration.pareto,
    referenceParetoHoldout: referenceRecord.holdout.pareto,
    stableGlobalCandidates: globalCandidates.filter(record => record.calibration.stable && record.holdout.stable).length,
    strictDominatorsCalibration: globalCandidates.filter(record => record.dominatesReference.calibration).length,
    strictDominatorsHoldout: globalCandidates.filter(record => record.dominatesReference.holdout).length,
    strictDominatorsBoth: globalCandidates.filter(record => record.dominatesReference.both).length,
    clearDominatorsBoth: globalCandidates.filter(record => record.dominatesReference.clearlyBoth).length,
  },
};

applyConfiguration(referenceConfiguration);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: outputPath, settings: report.settings, conclusions: report.conclusions,
  local: report.local.summary }, null, 2));
