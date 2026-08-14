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

Three details are forced by the page being one file opened from `file://`:

- **The worker source is carried as text** and turned into a blob URL at boot,
  because `new Worker` takes a URL and there is no second file to point it at.
- **It is a classic script, not a module.** On a `file://` origin a blob URL is
  opaque, and a module Worker refuses to load one -- *"Script at 'blob:null/…'
  cannot be accessed from origin 'null'"*. A classic Worker from the same blob
  starts.
- **The wasm-bindgen glue stays an ES module** (`wasm-pack build --target web`,
  as before). A classic worker reaches it through dynamic `import()` of a
  second blob URL, so no second build target is needed here.

Fetching stays on the main thread: it is waiting, not work, and keeping it there
leaves the fetch loop, the progress bar and the missing-nuclide reporting where
they were. The bytes are *transferred* into the worker rather than copied, so a
few hundred MB of cross sections cross for free.

If a browser refuses to make a Worker at all, the same worker source is
evaluated on the main thread behind a shim that presents the same message
interface. The solve blocks the page exactly as it did before, which is worse
than a worker and much better than a page that does not run. Two cases are
worth expecting: a browser stricter than Chromium about what a `file://`
document may do, and a Content-Security-Policy without `worker-src blob:` where
the file is served rather than opened. `verify.mjs` exercises both paths, and
fails if the normal one silently becomes the fallback.

Only Chromium has been tested. The worker path is verified there; the fallback
is a hedge against the browsers that have not been.

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

A full run has been verified in Chromium from `file://` against real
ENDF/B-VIII.1 data -- chain load, cross-section fetch, solve and all four plots,
with a Fe56 material and the 1383 unpublished nuclides of its closure answered
as 404s. `node verify.mjs` is that check; it needs a local copy of the data
(`YANI_FIXTURES`, or core's `fetch_test_fixtures.py`) and skips the run without
one, so CI currently gates on everything up to the first solve.

Not yet done:

- the single-file session export is not implemented
- no GitHub Pages workflow
