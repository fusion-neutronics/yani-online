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

`dist/index.html` is the result: **one self-contained file**, currently 3.38 MB,
with the solver, the plotting library and the page inlined. It opens from
`file://` with no server and no network -- nuclear data is the only thing it
fetches, and only when a calculation asks for it.

| | |
| --- | ---: |
| wasm (base64) | 2.81 MB |
| plotly-basic (gzip + base64) | 0.45 MB |
| page and application code | 0.12 MB |

`plotly-basic` rather than the full bundle: every chart here is scatter or bar,
which the basic distribution covers at a quarter of the size. It is gzipped
before base64 and inflated with `DecompressionStream`, which is 0.45 MB against
1.87 MB for full Plotly inlined raw.

The wasm is the `wasm-opt`-optimised build, taken from a core release rather
than built here: binaryen cannot be downloaded through this environment's proxy,
so a local `wasm-pack build` produces around 2.5 MB where core's CI produces
2.11 MB.
fusion-neutronics/core#467 attaches that optimised `pkg/` to every release, so
re-vendoring means downloading an asset rather than reproducing a toolchain:

```bash
gh release download yani-core-0.11.0 -R fusion-neutronics/core \
  -p 'yani-wasm-*.tar.gz' -O - | tar xz --strip-components=1 -C vendor \
  pkg/yani_wasm.js pkg/yani_wasm_bg.wasm
```

Then record which commit it came from, since the asset does not carry it:
`git -C ../core rev-list -n 1 yani-core-0.11.0 > vendor/CORE_COMMIT`.

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

### Fetching MTs rather than files

`version.json` is fetched first for every nuclide, and the rest of that
nuclide's fetch is decided by what it says. Two things follow from that order.

The first works today. A library publishes far fewer nuclides than the chain
names, and an unpublished one used to 404 three times, once per file; now it
404s on `version.json` and the other two requests are never issued. Measured
against the SFR chain fixture with an Fe material, 446 of the 461 nuclides in
the closure are unpublished, and the run goes from 1383 nuclide-data requests to
491.

The second is live as of yani-core-0.11.0. Each `version.json` carries
`reaction_ranges`, the byte range of every record batch inside
`reactions.arrow`, keyed by MT and then by temperature (core's
`index_reactions` writes it; since fusion-neutronics/core#100 the file is
written one batch per (MT, temperature), so one temperature of one reaction is
its own range). That two-level shape is what this build plans from, and the
published data still carries the one-level shape it replaces, so until every
`version.json` on the origin has been reindexed the page reads them as no index
and falls back to whole-file GETs. An activation run reads the handful of channels its chain names
and none of the full-grid transport MTs, which are most of the file, so the page
plans a set of HTTP range requests instead of one whole-file GET, coalescing
ranges less than 16 kB apart, and splices `schema ++ batches ++ EOS` into an
Arrow IPC stream.

It was gated off until this release, because nothing could read what it produces:
everything the solver loads goes through `read_arrow_file`, which was
`FileReader`, and an IPC stream has no footer for it to find. It now sniffs the
`ARROW1` magic and reads either framing. The gate is `requiredMts` on the
session, feature-detected at boot rather than read off `vendor/CORE_COMMIT`: a
commit says which build this is, not what it can do, and the page has to choose
how to fetch before it has fetched anything. That method is also where the MT set
comes from, so the page carries no copy of the chain kind to MT table. Both
halves are core#527, and re-vendoring a solver that has them turned this on with
no change here.

Measured end to end by `node verify.mjs`, on the SFR chain fixture with an Fe
material: **13.6 MB across 47 requests where the whole files are 114.3 MB**, 8.4x
less over 16 nuclides at 2.9 requests each, and the answer is identical --
4.4380e14 Bq peak activity and 2.711e4 Gy/h peak contact dose, the same digits
the whole-file path gives.

A nuclide that publishes *none* of the wanted MTs plans nothing but the schema,
and that plan is kept rather than dropped: the solver reads a
schema-and-nothing-after-it stream as the empty subset it is, which is the same
zero reactions the whole file would have given once the MT filter ran. He4 is the
real case, in endf-b8.1 and jendl-5.0 alike. So the nuclides with nothing to give
are the ones the index saves the most on -- all of the file rather than most of
it.

