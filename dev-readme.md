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
`dist/index.html`, and puts the Python tab's files beside it (see "The Python
tab" below).

The solver was mis-reading nuclide names until recently: `Fe56` reached the
formula parser first and came back as Fe with a subscript of 56, which expands
over natural abundance. A single-nuclide material was quietly 8.8% short on its
own nuclide and carried three isotopes nobody asked for. Fixed in core by
fusion-neutronics/core#468; anything vendored before that has it.

`vendor/CORE_COMMIT` records which core commit produced the solver. The page is
one opaque file, so without it there is no way to tell afterwards which solver a
given build carries, and a stale copy would look no different from a fresh one.

`dist/index.html` is the result: **one self-contained file**, currently 6.40 MB,
with the solver, the plotting library and the page inlined. It opens from
`file://` with no server and no network -- nuclear data is the only thing it
fetches, and only when a calculation asks for it.

| | |
| --- | ---: |
| wasm (base64) | 5.73 MB |
| plotly-basic (gzip + base64) | 0.45 MB |
| page and application code | 0.18 MB |
| spectrum presets | 0.03 MB |

`plotly-basic` rather than the full bundle: every chart here is scatter or bar,
which the basic distribution covers at a quarter of the size. It is gzipped
before base64 and inflated with `DecompressionStream`, which is 0.45 MB against
1.87 MB for full Plotly inlined raw.

The wasm is the `wasm-opt`-optimised build, taken from a core release rather
than built here: binaryen cannot be downloaded through this environment's proxy,
so a local `wasm-pack build` produces more than core's CI does (4.35 MB for
yani-core-0.21.3 and 0.21.1, against 4.30 MB for 0.21.0, 2.40 MB for 0.17.0
and 2.11 MB for 0.11.0; the solver grew).
fusion-neutronics/core#467 attaches that optimised `pkg/` to every release, so
re-vendoring means downloading an asset rather than reproducing a toolchain. Core
now tags one release for both of its cores, so the tag carries both names:

```bash
gh release download 'yamc-core-0.16.3,yani-core-0.21.3' -R fusion-neutronics/core \
  -p 'yani-wasm-*.tar.gz' -O - | tar xz --strip-components=1 -C vendor \
  pkg/yani_wasm.js pkg/yani_wasm_bg.wasm
```

Then record which commit it came from, since the asset does not carry it:
`git -C ../core rev-list -n 1 'yamc-core-0.16.3,yani-core-0.21.3' > vendor/CORE_COMMIT`.

And diff the asset's `pkg/yani_wasm.d.ts` against the previous release's, which
is where a changed export or signature would show. From yani-core-0.18.0 to
0.21.0 only the doc comments moved: `run()` documents the `photon_continua` and
`gas_production_appm` it now adds to each step, which the page does not read
yet.

