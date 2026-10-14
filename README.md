# Certification-Driven Hermite Beam-Energy Projection

**Current release (v0.2.1):** [![Zenodo DOI for v0.2.1](https://zenodo.org/badge/DOI/10.5281/zenodo.21769604.svg)](https://doi.org/10.5281/zenodo.21769604)

**All archived releases:** [![Zenodo concept DOI for all versions](https://zenodo.org/badge/DOI/10.5281/zenodo.21405491.svg)](https://doi.org/10.5281/zenodo.21405491)

Certification-Driven Hermite Beam-Energy Projection (CD-HBEP) is a value-only method for shape-controlled cubic Hermite interpolation. It begins with the natural-cubic beam-energy minimizer and activates finite local slope bounds only when exact interval tests detect a specified geometric departure.

**[Open the browser app](https://nsdt.github.io/CD-HBEP/)**

The app is a self-contained HTML file. It requires no build step, server, package installation, or network connection after download.

## Features

- Interactive comparison with natural cubic spline, Akima and modified Akima interpolation, Piecewise Cubic Hermite Interpolating Polynomial (PCHIP), Hyman-filtered spline, the final Dougherty--Edelman--Hyman cubic algorithm, Han--Guo minimal derivative oscillation interpolation, and the historical rod finite-element model.
- Built-in exact-function and discrete-data examples.
- Exact interval certification for the Bezier envelope, reverse motion, and chord-side departure.
- A residual-certified tridiagonal box quadratic-programming solver with a polynomial fallback; diagonal equilibration gives the beam Hessian exact condition number 3 on every positive mesh without changing the fallback complexity.
- Deterministic random benchmarks, timing experiments, affine-invariance checks, and parameter-validation utilities.
- All twelve fixed empirical activation constants are visible and editable for inspection. The published reference configuration applies the same values to every data set and requires no case-specific or user tuning.

## Run the app

Clone or download the repository and open [`app/index.html`](app/index.html) in a current Chrome, Edge, or Firefox browser.

```powershell
git clone https://github.com/nsdt/CD-HBEP.git
cd CD-HBEP
Start-Process .\app\index.html
```

The online version is built from `app/` and deployed by GitHub Actions. The deployment adds Cloudflare Web Analytics and a privacy notice to a separate copy of the HTML. The original `app/index.html`, its recorded hash, and the downloadable app are unchanged.

### Online usage analytics

The hosted app uses cookie-free Cloudflare Web Analytics to measure page visits and loading performance. Entered data and interpolation results are not sent to the analytics service. The analytics script loads only on `https://nsdt.github.io/CD-HBEP/`; local files, localhost, and other hosts do not load it. Controls and recalculations within the app are not counted as additional page views.

To configure deployment, register `nsdt.github.io` in Cloudflare Web Analytics and store the public site token from its JavaScript snippet in the GitHub Actions repository variable `CLOUDFLARE_WEB_ANALYTICS_TOKEN`. This is a Web Analytics site token, not an API credential. The Pages workflow runs `node scripts/prepare_pages.cjs` to create `build/pages/` and fails before deployment if the token is missing or malformed. Re-run the workflow after changing the variable. Implementation details and collected metrics are described in the [Cloudflare documentation](https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/).

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

**All archived releases:** [10.5281/zenodo.21405491](https://doi.org/10.5281/zenodo.21405491). This DOI resolves to the latest archived release.

**Preprint (all versions):** [10.5281/zenodo.21833600](https://doi.org/10.5281/zenodo.21833600). This DOI resolves to the latest archived preprint version.

Citation metadata are provided in [`CITATION.cff`](CITATION.cff). For a general citation of CD-HBEP, use the concept DOI for the complete version family.

The version-specific software records are listed below for reference.

| Record | DOI | Citation purpose |
| --- | --- | --- |
| Current release `v0.2.1` | [10.5281/zenodo.21769604](https://doi.org/10.5281/zenodo.21769604) | Reproduce or cite the results reported with the current release. |
| Previous release `v0.2.0` | [10.5281/zenodo.21623497](https://doi.org/10.5281/zenodo.21623497) | Refer specifically to version 0.2.0. |
| Initial release `v0.1.0` | [10.5281/zenodo.21405492](https://doi.org/10.5281/zenodo.21405492) | Refer specifically to version 0.1.0. |

For reproducibility, cite the applicable version-specific software DOI. When referring to the article itself, cite the preprint DOI; its journal citation will be added after publication.

## License

The software is released under the [MIT License](LICENSE).
