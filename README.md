# Certification-Driven Hermite Beam-Energy Projection

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21405491.svg)](https://doi.org/10.5281/zenodo.21405491)

Certification-Driven Hermite Beam-Energy Projection (CD-HBEP) is a value-only method for shape-controlled cubic Hermite interpolation. It begins with the natural-cubic beam-energy minimizer and activates finite local slope bounds only when exact interval tests detect a specified geometric departure.

**[Open the browser app](https://nsdt.github.io/CD-HBEP/)**

The app is a self-contained HTML file. It requires no build step, server, package installation, or network connection after download.

## Features

- Interactive comparison with natural cubic spline, Akima and modified Akima interpolation, Piecewise Cubic Hermite Interpolating Polynomial (PCHIP), Hyman-filtered spline, the final Dougherty--Edelman--Hyman cubic algorithm, Han--Guo minimal derivative oscillation interpolation, and the historical rod finite-element model.
- Built-in exact-function and discrete-data examples.
- Exact interval certification for the Bezier envelope, reverse motion, and chord-side departure.
- A residual-certified tridiagonal box quadratic-programming solver with a polynomial fallback.
- Deterministic random benchmarks, timing experiments, affine-invariance checks, and parameter-validation utilities.
- All twelve fixed empirical activation constants are visible and editable for inspection. The published reference configuration applies the same values to every data set and requires no case-specific or user tuning.

## Run the app

Clone or download the repository and open [`app/index.html`](app/index.html) in a current Chrome, Edge, or Firefox browser.

```powershell
git clone https://github.com/nsdt/CD-HBEP.git
cd CD-HBEP
Start-Process .\app\index.html
```

The online version is deployed from the same `app/` directory by GitHub Actions.

## Test and reproduce the numerical results

Node.js 18 or newer is sufficient for the regression suite and numerical exporters. No npm packages are required.

```powershell
node tests/run_tests.cjs
node scripts/export_artifacts.cjs --quick
node scripts/validate_activation_parameters.cjs --quick
```

The complete deterministic export omits `--quick`:

```powershell
node scripts/export_artifacts.cjs
node scripts/validate_activation_parameters.cjs
```

The complete runs are substantially more expensive. Generated JSON is written under `build/`, which is intentionally excluded from version control. Seeds, benchmark definitions, method defaults, and numerical conventions originate in `app/index.html`.

Additional utilities examine large-\(N\) timing, reflection consistency, and the consolidation of activation constants:

```powershell
node scripts/benchmark_large_n.cjs
node scripts/compare_chord_side_symmetry.cjs
node scripts/analyze_parameter_consolidation.cjs
```

## Repository layout

- `app/`: executable source of truth and detailed user manual.
- `tests/`: deterministic numerical and regression tests.
- `scripts/`: dependency-free Node.js exporters and validation utilities.
- `.github/workflows/`: continuous tests and GitHub Pages deployment.

The manuscript source, supplied reference PDFs, provenance archives, and journal-submission files are maintained outside this public software repository.

## Citation

Citation metadata are provided in [`CITATION.cff`](CITATION.cff). Release `v0.1.0`, which accompanies the submitted manuscript, is archived on Zenodo under the version-specific DOI [10.5281/zenodo.21405492](https://doi.org/10.5281/zenodo.21405492). Cite this version-specific DOI when reproducing the reported results. The badge at the top of this page refers to the concept DOI, which represents all archived releases.

The accompanying article is titled *A Certification-Driven Beam-Energy Projection Algorithm for Shape-Controlled Cubic Hermite Interpolation*. Its journal citation will be added after publication.

## License

The software is released under the [MIT License](LICENSE).