The solver and the data move together. yani-core-0.17.0 reads `format_version`
2, the 2026-09-18 republish that moved the union energy grids out of
`nuclide.arrow` into their own `energy.arrow` (fusion-neutronics/core#100 and
#109), and refuses a folder at version 1 rather than reading it with no grids;
the release before it read version 1 and cannot read 2. The origin serves 2 for
every library, so a page vendoring an older solver would fail every load.

The format version is not the whole of it. yani-core-0.18.0, vendored here
after 0.17.0, reads format 2 but refuses the decay data published since core
began carrying the decay energy split (fusion-neutronics/core#155):
"decay/nuclides.arrow has columns the schema does not declare", naming
`decay_energy_alpha`, `decay_energy_beta`, `decay_energy_gamma` and their
uncertainties. So with it every load stopped at the chain, against the origin
and against core's fixtures alike; yani-core-0.21.0 reads that data. A release
in a format the vendored solver does not read is refused before any of its
files are fetched, since `latest.json` names its `format_version`
(`SUPPORTED_FORMAT_VERSIONS` in `src/ranges.js`, core's own list, `2` for
0.21.3); a schema change within a format shows only when the chain loads.

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

### Reading from the current release

Every library on the origin is published as immutable release folders and one
mutable pointer (fusion-neutronics/core#309), the layout the `yani` wheel reads:

```
<keyword>/latest.json                     which release is current
<keyword>/<release>/manifest.json         every file, with its size and sha256
<keyword>/<release>/neutron/<Name>.arrow/...
<keyword>/<release>/transmutation/<subsection>.arrow/...
```

Per library and once per session, the page reads `latest.json`, then the
manifest it names, checked against the size and sha256 the pointer gives, and
fetches every file from under that release's folder. A whole file is checked
against its manifest line. A byte range is checked per record batch against the
sha256 the index entry carries (fusion-neutronics/core#323), where it carries
one, since the manifest's hash covers only the whole object. Bytes that differ
stop the run rather than being solved. The checking is WebCrypto's
`crypto.subtle`, which only a secure context has: https, `file://` and
`localhost` are; a page served over plain http from elsewhere is refused rather
than reading data it cannot check.

`latest.json` is asked for with a `release-check` query of 16 random hex
digits, new each time, as core's clients ask for it from
fusion-neutronics/core#393 on. The CDN edge keys its cache on the query string,
so the origin answers. A copy of the pointer at the edge can outlive the
release it names: on 2026-10-17 every library's named a release that had been
deleted, so every file under it was a 404. The manifest and the release's files
are immutable and are asked for plainly, so the edge caches them.

The release is held for the session, so a pointer that moves mid-session cannot
mix two releases into one answer, and a reload picks up the new one. A nuclide
the manifest does not list is not asked for at all. A library with no
`latest.json` is read from the unversioned paths it was published under before
releases, unchecked; no other library is.

### Fetching one temperature of the MTs a run reads, rather than files

`version.json` is fetched first for every nuclide, and the rest of that
nuclide's fetch is decided by what it says. Two things follow from that order.

The first is the 404s. A library can publish fewer nuclides than the chain
names, and an unpublished one used to 404 three times, once per file; now it
404s on `version.json` and nothing else is asked for it. Against the SFR chain
fixture with an Fe56 material, 441 of the 462 nuclides in the closure are not in
the fixture set, and the run makes 656 nuclide-data requests where three per
nuclide would be 1386. Against the origin itself it buys nothing on ENDF/B-8.1,
which publishes every one of the 462; it is there for the libraries with gaps.
With a release manifest the page no longer asks: a nuclide the manifest does not
list gets no request, and the same fixture run makes no 404s at all.

The second is the indexes. Each `version.json` carries two: `reaction_ranges`,
the byte range of every record batch inside `reactions.arrow`, keyed by MT and
then by temperature, since the file is written one batch per (MT, temperature);
and `energy_ranges`, the byte range of each temperature's union energy grid
inside `energy.arrow`, which is written one batch per temperature. An activation
run reads the handful of channels its chain names, at the one temperature the
material is at, and none of the full-grid transport MTs or the other
temperatures, which together are nearly all of both files. So the page plans,
per nuclide, the wanted MTs at one temperature and that temperature's grid as
HTTP range requests, coalescing ranges less than 16 kB apart, and splices each
file's `schema ++ batches ++ EOS` into an Arrow IPC stream. The solver reads
either framing: `read_arrow_file` sniffs the `ARROW1` magic. The MT set comes
from `requiredMts` on the session, feature-detected at boot, so the page carries
no copy of the chain kind to MT table.

Which temperature is the **Temperature** field in the material section,
294 K by default. Per nuclide the page takes the published label nearest it,
chosen among the labels that carry a batch of a wanted MT and a grid: the index
also lists a 0 K label, which on ENDF/B-8.1 carries elastic scattering and
nothing else, and a run fetched at it would splice a stream with every wanted
channel absent, which the solver reads as a nuclide that reacts at zero. Every
library on the origin publishes the same seven labels for every nuclide checked
(0, 250, 294, 600, 900, 1200 and 2500 K), so the nearest is the one asked for
unless something else is typed.

The solver is not told the temperature; the wasm material has none. It reads
the spliced stream, finds one temperature carrying reactions, and settles on it.
That is the same rule it applies to a whole file with every temperature in it,
where it settles on the *lowest*, 250 K on ENDF/B-8.1, and it is also what the
`yani` wheel does for a material that names no temperature. So the page used to
answer at 250 K without saying so and now answers at 294 K by default, and the
Python export writes the temperature onto the material so the wheel reads the
same one (exactly when the label is published, as a blend of the bracketing
pair otherwise, where the page takes the nearest). On the Fe56 check the two
temperatures differ in the tenth significant digit of the peak activity,
4.4382587336e14 Bq at 250 K against 4.4382587341e14 at 294 K.

Changing the temperature, or the cross-section library, after a run invalidates
every held nuclide and rebuilds the material, because the solver keeps the
decoded cross sections on the material it was handed and a rebuilt one is
empty. `verify.mjs` checks the round trip: a run at 600 K fetches again and
gives a different answer, a run back at 294 K fetches again and gives the
original exactly, and a run that changes neither fetches nothing.

Changing one of the four chain libraries after a run goes further and starts
the wasm session over (`reset` in worker.js), then fetches the chain and every
cross section again. A chain section can be added to a session but not taken
away, so a library that does not publish one of the optional files would leave
the previous library's copy in place under the new one's name; and the cross
sections held were fetched for the reactions the old chain named, so a channel
the new chain names could be absent from a spliced stream and react at zero
without saying so. A fresh session is the one clean slate the wasm offers. The
budget line says the chain will be fetched again as soon as the dropdown moves,
and `verify.mjs` checks that the run does, and that a run after it fetches
nothing again.

Measured against the origin with the built page, on an Fe56 material against
ENDF/B-8.1, whose closure is 462 nuclides, all published:

| | requests | transferred | first run |
| --- | ---: | ---: | ---: |
| whole files, no index | 1392 | 3.9 GB (by the indexes) | not measured |
| every temperature of the wanted MTs, grids whole | 2774 | 662 MB | 73 s |
| one temperature of the wanted MTs, one grid | 5019 | 156 MB | 21 s |

The last two are the page before and after this change. Of the 156 MB, the
reactions are 100 MB in 3304 range requests (seven per nuclide: the wanted
batches of one MT are now separated from the next MT's by its other five
temperatures, where before they touched), the grids 32 MB in 785, `version.json`
13 MB in 462 and `nuclide.arrow` 1.4 MB in 462. The requests are why
`XS_CONCURRENCY` in app.js is 48 rather than the dozen the chain fetch uses: the
same run takes 38 s with 12 in flight, 26 s with 24 and 21 s with 48, and no
less beyond that. A range request costs its round trip, not its bytes.

Read from a release, the same run on yani-core-0.21.0 against ENDF/B-8.1
release 2026-10-12.1, where the closure is 465 nuclides, all published, made
5582 requests for 158.9 MB in 48 s: `latest.json`, the manifest and 5580 files
under the release folder, none outside it and not one 404.

Measured end to end by `node verify.mjs`, on the SFR chain fixture with an Fe56
material: **4.9 MB across 173 range requests where the whole files are
177.5 MB**, over 21 nuclides and both files, and the answer is
4.4380e14 Bq peak activity and 2.711e4 Gy/h peak contact dose, the same digits
the whole-file path gives at that temperature. The same setup through the wheel
at 294 K gives 4.43825873407959e14 Bq against the page's 4.43825873407960e14,
which is the last bit.

On yani-core-0.21.0 and core's current fixtures (release 2026-10-12.1) the same
check reads **6.9 MB across 216 range requests where the whole files are
212.7 MB**, over 24 nuclides, and answers 2.1891e14 Bq and 7.551e3 Gy/h. The
same setup through the wheel (yani-core 0.21.0, on the same fixture files) gives
218909479821531.5 Bq against the page's 218909479821531.47, the last bit again,
and the same contact dose to every digit, 7550.812379468497 Gy/h. The answer
halved because the default spectrum changed, not the solver: the figures above
were taken on the coarse "Fusion first wall" shape that was then the default,
which put 55% of its flux above 5 MeV, where the HCPB first-wall spectrum that is
the default now (see "Spectrum presets") puts 14%, and Fe56's activation
channels, (n,p) to Mn56 among them, are threshold reactions. The page as it was
then, with yani-core-0.21.0 swapped in, still answers 4.438e14 Bq and
2.711e4 Gy/h on the same fixtures.

A nuclide that publishes *none* of the wanted MTs plans nothing but the reaction
schema, and that plan is kept rather than dropped: the solver reads a
schema-and-nothing-after-it stream as the empty subset it is, which is the same
zero reactions the whole file would have given once the MT filter ran. He4 is the
real case, in endf-b8.1 and jendl-5.0 alike. Its grid is still fetched, one of
them, because the loader requires `energy.arrow` for any nuclide whose
`nuclide.arrow` lists temperatures. So the nuclides with nothing to give are the
ones the index saves the most on -- all of the reactions file rather than most of
it: `node verify.mjs --live He4` reads 712 bytes of a 0.23 MB file.

That case was confirmed once against the vendored binary directly, driving
`YaniSession` from Node with Fe56's published bytes: a 712-byte schema-only
splice in place of the 31 MB file loads without error and transmutes to zero
activity over zero nuclides, where the same splice taken over the MTs the chain
does name is 3.81 MB and gives 5.51e14 Bq over three. Zero is the answer a
nuclide with no activation channel should give; what mattered was that it is an
answer rather than a thrown error taking the run with it.

The whole-file path stays as the fallback, for a solver too old to say which MTs
it needs, for a `version.json` with no reaction index, and for a range answered
`200` rather than `206`, which is treated as a stripped `Range` header and the
body used as the whole file. That is the right answer through a proxy that does
not pass ranges through, and once one request comes back that way the page stops
asking for ranges for the rest of the session. A reaction index without a grid
index narrows the reactions and fetches the grids whole; a grid index without a
reaction index narrows nothing, because the solver would settle on the lowest
temperature in the whole reactions file and need that temperature's grid.

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
real origin: that the published indexes describe the published objects, that
ranges come back 206 with exactly the bytes asked for, and that a stream spliced
at 294 K is byte-for-byte the whole file's bytes at those offsets, for the
reactions and for the grids. Opt-in, because it is the only part that needs the
network.

Byte-exactness is what that asserts, since nothing in this repository decodes
Arrow. That a byte-exact splice of these ranges *decodes* correctly was confirmed
once with pyarrow, on Fe56, Li6, Cr52 and Pu239: the stream opens without a file
header or footer, and its schema, its record batches, the table they fuse into
and the (n,gamma) cross-section values are identical to reading the whole file.
Pu239 covers fission, MT 18. That is a property of the format rather than of this
code, so it is recorded here rather than re-run.

Worth knowing for anyone tuning the 16 kB threshold: on every ENDF/B-8.1 nuclide
checked, coalescing merges only ranges that already touch and swallows no
unwanted batch at all. At one temperature there is little left to merge: the
writer lays one MT's temperatures back to back, so the wanted batch of one MT
and the wanted batch of the next are separated by five batches nobody asked
for, and a nuclide comes out at about seven reaction requests and two grid
requests rather than the three it took when every temperature was wanted.
Raising the threshold buys requests back at the price of bytes: 256 kB would
halve the requests and double the bytes, and 1 MB would fetch every temperature
again. The drop-the-swallowed-batch path exists for a layout that does not
hold: it is reachable only from the synthetic fixture, which is why that fixture
builds the case.

The fixtures are the published objects, so they carry both indexes: core's
`scripts/fetch_test_fixtures.py` downloads each nuclide's `version.json`,
`nuclide.arrow`, `energy.arrow` and `reactions.arrow` as the origin serves them,
into `~/.cache/yamc` with symlinks under `crates/yamc/tests`. A cache from
before the 2026-09-18 republish is `format_version` 1, which the vendored
solver refuses ("Unsupported Arrow format version"); the script re-fetches a
cache whose `data_version` no longer matches, so re-running it is the fix. The
fixture server in `verify.mjs` honours `Range` and answers 206.

It serves them as a release, the way the origin does: a `latest.json` naming a
release called `fixtures`, its manifest listing every file with its size and
sha256, and the files under `<keyword>/fixtures/`, one tree answering for every
keyword. A `version.json` whose index entries carry no sha256 has them added as
it is served, so the per-batch check runs on every range the page fetches. A
request is matched by its path, as the origin matches it. A request outside the
release layout is counted, and the check requires none. Every `latest.json`
request has to carry its own `release-check` value, and no other request any
query.

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

## Spectrum presets

The spectra the **Preset** tab offers are generated data, in `src/spectra.js`,
written by `spectra/make_spectra.py`. Seven of them, all on the CCFE-709 group
structure, one value per group, summing to one:

- **Five first-wall spectra**, one per blanket concept, tallied with yamc. The
  model is the same three shells around a plasma void every time, and only the
  breeder zone changes: a 1 m void with the source at its centre, 3 cm of
  Eurofer first wall, 60 cm of homogenised breeder zone, 10 cm of Eurofer rear
  wall, vacuum beyond. The tally is the track-length flux in the first-wall
  shell in the 709 groups. The breeder zones are HCPB (Be and Li4SiO4 pebbles,
  helium), HCLL (Pb-17Li, helium), WCLL (Pb-17Li, water), WCCB (Li2TiO3 and
  Be12Ti pebbles, water) and FLiBe (Li2BeF4), each homogenised by volume
  fraction over its constituents with Eurofer structure. The fractions are
  representative of the concepts rather than any one design's, and they are
  all in the script's `BLANKETS` table, which is the thing to edit for a
  different study. Every material is read at 600 K.
- **Two unmoderated emissions**, D-T and D-D, the Gaussian of Ballabio et al.
  at 20 keV ion temperature as `yamc.sources.fusion_neutron_spectrum` gives it,
  integrated over the groups. The same D-T distribution is the source of the
  five models above.

The boundaries are not in the file. A preset names its structure and the page
asks the solver for the boundaries by name, exactly as the pasted-flux tab does,
so there is no second copy of 710 numbers to drift from the wheel's; the Python
export writes the preset out as `Histogram("CCFE-709", flux)` for the same
reason. The dropdown is filled from the file at boot, so adding a preset is
adding an entry to the generator.

Regenerating is `python spectra/make_spectra.py` with `pip install yamc` and
about ten minutes: 4,000,000 source neutrons per model, which is 47 s of
transport for FLiBe and 194 s for HCLL on 32 threads (20,000 to 80,000
particles a second, the lead being the slow one), and more than 99.9% of each
spectrum lands in groups whose relative error is under 5%. The first run also
downloads the transport data for the nuclides in these materials, a few
hundred MB into `~/.cache/yamc`. The generator takes `--particles` for a quick
look and `--out` to write somewhere other than `src/spectra.js`.

`verify.mjs` checks the file rather than the physics: seven presets on one
structure, each a non-negative shape summing to one, no two the same, the D-T
emission peaking above the D-D one and both narrow, and every first-wall
spectrum spread across the structure while still peaking in the source's
group. In the browser it checks the dropdown offers every preset and that the
plotted curve follows a change of preset.

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
fetched and decoded, at one temperature 4.9 MB against 177.5 MB, so there is
far less decode left for keeping the material to save. The first solve fell
from about 1.3 s to about 0.6 s when the fixtures gained the index, which is the
byte-range work rather than anything here, and stays there on yani-core-0.17.0
at one temperature: 598 ms first, then 80, 73 and 61 ms.

The fixtures still understate the reuse. They carry 21 indexed nuclides where a
real closure is 462, and core measured the decode at 1.8 s of a 2.3 s call on a
~430-nuclide steel. The bigger the closure, the more of a repeat solve is
decode, and the more this removes. Against the origin the first solve is the
fetch: 21 s of the Fe56 run above, against a solve under a second.

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

Results are activity, decay heat, contact dose rate, the inventory at each step
and the decay photon lines. The three time series are plotted against time *after
shutdown*, the end of the last step that had a flux, not time from the start:
a decay curve is read from shutdown, and on a log axis the year of irradiation
ahead of it put every cooling point of the old default within a hundredth of
"1 year" and stacked them into a vertical line. The default schedule is that
year at 1e14 n/cm2/s and then ten cooling steps whose cumulative times run
log-evenly from a second to ten years, the same numbers
`yani.cooldown_steps((1, "s"), (10, "a"), 10)` gives in the wheel, shown to
three figures in the unit each fills; measured from shutdown they sit evenly
across eight and a half decades, which a log axis marks in the units a reader
thinks in (1 s, 1 min, 1 h, 1 d, 30 d, 1 a, 10 a) rather than in powers of ten
of years. The pulse itself is at zero and is drawn on a linear axis only, as
is the irradiation history of a schedule with several pulses. The Python
export plots the same axis.

Each series chart names some nuclides and sums the rest as "Other". How many
is a control above the chart, beside the scale toggles, from one to eight, and
four to open on; eight is the ceiling the colour palette clears (the data-viz
method's reference palette, eight slots validated on each surface), not a
default to tune, and a ninth would be a hue invented rather than assigned.
Which nuclides is decided by who *leads*: every nuclide that is the largest at
some step is named, in the order they first lead, and any slot left is filled
by peak. It used to be the largest peaks, and on aluminium those are Al28,
Mg27, Na24 and its isomer, every one gone within a week, so from then on the
whole inventory was the grey line and the chart hid the one thing it exists to
show, which nuclide dominates at which decade. When more nuclides lead than
there are slots, the ones leading for more of the log-spaced steps stay, then
the earlier ones. "Other" can be the largest line at a step where no one
nuclide dominates, which is a true reading. The Python export ranks its six
the same way. `verify.mjs` runs aluminium and requires the largest series at
the first step and at the last to be named.

Beside the count are two boxes, **total** and **by nuclide**, on every series
chart, and every chart opens with both drawn. The total is the first question
each answers, how much, and for a dose whether the thing can be handled and
after how long; the nuclides are the second, what is driving it and when. A
reader wants both at a glance, and either box takes one away. The total is
drawn in ink and dashed, so that it reads as the sum rather than as a nuclide
or as "Other". `verify.mjs` moves the count both ways, requires the total to be
the sum of the nuclides and "Other", and turns each box off in turn to leave
the other alone.

The inventory and the decay photon lines are one step at a time, each under a
slider of its own, opening on the last step. The inventory names the fifteen
largest atom densities at that step, on an x axis fixed from every step's
fifteen, so a bar's length means the same thing at every step. It sits in the
material panel, right under the material as built, rather than among the other
results: the material before and the material after are two bar charts a
glance apart, which is what they are for. The columns put the spectrum ahead
of the material on both sides, inputs on the left and their views on the
right, with the results last. The photon
plot's axes are fixed once per run the same way: the x range from every step's
lines, the y range from the lowest floor to the strongest line over the run,
each step drawing the lines within five decades of its own strongest. An axis
that followed each step would rescale itself under the reader with every move
of the slider, and make every step look the same; fixed, the lines fall and
shift on a frame that holds still, and a late step reads low, which is what a
late step is. A zoom the reader drags on either axis survives the slider, by
Plotly's `uirevision`; a new run or a scale toggle draws the axis afresh.

The contact dose is the odd one of the three time series: it
is intensive, so unlike activity and decay heat it does not scale with the
volume on the form -- the semi-infinite slab estimate cancels the geometry, and
a bigger lump of the same material reads the same at contact. It opens with
its total and its breakdown both drawn, as the other two charts do: the first
question a dose answers is whether the thing can be handled, and the second is
what is driving it. Absorbed dose in air at a build-up
factor of 2.0, which is what `Material.contact_dose()` defaults to in the wheel,
so the page and a Python run of the same setup report the same number:
7550.812379468497 Gy/h from both for the Fe56 check on yani-core-0.21.0, Mn56
leading in both (2.711e4 against 2.710833e4 before the default spectrum
changed).
Bremsstrahlung from decay electrons is not modelled, so a strong beta emitter
reads low.

The chart hides itself when `vendor/CORE_COMMIT` names a solver that predates
the field, rather than drawing empty axes -- a dose plot with nothing in it
reads as a material that gives no dose, which is a different and more alarming
claim than "this build cannot tell you".

The material is drawn as the solver builds it, under the spectrum and above
the results, before any run and on every edit of the form: one bar per nuclide by atom
fraction, log by default because a make-up spans decades, with the atom
density on hover and a line under it adding the material up (nuclides,
density, total atom density, volume, mass). It is the consequence of the form
that cannot be read off it: an element expands over its natural abundance, a
formula parses to its atoms, and a compendium name stands for thirty nuclides.
Every nuclide is drawn and the chart grows with the count rather than folding
a tail into "Other", since a trace isotope is exactly what a reader checking an
activation wants to know is there. The expansion is asked of the solver
(`materialJson` on the session) rather than repeated in the page.
`verify.mjs` requires natural iron to draw as its four isotopes adding to a
hundred percent, a compendium pick to draw many, and Fe56 to draw as one.

The spectrum can be pasted against any of the ten neutron group structures the
solver resolves by name, which is what it lists rather than a subset of them.
The two photon structures it also knows are deliberately not offered: this is a
neutron spectrum, and a photon grid pasted into it would resolve and solve and
mean nothing. (`VITAMIN-J-42` was offered here until the release, and is one of
the two.)

A full run has been verified in Chromium from `file://` against real
ENDF/B-VIII.1 data -- chain load, ranged fetch of one temperature of the cross
sections and their grid, solve and all five result plots, with a Fe56 material
whose closure of 462 nuclides the origin publishes in full: 4.4380e14 Bq peak
activity, and 2.711e4 Gy/h peak contact dose. The same setup run through the
`yani` Python package at 294 K agrees to the last bit, and at the wheel's own
default, which is the lowest published temperature, reproduces to the last bit
what the page answered before it fetched one temperature. (An earlier version of
this check agreed to 2.1e-10, which is how the composition bug above was found.)
On yani-core-0.21.0 it was run again, against ENDF/B-8.1 release 2026-10-12.1
with the page served from `localhost`: 2.1895e14 Bq peak activity and
7.555e3 Gy/h peak contact dose on the default HCPB spectrum, where the wheel
(yani-core 0.21.0, 294 K, the same data) gives 218953519632458.28 Bq against the
page's 218953519632458.25, the last bit, and 7554.745102195669 Gy/h from both.
Firefox and WebKit last ran the page end to end on the solver vendored before
yani-core-0.11.0, where all three engines agreed to the last digit; only
Chromium is installed here, so that is what this release was checked against.

`node verify.mjs` is that check; it needs a local copy of the data
(`YANI_FIXTURES`, or core's `fetch_test_fixtures.py`) and skips the run without
one, so CI currently gates on everything up to the first solve.

## Session export

**Export this session as one HTML file** writes the page with the setup and the
results inside it. Opened anywhere, from `file://` with no network, it comes up
on the saved run: the form as it was (material, libraries, temperature,
spectrum, schedule) and the charts drawn from the solver's own results, with
the sliders sized to the run. A run started from it fetches the data again, as
the page always does; the status line says so.

The page's own DOM is the source of the export, cloned and put back the way
the page is before boot (plots emptied, control bars removed, results hidden),
because the built page is one file and the only copy of itself in reach: a
`fetch` of `location.href` is refused from `file://`, which is where an
exported file lives and where it may be exported from again. The session
rides in a `<script type="application/json" id="yani-session">`, gzipped and
base64, and boot restores it last, after every control it drives is wired, by
driving the form the way a reader does so that the budget, the spectrum plot
and the material in the solver all follow.

The cross sections are not in the file. They live in the worker's wasm memory,
transferred there, and a closure's worth is a hundred MB and more; a file that
size is not one anyone opens. The note under the button says what the file
carries.

`verify.mjs` clicks the button, opens the file it writes in a fresh page with
the data origin unreachable, and requires the run to be there: the same peak
activity to the last digit, the same schedule, material, temperature and
preset, the stepped charts sized to the run, and no request for data.

## The Python tab

An editor that runs `yani` scripts in the page, on Pyodide, beside the form
(fusion-neutronics/yani-online#38).

| | |
| --- | --- |
| `src/script.js` | The tab: CodeMirror, the examples menu, Share and Download, the worker's lifecycle, the Output, Plots and Data tabs. |
| `src/script-worker.js` | Pyodide, installing yani-core, the nuclear-data fetcher, installing what a script imports, running scripts, `show()`. |
| `src/fetcher.js` | The worker's helper that fetches a batch of nuclear-data requests concurrently. |
| `examples/*.py` | The examples menu. Each opens with `# Title: description`, and runs as it is under `pip install yani plotly`. |
| `vendor/PYODIDE_VERSION`, `vendor/YANI_CORE_VERSION` | The Pyodide release and the yani-core release the tab installs. |
| `vendor/codemirror.js`, `vendor/coi-serviceworker.min.js` | Copied from yamc-online's `vendor/`. |
| `serve.mjs` | Static server for `dist/`, with fixtures under `/fixtures/` as a data release. |
| `scripts/fetch-fixtures.mjs` | Downloads what the tab's checks run against, from the current release. |

**Shared with yamc-online, by copy.** The worker, the fetch helper, the page
side of the editor, `serve.mjs` and `fetch-fixtures.mjs` started as copies of
yamc-online's and keep its structure, so a fix in one is easy to carry to the
other; `fetcher.js` and the CodeMirror bundle are unchanged. Copying rather
than sharing a package is deliberate: the two pages differ in what is around
the editor (here it is a tab beside a form that must keep its fast start), and
neither repository builds with npm. `vendor/codemirror.js` is rebuilt in
yamc-online (`scripts/vendor-codemirror.mjs`) and copied here; it is the
CodeMirror 6 bundle with the Python mode, whose completion of keywords and the
script's own names is extended here with yani's API, listed by the worker
from the installed package.

**Loaded on first open, not before.** The form is still the one file
`node build.mjs` inlines. The tab is not in it: app.js imports `./script.js`
the first time the tab is opened, and that brings CodeMirror (0.45 MB), then
the worker brings Pyodide from the jsDelivr CDN and the yani-core wheel
(3.3 MB) from PyPI. A visitor who only uses the form fetches none of it, which
`verify.mjs` checks by watching the requests. The form's start is unchanged:
180 ms from `file://` to "Ready", median of five, on this branch and on main
alike, and 200 to 210 ms over http. A page opened from a file says the tab
needs http(s), since a module worker cannot start from `file://`.

**yani-core from PyPI.** As in yamc-online: the worker reads PyPI's JSON API
for the pinned version, picks the wheel whose tag is the ABI in Pyodide's lock
file (`pyemscripten_2026_0_wasm32`), checks PyPI's sha256, and installs the
bytes with micropip, fetching the wheel while Pyodide boots. Core publishes it
with every yani-core release (fusion-neutronics/core#346). `node build.mjs
--wheel <path>` puts a local Pyodide wheel in `dist/` and installs that instead,
to try an unreleased core or to work offline; never publish a page built that
way. Building one is `pyodide build` in core's `packages/yani-core` with
`MATURIN_PEP517_ARGS=--no-default-features`, as yamc-online's dev-readme
describes for yamc-core.

**Nuclear data, through the wheel.** The tab does not fetch data itself. The
wheel's downloader is the same Rust as a native `pip install yani`, reading the
release layout: `<keyword>/latest.json` names the current release, its
`manifest.json` lists every file with its size and sha256, and files come from
`<keyword>/<release>/...` and are checked against it. Its GETs go to the page
through `yani._core._set_data_fetcher` (the hook yamc-core's wheel shares), in
batches that `fetcher.js` has in flight together while the Python worker
waits in `Atomics.wait`; a single request, or any on a page that is not
cross-origin isolated, is a synchronous `XMLHttpRequest`. Files land in
Emscripten's in-memory filesystem, so reruns fetch nothing. The downloader's
`Downloaded 4 of 9 nuclides` lines collapse into one, and show in the status
bar.

The form's own fetches are untouched by this, and still read the unversioned
layout (`<keyword>/neutron/...`); moving them to the release layout is separate
work.

**Plots.** `show(obj)` draws a plotly figure (with plotly.js inlined from the
plotly package, so the frame needs no network and Save .html opens anywhere), a
matplotlib figure (as SVG), or anything with `_repr_html_`, such as a
`Material`, in an `<iframe sandbox="allow-scripts">`. `figure.show()` and
`plt.show()` draw there too. Every top-level expression line with a display is
drawn where it stands, as in a notebook, except a method answering the object
it was called on (plotly's `add_scatter`, `update_layout`), which is building
a figure rather than asking to see it. A package a script imports that Pyodide
lacks, such as plotly, is installed with micropip before the run (plotly from
PyPI, about 10 MB, once per session).

**Stop** interrupts Python through Pyodide's interrupt buffer; a
transmutation is one call into Rust that never looks at it, so after 1.5 s
Stop restarts Python instead. Both need cross-origin isolation, which GitHub
Pages gets from `coi-serviceworker` (one reload on a first visit, loaded only
over http(s)). The form does not need it and is unaffected by it: it fetches
nothing cross-origin without CORS.

**The form's setup in the editor.** **Open it in the Python tab** writes the
same script **Download this setup as Python** does, except that its figures
are drawn with `figure.show()` rather than written to files, and puts it in
the editor (asking first if that would replace code the user wrote).

### Checking it

```bash
npm ci
node build.mjs [--wheel ../core/packages/yani-core/dist/yani_core-...whl]
node scripts/fetch-fixtures.mjs        # once: Fe56, lithium and the chain, 58 MB
YANI_FIXTURES=.fixtures node verify.mjs
node serve.mjs                         # http://localhost:8000/, ?data=/fixtures/ for the fixtures
```

`verify.mjs` serves `dist/` over http (cross-origin isolated) and checks that
the form starts without loading any of the tab and that the first open does;
the iron example's activity and decay heat at every step, its plotly figure,
the batched download and its counter, and that a rerun fetches nothing; the
form's setup opened in the editor and run, drawing its five figures; a figure
line partway down a script; completion of yani's names; tracebacks, Stop and
share links; and that nothing but Pyodide's CDN and PyPI is fetched from
another origin. `--live` also runs the iron example against the published
release and compares it with the native wheel's rows. With
`YANI_FIXTURES=.fixtures` the form's own transmutation is skipped, as it is in
CI, since it needs core's fixtures in core's layout.

Measured here (yani-core 0.21.0 built from core main, Pyodide 314.0.7,
Chromium): the first open of the tab is 6 to 13 s, nearly all of it Pyodide and
the wheel coming over the network. The iron example on the fixtures is 10 s
including plotly's install. Against the published release (2026-10-10.1) it
fetched **196.6 MB in 92 requests in 210 s** and printed the same rows as the
native wheel (`pip install` of the same core: 5.9805e+14 Bq and 144.60 W at
shutdown, Mn56; 1.9255e+13 Bq and 0.018027 W ten years on, Fe55); the native
run's cache holds about the same, 197 MB. Iron's closure reaches 20 nuclides
with published cross sections.

That download is whole files. The wheel reads byte ranges only where every
index entry it needs carries a sha256 to check the bytes against, and release
2026-10-10.1's `version.json`s carry the indexes without the hashes, so Fe56's
39 MB `reactions.arrow` comes whole where its 294 K activation channels are a
small part of it. Against the fixtures, which `serve.mjs` gives the hashes, the
same example fetches 21.7 MB. A release republished with the hashes brings the
live figure down the same way, with no change here.

Same numbers as the form: on core's fixtures, the form (with a yani-wasm built
from the same core) and the form's script run in the Python tab give the same
peak activity for the Fe56 check to a part in 1e15: 218914056970099.3 Bq in
the form, 218914056970099.28 in the script. The form's vendored solver (yani-core 0.18.0) cannot run that check
today: it refuses the decay data now published, and core's fixtures, with
"decay/nuclides.arrow has columns the schema does not declare". That is the
vendored wasm being older than the data, and wants a re-vendor from a current
core release.

Not yet done:

- the form's fetches still read the unversioned layout; moving them to the
  release layout is separate
- the vendored form solver predates the decay data now published (above)