The fixture set carries no such nuclide, so that case was confirmed once against
the vendored binary directly, driving `YaniSession` from Node with Fe56's
published bytes: a 712-byte schema-only splice in place of the 31 MB file loads
without error and transmutes to zero activity over zero nuclides, where the same
splice taken over the MTs the chain does name is 3.81 MB and gives 5.51e14 Bq
over three. Zero is the answer a nuclide with no activation channel should give;
what mattered was that it is an answer rather than a thrown error taking the run
with it.

The whole-file path stays as the fallback, for a solver too old to say which MTs
it needs and for a range answered `200` rather than `206`, which is treated as a
stripped `Range` header and the body used as the whole file. That is the right
answer through a proxy that does not pass ranges through, and once one request
comes back that way the page stops asking for ranges for the rest of the session.

### Checking it

`src/ranges.js` holds the arithmetic and the assembly, kept clear of the DOM and
the network so `verify.mjs` can check both in Node without a browser: the parts a
plan asks for, what coalescing merges and drops, the `Range` header's inclusive
end, and which span belongs to which stream. That last one is where a mistake
would be silent, so the spans are handed over deliberately out of order: a span
filed by arrival rather than by plan splices a stream from the right bytes in the
wrong order, and the loader would read it without complaint. It also caught the
one real bug in this: `new Array(n)` is sparse and `every` skips holes, so a span
that never arrived read as a complete set and reached the splice, which threw and
took the whole run down instead of reporting one nuclide.

`node verify.mjs --live` checks the part no synthetic fixture can, against the
real origin: that the published index describes the published object, that ranges
come back 206 with exactly the bytes asked for, and that a spliced stream is
byte-for-byte the whole file's bytes at those offsets. Opt-in, because it is the
only part that needs the network.

Byte-exactness is what that asserts, since nothing in this repository decodes
Arrow. That a byte-exact splice of these ranges *decodes* correctly was confirmed
once with pyarrow, on Fe56, Li6, Cr52 and Pu239: the stream opens without a file
header or footer, and its schema, its record batches, the table they fuse into
and the (n,gamma) cross-section values are identical to reading the whole file.
Pu239 covers fission, MT 18. That is a property of the format rather than of this
code, so it is recorded here rather than re-run.

Worth knowing for anyone tuning the 16 kB threshold: on every ENDF/B-8.1 nuclide
checked, coalescing merges only ranges that already touch and swallows no
unwanted MT at all, because the writer puts the activation MTs in contiguous
runs. Every nuclide comes out at three requests whether five MTs are wanted or
sixteen. So the threshold is free today, and the drop-the-swallowed-batch path
exists for a layout that does not hold: it is reachable only from the synthetic
fixture, which is why that fixture builds the case.

The fixtures carry an index themselves -- core's
`scripts/fetch_test_fixtures.py` downloads the published `version.json`, and the
published one has `reaction_ranges` in it -- but until the origin is reindexed
that is the one-level shape from before fusion-neutronics/core#100, which this
build reads as no index. So does a tree old enough to predate the index. Either
way `cargo run --release -p yamc-convert --bin index_reactions -- <fixture dir>`
in a core at or after that change rewrites the fixtures' `version.json` in the
two-level shape, and the browser run then exercises the ranged path end to end;
without it `verify.mjs` prints the skip line and the page fetches whole objects.
The fixture server in `verify.mjs` honours `Range` and answers 206 either way.

The five data subsections are chosen independently, because each library
publishes only some of what a calculation needs. ENDF/B-VIII.1 is the default
throughout: it is what the rest of the stack defaults to, so a calculation set up
here matches one set up in the wheel without being told to. Three libraries
publish a complete self-consistent network -- it, JEFF-4.0 and JENDL-5.0. TENDL
covers far more parent nuclides for the reactions subsection and is usually the
better choice there, but it publishes no decay data, so defaulting to it would
silently require a second library.

Picking a library for a subsection it does not publish is refused by the
dropdowns rather than left to fail at fetch time. It is worth keeping that way:
a subsection whose files 404 loads as an *empty* subsection, and since
yani-core-0.11.0 a solve against one says so -- "the fission-yields subsection is
not loaded, but 88 nuclides in this material have a non-zero fission rate" --
where it used to drop those products silently.

## Speed

