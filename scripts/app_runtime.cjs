const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

const DEFAULT_VALUES = {
  thesisSub: 16,
  thesisRho: 1,
  thesisForce: 'linear',
  spBaseBandFraction: 0.0075,
  spFlatRangeFraction: 0.05,
  spIsolatedBandMultiplier: 2.5,
  spIsolatedScoreOffset: 0.35,
  spEnvelopeLocalFraction: 0.02,
  spEnvelopeRangeFraction: 0.002,
  spEnvelopeIsolationGain: 1.25,
  spHandleBandMultiplier: 1.5,
  spReverseLocalFraction: 0.08,
  spReverseIsolationGain: 2.0,
  spSideLocalFraction: 0.20,
  spSideRangeFraction: 0.07,
  evalSamples: 900,
  benchCases: 2000,
  benchRandomSeed: 123456,
  benchNMin: 8,
  benchNMax: 20,
  benchMixNMin: 18,
  benchMixNMax: 36,
  benchTimingSeed: 246810,
  benchTimingRepeats: 5,
};

const DEFAULT_CHECKED = {
  thesisGhost: true,
  spOver: true,
  spReverseGuard: true,
  spChordSide: true,
  showSpBounds: false,
};

function loadApp(options = {}) {
  const appPath = path.resolve(options.appPath || path.join(__dirname, '..', 'app', 'index.html'));
  const html = fs.readFileSync(appPath, 'utf8');
  const begin = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  if (begin < 0 || end <= begin) throw new Error(`Inline script not found in ${appPath}`);
  const source = html.slice(begin + '<script>'.length, end);

  const elements = new Map();
  for (const [id, value] of Object.entries({ ...DEFAULT_VALUES, ...(options.values || {}) })) {
    elements.set(id, { id, value: String(value), type: 'number', checked: false });
  }
  for (const [id, checked] of Object.entries({ ...DEFAULT_CHECKED, ...(options.checked || {}) })) {
    elements.set(id, { id, value: checked ? 'on' : '', type: 'checkbox', checked: !!checked });
  }

  const document = {
    getElementById: id => elements.get(id) || null,
    querySelector: () => null,
    addEventListener: () => {},
    createElement: () => ({}),
  };
  const context = { console, document, window: {}, performance, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: appPath });

  function setPoints(points) {
    context.__runtimePoints = points;
    vm.runInContext('state.points = __runtimePoints', context);
    delete context.__runtimePoints;
  }
  function setValue(id, value) {
    const el = elements.get(id) || { id, type: 'number', checked: false };
    el.value = String(value);
    elements.set(id, el);
  }
  function setChecked(id, checked) {
    const el = elements.get(id) || { id, type: 'checkbox', value: '' };
    el.checked = !!checked;
    elements.set(id, el);
  }
  function examples() {
    return vm.runInContext('Object.fromEntries(Object.entries(EXAMPLES))', context);
  }

  return { context, elements, examples: examples(), setPoints, setValue, setChecked, source };
}

module.exports = { loadApp, DEFAULT_VALUES, DEFAULT_CHECKED };
