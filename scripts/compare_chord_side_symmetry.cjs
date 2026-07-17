const fs = require('fs');
const path = require('path');
const { loadApp } = require('./app_runtime.cjs');

const runtime = loadApp();
const c = runtime.context;

function reflectedPoints(points) {
  return points.slice().reverse().map(point => ({ x: -point.x, y: point.y }));
}

function activeSignature(info, intervalCount, reflect = false) {
  return [info.activeEnvelope, info.activeSlopeBox, info.activeChordSide]
    .map(values => Array.from(values, interval => reflect ? intervalCount - 1 - interval : interval)
      .sort((left, right) => left - right).join(','))
    .join('|');
}

function compare(points, curve, reflected) {
  const intervalCount = points.length - 1;
  const xRange = points[points.length - 1].x - points[0].x;
  const ordinates = points.map(point => point.y);
  const yRange = Math.max(...ordinates) - Math.min(...ordinates);
  const valueScale = Math.max(yRange, Number.MIN_VALUE);
  const slopeScale = Math.max(yRange / xRange, Number.MIN_VALUE);
  let curveDifference = 0;
  for (let interval = 0; interval < intervalCount; interval++) {
    for (let sample = 0; sample <= 32; sample++) {
      const x = points[interval].x + (points[interval + 1].x - points[interval].x) * sample / 32;
      curveDifference = Math.max(curveDifference, Math.abs(curve.eval(x) - reflected.eval(-x)) / valueScale);
    }
  }
  let slopeDifference = 0;
  for (let index = 0; index < points.length; index++) {
    slopeDifference = Math.max(slopeDifference,
      Math.abs(curve.slopes[index] + reflected.slopes[points.length - 1 - index]) / slopeScale);
  }
  const reflectedSlack = new Map(reflected.info.chordSideSlack.map(item => [intervalCount - 1 - item.e, item]));
  let slackDifference = 0;
  for (const item of curve.info.chordSideSlack) {
    const counterpart = reflectedSlack.get(item.e);
    if (!counterpart) { slackDifference = null; break; }
    slackDifference = Math.max(slackDifference,
      Math.abs(item.nominal - counterpart.nominal) / valueScale,
      Math.abs(item.effective - counterpart.effective) / valueScale);
  }
  return {
    activeMismatch: activeSignature(curve.info, intervalCount) !==
      activeSignature(reflected.info, intervalCount, true),
    curveDifference,
    slopeDifference,
    slackDifference,
    factorDifference: Math.abs((curve.info.bounds.sideRelaxationFactor ?? 1) -
      (reflected.info.bounds.sideRelaxationFactor ?? 1)),
  };
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position), upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

function summary(values) {
  return { median: quantile(values, 0.5), p95: quantile(values, 0.95), maximum: quantile(values, 1) };
}

const rng = c.seededRandom(123456);
const records = [];
for (const spacing of ['uniform', 'nonuniform']) {
  for (const category of c.randomBenchmarkCategories()) {
    for (let index = 0; index < 200; index++) {
      const minimum = category === 'mix' ? 18 : 8;
      const maximum = category === 'mix' ? 36 : 20;
      const count = minimum + Math.floor(rng() * (maximum - minimum + 1));
      const points = c.randomBenchmarkPoints(rng, count, category, spacing);
      const curve = c.computeBeamOnlySP(points);
      const reflected = c.computeBeamOnlySP(reflectedPoints(points));
      records.push({ spacing, category, index, count, ...compare(points, curve, reflected) });
    }
  }
}

const output = {
  definition: {
    algorithm: 'Simultaneous common-factor enlargement of all active chord-side slacks.',
    seed: 123456,
    constructions: records.length,
    reflection: 'Replace x by -x, reverse the point sequence, and map interval and slope indices back.',
  },
  summary: {
    activeMismatches: records.filter(record => record.activeMismatch).length,
    curveDifference: summary(records.map(record => record.curveDifference)),
    slopeDifference: summary(records.map(record => record.slopeDifference)),
    slackDifference: summary(records.map(record => record.slackDifference)),
    factorDifference: summary(records.map(record => record.factorDifference)),
  },
  records,
};

const outputDirectory = path.resolve(__dirname, '..', 'build', 'analysis');
fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, 'chord_side_reflection_regression.json');
fs.writeFileSync(outputPath, `${JSON.stringify(output)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, ...output.summary }));
