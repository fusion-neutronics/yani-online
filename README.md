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

`dist/index.html` is the result: **one self-contained file**, currently 3.94 MB,
with the solver, the plotting library and the page inlined. It opens from
`file://` with no server and no network -- nuclear data is the only thing it
fetches, and only when a calculation asks for it.

| | |
| --- | ---: |
| wasm (base64) | 3.41 MB |
| plotly-basic (gzip + base64) | 0.45 MB |
| page and application code | 0.08 MB |

`plotly-basic` rather than the full bundle: every chart here is scatter or bar,
which the basic distribution covers at a quarter of the size. It is gzipped
before base64 and inflated with `DecompressionStream`, which is 0.45 MB against
1.87 MB for full Plotly inlined raw.

The wasm is not run through `wasm-opt` in this environment (binaryen cannot be
downloaded through the proxy), so 2.56 MB is an upper bound.

## Where the solve runs

The solver is in a Worker. A transmutation is one synchronous call into wasm
that returns when it is finished, so on the main thread it froze the page for
its whole duration -- no scrolling, no repaint, no way to tell a long solve from
a hung one. `src/worker.js` owns the wasm session now; the page talks to it over
a small `{ id, method, args }` protocol and awaits the answers.

The worker is **one blob holding one classic script**: the wasm-bindgen glue,
converted from a module at boot, with `worker.js` appended. Both halves of that
are forced, and by different browsers:

- **Classic, not a module**, because Chromium refuses to make a module Worker
  out of a blob URL on an opaque origin -- *"Script at 'blob:null/…' cannot be
  accessed from origin 'null'"*. A classic Worker from the same blob starts.
  (Firefox and WebKit will load either.)
- **One script, not two**, because WebKit refuses to load any second script
  into a worker from a blob -- *"Cross-origin script load denied by Cross-Origin
  Resource Sharing policy"* -- for `importScripts` and dynamic `import()`
  alike. So the glue cannot be fetched by the worker; it has to arrive with it.

That is the same shape `wasm-pack build --target no-modules` produces.
`glueToClassic` in app.js does it at boot instead -- four substitutions on the
generated file, validated to have consumed every `export` -- so this repository
keeps vendoring a single `--target web` package. `import.meta.url` is rewritten
even though the branch using it never runs: it is a syntax error in a classic
script, so a parse would fail before anything executed.

Fetching stays on the main thread: it is waiting, not work, and keeping it there
leaves the fetch loop, the progress bar and the missing-nuclide reporting where
they were. The bytes are *transferred* into the worker rather than copied, so a
few hundred MB of cross sections cross for free.

There is no main-thread fallback. It was written and then removed once all three
engines were measured rather than guessed at: the failure it was meant to catch
does not happen, and the one failure that does happen (below) is not one a
fallback rescues.

### What the engines actually do, from `file://`

| | classic blob worker | second script inside it | this wasm |
| --- | --- | --- | --- |
| Chromium 141 | yes | yes | runs |
| Firefox 153 | yes | yes | runs |
| WebKit 26.5 | yes | **no** | **rejected** |

Chromium and Firefox both run the page end to end, and agree on the answer to
the last digit. WebKit starts the worker and loads the glue, then refuses the
solver itself: *"WebAssembly.Module doesn't parse … relaxed simd instructions
not supported"*. That is core's wasm build flags, not this page -- the build
from before the worker existed fails on the same instruction, on the main
thread, and would need core to stop emitting relaxed SIMD. Safari on macOS has
not been tested; the WebKit here is the Linux build of the same engine, so it is
indicative rather than conclusive.

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
fetched. The solve runs in a Worker and the page keeps painting while it does.

A full run has been verified in Chromium and in Firefox from `file://` against
real ENDF/B-VIII.1 data -- chain load, cross-section fetch, solve and all four
plots, with a Fe56 material and the 1383 unpublished nuclides of its closure
answered as 404s. Both give 4.0786e14 Bq peak activity, identical to the last
digit. `node verify.mjs` is that check; it needs a local copy of the data
(`YANI_FIXTURES`, or core's `fetch_test_fixtures.py`) and skips the run without
one, so CI currently gates on everything up to the first solve.

Not yet done:

- WebKit cannot load the solver: core emits relaxed SIMD, which it does not
  implement. Nothing in this repository can fix that
- the single-file session export is not implemented
- no GitHub Pages workflow