Two numbers, and they are different questions. The first solve carries the
fetch, the chain parse and the Arrow decode of every reachable nuclide. The
solves after it change nothing about the material, which is what anyone actually
does here: move a pulse, add a cooldown, run again. `node bench-solve.mjs
<label>` measures both against the fixtures.

The material is rebuilt only when something about it changed. That reads like a
micro-optimisation and is not: the solver decodes each nuclide's cross sections
into the material it was handed and keeps them there, and the cache behind that
holds only weak references (fusion-neutronics/core#588), so a rebuilt material
is an empty one and the next solve re-decodes the lot. Rebuilding on every run,
which is what this did, threw that away every time.

Measured by `node bench-solve.mjs`, three runs of each of the four
combinations, against the same fixtures:

| solver | material | repeat solve | first solve |
| --- | --- | --- | --- |
| 0.11.0 | rebuilt every run | 95, 93, 95 ms | 572, 555, 607 ms |
| 0.11.0 | reused | 92, 95, 93 ms | 577, 574, 583 ms |
| 0.12.0 | rebuilt every run | 79, 83, 80 ms | 568, 603, 590 ms |
| 0.12.0 | reused | 62, 64, 61 ms | 533, 564, 583 ms |

Three runs rather than one because the interesting claim is a negative: the two
0.11.0 rows overlap completely, which is the reuse being worth *nothing* there,
and a single pair of numbers cannot tell that from noise. The 0.12.0 rows do not
overlap at all.

So the reuse is worth nothing on 0.11.0, which is the point: 0.11.0 has no data
to keep on the material. On 0.12.0 it is worth about 80 ms to about 62 ms, and
the pair together take a repeat solve from about 95 ms to about 62 ms.

The first solve does not move, because it is dominated by the fetch rather than
by anything either change touches.

These are smaller than they would have been before the fixtures carried
`reaction_ranges`. The byte-range fetch means only the activation MTs are
fetched and decoded, 13.6 MB against 114.3 MB, so there is far less decode left
for keeping the material to save. The first solve fell from about 1.3 s to about
0.6 s when the fixtures gained the index, which is the byte-range work rather
than anything here.

The fixtures still understate the reuse. They carry 16 indexed nuclides where a
real closure is 461 at roughly 508 MB of activation-scoped Arrow, and core
measured the decode at 1.8 s of a 2.3 s call on a ~430-nuclide steel. The bigger
the closure, the more of a repeat solve is decode, and the more this removes.

Two things that do *not* arrive with a newer solver, and are worth knowing
before reading core's benchmark table as a promise:

- **The parallel findings do not apply.** rayon is a target-gated dependency in
  `yani-transmute` and every parallel site has a sequential wasm arm, because
  the browser has one thread. Findings 5a, 5b, 5c and 4, which are most of
  core's headline 10.5x and 38x, are simply the sequential code here.
- **The GIL finding is Python's.** So the wasm-applicable rows are the
  sequential ones, and they are worth about 2x.

Reusing a material has one hazard, which is a cache key that misses a field:
the page would solve a changed material against the one before it and report
the old answer as the new one, with nothing to see. `verify.mjs` changes the
volume, the density and the composition and requires the answer to follow each
one, and to come back exactly on the way back.

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

The spectrum can be pasted against any of the ten neutron group structures the
solver resolves by name, which is what it lists rather than a subset of them.
The two photon structures it also knows are deliberately not offered: this is a
neutron spectrum, and a photon grid pasted into it would resolve and solve and
mean nothing. (`VITAMIN-J-42` was offered here until the release, and is one of
the two.)

A full run has been verified in Chromium from `file://` against real
ENDF/B-VIII.1 data -- chain load, ranged cross-section fetch, solve and all five
result plots, with a Fe56 material and the 446 unpublished nuclides of its
closure answered as 404s: 4.4380e14 Bq peak activity, and 2.711e4 Gy/h peak
contact dose. The same setup run through the `yani` Python package agrees to
2.1e-10 -- which is how the composition bug above was found. Firefox and WebKit
last ran the page end to end on the solver vendored before yani-core-0.11.0,
where all three engines agreed to the last digit; only Chromium is installed
here, so that is what this release was checked against.

`node verify.mjs` is that check; it needs a local copy of the data
(`YANI_FIXTURES`, or core's `fetch_test_fixtures.py`) and skips the run without
one, so CI currently gates on everything up to the first solve.

Not yet done:

- the single-file session export is not implemented
