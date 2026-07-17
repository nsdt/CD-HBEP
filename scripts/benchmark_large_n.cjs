'use strict';

const { performance } = require('perf_hooks');
const { loadApp } = require('./app_runtime.cjs');

const runtime = loadApp();
const c = runtime.context;
const sizesArg = process.argv.find(arg => arg.startsWith('--sizes='));
const repeatsArg = process.argv.find(arg => arg.startsWith('--repeats='));
const sizes = (sizesArg ? sizesArg.slice(8) : '10,100,1000,5000,10000,50000,100000')
  .split(',').map(Number).filter(Number.isFinite);
const repeats = repeatsArg ? Math.max(1, Number(repeatsArg.slice(10)) || 1) : 1;
const compact = !process.argv.includes('--full-info');
const rng = c.seededRandom(246810);

for (const n of sizes) {
  const points = c.randomBenchmarkPoints(rng, n, 'oscillatory', 'nonuniform');
  runtime.setPoints(points);
  const samples = [];
  let result;
  for (let repeat = 0; repeat < repeats; repeat++) {
    const start = performance.now();
    result = c.computeBeamOnlySP(points, { compact });
    samples.push((performance.now() - start) / 1000);
  }
  samples.sort((a, b) => a - b);
  const seconds = samples[Math.floor(samples.length / 2)];
  if (!result || !result.slopes || result.slopes.length !== n) throw new Error(`n=${n}: invalid result`);
  console.log(JSON.stringify({ n, seconds, compact, qpSolves: result.info.solverQpSolves,
    fastSweeps: result.info.solverIterations, fallbackCalls: result.info.solverFallbackCount,
    pangHanPivots: result.info.solverPangHanPivots, maxKktResidual: result.info.solverKkt,
    maxRawKktResidual: result.info.solverRawKkt, maxPrimalViolation: result.info.solverMaxPrimal }));
}
