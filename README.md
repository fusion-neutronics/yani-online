# yani-online

[YANI](https://github.com/fusion-neutronics/yani) in the browser. Build a
material, build an irradiation and cooling schedule, run a real transmutation,
and read back inventory, activity, decay heat and decay photon lines.

The solver is the same Rust that ships in the `yani` wheel, compiled to
WebAssembly. Cross sections are continuous-energy -- nothing is collapsed to a
multigroup approximation to make it fit -- so a browser run and a `pip install
yani` run give the same answer.

## Building

The solver is committed under `vendor/`, matching core, which commits its own
wasm to `python/yamc/_wasm` rather than building it in CI. So a build here needs
nothing but Node, and the Pages workflow needs no secrets.

Refreshing it after a change to core:

```bash
# in core
cd crates/yani-wasm && wasm-pack build --target web --out-dir pkg

# here
cp ../core/crates/yani-wasm/pkg/yani_wasm{.js,_bg.wasm} vendor/
git -C ../core rev-parse HEAD > vendor/CORE_COMMIT
node build.mjs
```

`vendor/CORE_COMMIT` records which core commit produced the solver. The page is
one opaque file, so without it there is no way to tell afterwards which solver a
given build carries, and a stale copy would look no different from a fresh one.

`dist/index.html` is the result: **one self-contained file**, currently 3.93 MB,
with the solver, the plotting library and the page inlined. It opens from
`file://` with no server and no network -- nuclear data is the only thing it
fetches, and only when a calculation asks for it.

| | |
| --- | ---: |
| wasm (base64) | 3.41 MB |
| plotly-basic (gzip + base64) | 0.45 MB |
| page and application code | 0.06 MB |

`plotly-basic` rather than the full bundle: every chart here is scatter or bar,
which the basic distribution covers at a quarter of the size. It is gzipped
before base64 and inflated with `DecompressionStream`, which is 0.45 MB against
1.87 MB for full Plotly inlined raw.

The wasm is not run through `wasm-opt` in this environment (binaryen cannot be
downloaded through the proxy), so 2.56 MB is an upper bound.

## Development

`src/index.html` is servable as-is -- it falls back to fetching the wasm, the
glue and Plotly from `vendor/` when the build placeholders are unsubstituted, so
the page can be iterated on without a build step.

## Nuclear data

Fetched from `yamc-data.xsplot.com` on demand. Which nuclides are needed is
knowable before any of them are fetched, so the page reports the download budget
up front rather than showing an open-ended spinner.

The five data subsections are chosen independently, because each library
publishes only some of what a calculation needs. ENDF/B-VIII.1 is the default
throughout: it is the one library with a complete self-consistent network.
TENDL covers far more parent nuclides for the reactions subsection and is
usually the better choice there, but it publishes no decay data, so defaulting
to it would silently require a second library.

## Status

Working: the page builds, boots in Chromium from `file://` with no console
errors, and the PNNL compendium (410 materials) is available before a byte is
fetched.

Not yet done:

- the solve runs on the main thread and should be in a Web Worker
- no end-to-end run has been verified in a browser
- the single-file session export is not implemented
- no GitHub Pages workflow
