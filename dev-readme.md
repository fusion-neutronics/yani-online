# Developing yani-online

How the page is built, where the solve runs, and what the browsers actually do.
For what the page is and how to use it, see [README.md](README.md).

## Building

The solver is committed under `vendor/`, matching core, which commits its own
wasm to `python/yamc/_wasm` rather than building it in CI. So a build here needs
nothing but Node, and the Pages workflow needs no secrets.

The vendored copy comes from a core **release**, not from a local build -- see
the download recipe below, which gets the `wasm-opt`-optimised binary this
environment cannot produce. Building it locally is for testing a core change
that has not been released yet:

```bash
# in core
cd crates/yani-wasm && wasm-pack build --target web --out-dir pkg

# here
cp ../core/crates/yani-wasm/pkg/yani_wasm{.js,_bg.wasm} vendor/
git -C ../core rev-parse HEAD > vendor/CORE_COMMIT
node build.mjs
```

Whichever route, `node build.mjs` is what turns `vendor/` and `src/` into
`dist/index.html`.

The solver was mis-reading nuclide names until recently: `Fe56` reached the
formula parser first and came back as Fe with a subscript of 56, which expands
over natural abundance. A single-nuclide material was quietly 8.8% short on its
own nuclide and carried three isotopes nobody asked for. Fixed in core by
fusion-neutronics/core#468; anything vendored before that has it.

`vendor/CORE_COMMIT` records which core commit produced the solver. The page is
one opaque file, so without it there is no way to tell afterwards which solver a
given build carries, and a stale copy would look no different from a fresh one.

`dist/index.html` is the result: **one self-contained file**, currently 3.22 MB,
with the solver, the plotting library and the page inlined. It opens from
`file://` with no server and no network -- nuclear data is the only thing it
fetches, and only when a calculation asks for it.

| | |
| --- | ---: |
| wasm (base64) | 2.67 MB |
| plotly-basic (gzip + base64) | 0.45 MB |
| page and application code | 0.10 MB |

`plotly-basic` rather than the full bundle: every chart here is scatter or bar,
which the basic distribution covers at a quarter of the size. It is gzipped
before base64 and inflated with `DecompressionStream`, which is 0.45 MB against
1.87 MB for full Plotly inlined raw.

The wasm is the `wasm-opt`-optimised build, taken from a core release rather
than built here: binaryen cannot be downloaded through this environment's proxy,
so a local `wasm-pack build` produces 2.52 MB where core's CI produces 2.00 MB.
fusion-neutronics/core#467 attaches that optimised `pkg/` to every release, so
re-vendoring means downloading an asset rather than reproducing a toolchain:

```bash
gh release download yani-core-0.5.0 -R fusion-neutronics/core \
  -p 'yani-wasm-*.tar.gz' -O - | tar xz --strip-components=1 -C vendor \
  pkg/yani_wasm.js pkg/yani_wasm_bg.wasm
```

Then record which commit it came from, since the asset does not carry it:
`git -C ../core rev-list -n 1 yani-core-0.5.0 > vendor/CORE_COMMIT`.

## Iterating without a build

`src/index.html` is servable as-is -- it falls back to fetching the wasm, the
glue and Plotly from `vendor/` when the build placeholders are unsubstituted, so
the page can be iterated on without a build step.

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
engines were measured rather than guessed at: every one of them starts the
worker, so the failure it was meant to catch does not happen.

### What the engines actually do, from `file://`

| | classic blob worker | second script inside it | this wasm |
| --- | --- | --- | --- |
| Chromium 141 | yes | yes | runs |
| Firefox 153 | yes | yes | runs |
| WebKit 26.5 | yes | **no** | runs |

All three run the page end to end and agree on the answer to the last digit
(4.4380e14 Bq peak activity for the Fe56 check).

WebKit only started running it recently. It used to reject the solver outright
-- *"WebAssembly.Module doesn't parse … relaxed simd instructions not
supported"* -- which was core's dependency rather than this page: `pulp` emitted
relaxed SIMD for wasm32 whether or not anything called it, and validation is
module-wide. Fixed in core by fusion-neutronics/core#464 and picked up here by
re-vendoring. Safari on macOS is still untested; the WebKit here is the Linux
build of the same engine, so it is indicative rather than conclusive.

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

Working: the page builds, boots from `file://` with no console errors, and the
PNNL compendium (410 materials) is available before a byte is fetched. The solve
runs in a Worker and the page keeps painting while it does. The neutron spectrum
is plotted from the moment the page loads -- it is an input, and the only one
whose consequences cannot be read off the form. Every chart carries log/linear
toggles for the axes a scale means something for.

Results are activity, decay heat, contact dose rate, the final inventory and the
decay photon lines. The contact dose is the odd one of the three time series: it
is intensive, so unlike activity and decay heat it does not scale with the
volume on the form -- the semi-infinite slab estimate cancels the geometry, and
a bigger lump of the same material reads the same at contact. It opens on the
total rather than a per-nuclide breakdown, with a checkbox for the breakdown,
because the first question a dose answers is whether the thing can be handled
and only the second is what is driving it. Absorbed dose in air at a build-up
factor of 2.0, which is what `Material.contact_dose()` defaults to in the wheel,
so the page and a Python run of the same setup report the same number:
2.711e4 Gy/h against 2.710833e4 for the Fe56 check, Mn56 in both.
Bremsstrahlung from decay electrons is not modelled, so a strong beta emitter
reads low.

The chart hides itself when `vendor/CORE_COMMIT` names a solver that predates
the field, rather than drawing empty axes -- a dose plot with nothing in it
reads as a material that gives no dose, which is a different and more alarming
claim than "this build cannot tell you".

A full run has been verified in Chromium, Firefox and WebKit from `file://`
against real ENDF/B-VIII.1 data -- chain load, cross-section fetch, solve and
all five result plots, with a Fe56 material and the 1383 unpublished nuclides of
its closure answered as 404s. All three give 4.4380e14 Bq peak activity,
identical to the last digit, and the same setup run through the `yani` Python
package agrees with them to 2.1e-10 -- which is how the composition bug above
was found. `node verify.mjs` is that check; it needs a local copy of the data
(`YANI_FIXTURES`, or core's `fetch_test_fixtures.py`) and skips the run without
one, so CI currently gates on everything up to the first solve.

Not yet done:

- the single-file session export is not implemented
