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

`dist/index.html` is the result: **one self-contained file**, currently 6.61 MB,
with the solver, the plotting library and the page inlined. It opens from
`file://` with no server and no network -- nuclear data is the only thing it
fetches, and only when a calculation asks for it.

| | |
| --- | ---: |
| wasm (base64) | 5.80 MB |
| plotly-basic (gzip + base64) | 0.45 MB |
| page and application code | 0.20 MB |
| spectrum presets | 0.16 MB |

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

On yani-core-0.21.3 and core's current fixtures (release 2026-10-12.1) the same
check reads **6.9 MB across 216 range requests where the whole files are
212.7 MB**, over 24 nuclides, and answers 2.453e14 Bq and 8.507e3 Gy/h. The
same setup through the wheel (yani-core 0.21.3, on the same fixture files) gave
the same numbers to the last digit on the previous draft of this spectrum, two
runs where the HCPB now has six: 245495300359330.72 Bq and 8510.860577085987
Gy/h from both. The answer moves with the default spectrum,
not the solver. The default is now the tokamak model's HCPB first wall (see
"Spectrum presets"), which puts 16% of its flux above 5 MeV, where the
spherical model's HCPB first wall before it put 14% and the coarse "Fusion
first wall" shape before that 55%; Fe56's activation channels, (n,p) to Mn56
among them, are threshold reactions. The first version of the tokamak model,
before the HCPB's shield block, gave 2.4533e14 Bq and 8.506e3 Gy/h; with the
spherical model's spectrum, as on main, this page and solver answer
2.1891e14 Bq and 7.551e3 Gy/h on the same fixtures; with the "Fusion first
wall" shape and yani-core-0.21.0 it was 4.438e14 Bq and 2.711e4 Gy/h.

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
written by `spectra/make_spectra.py` from the model in
`spectra/tokamak_model.py`. Twenty-two of them, all on the CCFE-709 group
structure, one value per group, summing to one:

- **Twenty tokamak spectra**: the neutron flux at five places in a typical EU
  DEMO with each of four blankets, HCPB, HCLL, WCLL and WCCB. Each also carries
  `flux`, its total at the model's full power in n/cm2/s, and the file's
  `SOURCE` says what that power is (2037 MW, 7.228e20 n/s).
- **Two unmoderated emissions**, D-T and D-D, the Gaussian of Ballabio et al.
  at 20 keV ion temperature as `yamc.sources.fusion_neutron_spectrum` gives it,
  integrated over the groups. They have no magnitude (`flux: null`).

The dropdown groups them by blanket, in the file's order; the first, the HCPB
first wall, is the default. The line under it gives the selected preset's
full-power flux, and **Use this flux for every pulse** writes it into every
pulse's rate. Choosing a preset never changes a rate by itself: the shape and
the magnitude are separate inputs, and a rate someone typed stays theirs. On the
Group structure tab and for the emissions the button is disabled. The flux line
also gives the flux's uncertainty (`fluxRelErr`, the larger of its statistical
error and the scatter of the runs pooled into it) and says when a preset is
short of its statistics gate, and the preset's description is shown under the
button: an option's tooltip is not shown by every browser, nor by any once the
option is chosen, and the description is where a preset says what the model
leaves out and why one short of its gate is short. A session file carries its
own copy of the page that saved it, so one saved before these presets reopens
with the presets it was saved with.

The boundaries are not in the file. A preset names its structure and the page
asks the solver for the boundaries by name, exactly as the pasted-flux tab does,
so there is no second copy of 710 numbers to drift from the wheel's; the Python
export writes the preset out as `Histogram("CCFE-709", flux)` for the same
reason, with the preset's full-power flux and fusion power in the comment above
it.

### The model

A typical EU DEMO, not any one design: the 2015 baseline machine (BL2015,
"DEMO1": R0 9.072 m, a 2.927 m, elongation 1.59, triangularity 0.33, 18 TF
coils, 2037 MW, Noce et al. 2018, Table 1), with every blanket in the same
80 cm inboard and 130 cm outboard envelope (Fischer et al. 2016) and every
layer a homogenised mixture. `tokamak_model.py` tags each number V (read in the
reference beside it), D (derived from that reference's dimensions, with the
arithmetic in the code) or A (assumed, the thing to change for a specific
design), and `make_spectra.py`'s docstring lists the references in full.

The geometry is nested toroidal shells about the z axis with a rectangular
poloidal section, each the box between two z-cylinders and two z-planes minus
the box inside it. The plasma-facing surface is R 5.895 to 12.249 m (25 cm
outside the separatrix) and |z| up to 5 m; a layer's top and bottom take the
mean of its inboard and outboard thickness. `python spectra/tokamak_model.py`
prints the build and every zone's make-up, and `--plot wcll` saves an xz and an
xy slice.

| Layer | Inboard (cm) | Outboard (cm) | Material |
| --- | ---: | ---: | --- |
| W armour | 0.2 | 0.2 | tungsten (V) |
| first wall | 2.5 | 2.5 | per blanket (V) |
| breeder zone | 23 or 47 | 52 or 80 | per blanket |
| manifolds and back supporting structure | 34.3, 30.3, 26.3 or 54.3 | 55.3, 47.3, 47.0 or 75.3 | per blanket (HCPB, HCLL, WCLL, WCCB) |
| HCPB shield block | 20 | 20 | Eurofer 90%, He 10% (V for the 20 cm, Pereslavtsev et al. 2016; A for the make-up) |
| WCLL clearance | 4.0 | 0.3 | void: Noce's build is 76.0 / 129.7 cm in the 80 / 130 cm envelope |
| vacuum vessel | 57 | 57 | SS316L 83.5%, water 16.5% (D, Fischer: 5 + 47 + 5 cm, 80/20 in the 47) |
| gap | 10 | 10 | void (A) |
| TF coil case, winding pack, case | 10, 60, 20 | none | inboard only, R < R0 (A); the winding pack's vertical leg is tallied, its arms above and below are a cell of their own |
| hall | to R 20 m, z 15 m | | void (A) |
| bioshield | 200 | 200 | ordinary concrete, wall and slabs (A) |

| Blanket | Breeder zone (cm) | First wall | Breeder zone | Manifolds and BSS |
| --- | --- | --- | --- | --- |
| HCPB (Hernandez et al. 2018, Pereslavtsev et al. 2016) | 23 / 52 (V) | Eurofer 63.2%, He 36.8% (D) | Be 39.1%, Li4SiO4 (60% Li6) 15.1%, Eurofer 9.2%, He 36.6% (D, packed at 0.64) | Eurofer 36.6%, He 39.6%, void (A), then the shield block |
| HCLL (Aubert et al. 2018) | 47 / 80 (A) | as the HCPB's (A) | Pb-15.7Li (90% Li6) 87.6%, Eurofer 8.7%, He 3.7% (D, the plates only) | Eurofer 36.6%, He 39.6%, PbLi 23.8% (A) |
| WCLL (Noce et al., Martelli et al. 2018) | 47 / 80 (V) | Eurofer 87.8%, water 12.2% (D) | PbLi 81.6%, Eurofer 12.9%, water 5.5% (D, the split A) | Eurofer 36.6%, water 39.6%, PbLi 23.8% (D), 26.3 / 47.0 cm (V) |
| WCCB (CFETR and JA concept) | 23 / 52 (A) | as the WCLL's (A) | Be12Ti 48%, Li2TiO3 (80% Li6) 12%, Eurofer 12%, water 8%, void 20% (A) | Eurofer 36.6%, water 39.6%, void (a placeholder) |

The back ends are where the four differ most in what they rest on. The WCLL's
is Noce et al.'s Table 2, layer for layer: 26.3 cm inboard, 4 cm thinner than
the envelope, which leaves a 4 cm clearance in front of the vessel. The HCPB's
has the ~20 cm steel block Pereslavtsev et al. put behind the feeding pipes to
shield the vessel and the coil, in front of which the manifolds and BSS are
assumed. The HCLL's is assumed (the WCLL's layers with helium for the water),
and the WCCB's is a placeholder (the same with void for the PbLi); the
vessel, coil and bioshield presets of those two say so. The WCCB is the least
certain overall: its fractions, its 4:1 Be12Ti to Li2TiO3 ratio and its 80%
enrichment come from descriptions of the concept rather than a published
radial build, and the paper that would confirm them (Liu et al., Fusion Eng.
Des. 89 (2014) 1380) was not to hand. The HCLL breeder zone counts only its
5 mm plates, not the caps, side walls, back plates and manifold inside the
zone, so its steel is low.

The source is `yamc.sources.tokamak_source` with that shape, in H mode, with the
profile parameters of core's `examples/python/tokamak_plasma_source.py` (after
Fausser et al., Fusion Eng. Des. 87 (2012) 787), a Shafranov shift of
44.789 cm (the example's 0.44789 is the same shift in metres, and
`tokamak_source` takes centimetres) and 50:50 D-T fuel: 3516 ring
sources, 0.48% of the neutrons D-D. The generator samples 100,000 birth points
and stops if any lies outside the plasma cell. In-vessel materials are read at
600 K, the vessel and the concrete at 294 K and the coil at 250 K, the lowest
temperature the data is published at, all from ENDF/B-VIII.1. yamc has no
S(alpha,beta), so the thermal peaks in water and concrete are free-gas shapes.

### Where, and how much

The five places are averages over whole cells, not peaks:

- **first wall**: the 2.5 cm shell, over the whole poloidal circumference;
- **breeder zone**: the whole shell;
- **vacuum vessel**: the whole shell;
- **TF coil winding pack**: the vertical inboard leg's 60 cm, over its height
  beside the vessel (|z| up to 6.8 m); the arms above and below the vessel,
  inside R0, about half the winding pack's volume, are a cell of their own and
  are not tallied, since they are fed by the void where the outboard legs would
  be and are not where a coil's limits are set;
- **bioshield**: the inner 20 cm of the concrete wall, R 20.0 to 20.2 m, over
  its 30 m height.

Each group's flux is the tallied track length per source neutron over the
cell's analytic volume, times the source rate, the fusion power over the
17.589 MeV of a D-T reaction: 7.228e20 n/s at 2037 MW (Noce et al. quote
7.2e20). The D-D neutrons are counted as D-T ones, a 0.3% effect. Every
magnitude scales linearly with fusion power. The plasma-facing surface is
1864 m2, so the mean neutron wall load is 0.87 MW/m2 where BL2015's is 1.05:
the rectangular section has more wall than a D-shaped one.

| n/cm2/s at 2037 MW | First wall | Breeder zone | Vacuum vessel | TF winding pack, inboard leg | Bioshield |
| --- | ---: | ---: | ---: | ---: | ---: |
| HCPB | 3.76e14 | 1.57e14 | 1.26e12 | 2.09e8 | 7.02e7 |
| HCLL | 6.63e14 | 2.41e14 | 1.70e12 | 2.43e8 | 6.79e7 |
| WCLL | 4.35e14 | 1.10e14 | 1.29e10 | 2.04e7 | 9.27e5 |
| WCCB | 3.15e14 | 9.81e13 | 2.06e10 | 6.76e7 | 5.75e6 |

The first walls are 63% (HCPB, WCCB) to 76% (HCLL) above 0.1 MeV and under
0.3% thermal; the bioshields are 72 to 77% thermal. Every place's total,
with its error and the totals of the runs pooled into it, is in the header
of each data file.

The coil's arms, the half of the winding pack above and below the vessel inside
R0, are left out of its preset because they run far lower than the leg. In
HCLL, whose model the split changes nothing else in, the leg averages
2.43e8 n/cm2/s against 1.35e8 for leg and arms together, so the arms average
about a fifth of the leg's flux and a leg-and-arms average is 0.55 of it.

The papers the model is drawn from quote values at the inboard or outboard
midplane, where the shield is thinnest and the flux highest, so the production
runs also tally the midplane rings (|z| under 1 m, 5 cm deep) by energy, and the
generator prints the ring at the front of each layer with its shares above 0.1
and 1 MeV. The ones that matter here, n/cm2/s at full power, with the share
above 0.1 MeV:

| | first wall, inboard / outboard | vessel front, inboard | TF case front, inboard | winding pack front, inboard |
| --- | ---: | ---: | ---: | ---: |
| HCPB | 4.09e14 / 4.37e14 | 2.09e13 (21%) | 4.18e9 (32%) | 1.59e9 (26%) |
| HCLL | 7.05e14 / 7.42e14 | 2.64e13 (23%) | 5.07e9 (30%) | 1.76e9 (22%) |
| WCLL | 4.82e14 / 5.12e14 | 4.07e11 (35%) | 4.27e8 (40%) | 1.79e8 (31%) |
| WCCB | 3.54e14 / 3.80e14 | 5.57e11 (46%) | 1.54e9 (36%) | 6.27e8 (26%) |

- WCLL, Noce et al.: 4.1e14 (inboard) and 4.8e14 n/cm2/s (outboard) at the
  first wall, 67% of it above 0.1 MeV; here the WCLL first wall averages
  4.35e14 with 66% above 0.1 MeV, and its midplane rings are 4.8e14 and
  5.1e14. On the TF coil they give 3.4e8 n/cm2/s, 1.3e8 of it fast; here the
  coil case front at the inboard midplane sees 4.3e8, 1.7e8 of it above
  0.1 MeV, 1.3 times theirs in both, now that the inboard build is theirs
  (Table 2: 76.0 cm, the rest of the 80 cm a clearance). Martelli et al. give
  5e14 n/cm2/s at the first wall.
- HCLL, Jaboulay et al. (Table 4, the first 5 cm of each layer at the inboard
  midplane, in a row headed Phi(E>1MeV)): 5.8e14 at the first wall (in the
  tungsten armour), 5.3e14 in the breeder zone, 7.2e13 in the manifold, 3.1e13
  in the vessel and 3.6e8 n/cm2/s in the coil. Here the totals in those rings
  are 7.1e14, 6.3e14, 1.2e14, 2.6e13 and, at the coil case front, 5.1e9, while
  the flux above 1 MeV is 3 to 120 times lower than their figures; so their row
  reads as the total flux, which agrees with this model's to within 1.6 times
  as far as the vessel's front. At the coil it is 14 times lower than here:
  their 2016 design met the coil limits, and the HCLL back end here is assumed.
- HCPB, Pereslavtsev et al.: with the steel block, the winding pack's heating
  and fast flux were under the limits. Here the winding pack front at the
  inboard midplane sees 1.6e9 n/cm2/s, 4.1e8 of it above 0.1 MeV, under the
  1e9 n/cm2/s fast limit.
- Fischer et al. (DEMO 2014 at 1572 MW, in their ISFNT-12 slides) give the
  fast flux at the TF coil case front at the inboard midplane: 1.7e9 (HCPB),
  2.4e9 (HCLL) and 5.3e8 n/cm2/s (WCLL), the helium-cooled concepts 3.2 and
  4.5 times the WCLL. Here, at 2037 MW, it is 1.34e9, 1.52e9 and 1.71e8,
  7.8 and 8.9 times. Their conclusion holds: only the WCLL is under the
  1e9 n/cm2/s limit at the case front without tungsten carbide or borated water
  in the vessel. The spread is wider for two reasons: the WCLL here is Noce et
  al.'s single-module-segment design, whose 93%-water manifold shields more
  than the 2014 WCLL did, and the helium-cooled back ends are this model's (the
  HCLL's assumed, the HCPB's with KIT's 2016 block), not the 2014 designs'.
  Scaled to 1572 MW the three are 0.61, 0.49 and 0.25 times Fischer's.

### Statistics

| | Histories | Production | Uncertainty on the total, fw / bz / vv / tf / bio | Furthest run from the others, in standard errors | Flux in groups under the gate's error |
| --- | ---: | ---: | --- | --- | --- |
| HCPB | 6 x 2,000,000 | 80 min | 0.029 / 0.019 / 0.093 / 4.7 / 1.4% | 1.7 / 2.2 / 2.4 / 2.4 / 1.7 | 100 / 100 / 100 / **59.4** / 98.0% |
| HCLL | 2 x 4,000,000 | 71 min | 0.034 / 0.018 / 0.10 / 2.7 / 0.95% | 1.2 / 0.4 / 1.7 / 0.5 / 0.5 | 100 / 100 / 100 / 85.6 / 99.4% |
| WCLL | 4 x 4,000,000 | 69 min | 0.034 / 0.012 / 0.27 / 2.7 / 15% | 2.9 / 0.9 / 1.4 / 1.3 / 1.9 | 100 / 100 / 99.7 / **78.9** / **35.6**% |
| WCCB | 2 x 3,000,000 | 20 min | 0.058 / 0.035 / 0.47 / 5.9 / 5.5% | 1.6 / 1.6 / 0.1 / 0.4 / 0.8 | 100 / 100 / 99.5 / **72.0** / 73.8% |

Each production is two or more independent runs of the same size, seeds 3, 4
and on, on 16 threads, pooled with `yamc.combine_results`. The uncertainty a
preset quotes is the larger of the pooled error and the error the runs' scatter
alone gives (the standard error of their mean; for two runs, |a - b| / (a + b)),
so a place whose error estimate is itself off shows it. The gate's error is 5%
for the first wall, breeder zone and vessel and 10% for the coil and the
bioshield, and every run's total has to lie within three combined standard
errors of the others' pooled total; they do everywhere, WCLL's first walls the
furthest apart at 2.9. The HCPB and WCLL productions have more runs than the
others because their coil and bioshield totals are the least well behaved: more
runs make the scatter, rather than each run's own error, the measure of how
well those totals are known.

Short of their gates, and saying so in their descriptions, on the page and in
every data file's header (in bold above): the HCPB, WCCB and WCLL coils (59.4,
72.0 and 78.9% of their flux in groups under 10% error, against the 80% the
gate asks) and the WCLL bioshield (35.6% under 10%, against 50%). The coil
presets are the winding pack's leg alone, under half the cell they were, and
the HCPB's sits behind the steel block, so its spectrum gets few tracks per
group: its total is good to 5% and its six runs agree, but its 709 groups are
not (flux-weighted group error 11%). yamc's reliability checks pass on every
first-wall, breeder-zone and vessel total of every run but four (9 or 10 of
11), and on no coil or bioshield total (3 to 10 of 11 pass): those totals are
heavy-tailed, which is why the gates are on the share of each spectrum in
well-resolved groups and on the runs agreeing rather than on a total's error.

WCLL's bioshield is the noisy one. Its four runs give 1.31e6, 9.7e5, 7.2e5 and
7.1e5 n/cm2/s (pooled tail slope 1.8, where yamc wants more than 3), so its
preset quotes 9.3e5 +/- 15%, the runs' scatter, rather than the pooled 12%; a
short check run (three runs of 40,000) gave 6.3e5. A heavy-tailed total is
more often under its mean than over it, and is pulled up by the rare run that
draws a heavy history, so the scatter is itself uncertain: read this preset's
magnitude as known to a factor of about 1.5. Tracks kept for 2,000 of 400,000
histories of the first version of the WCLL model (before its build was Noce's)
show where heavy histories come from:
neutrons that cross 30 to 50 cm of the back end and the vessel between
collisions arrive where the window is 100 to 850 times under their weight, and
neutrons with the weights of the inboard vessel's back (windows 13 to 15
e-foldings down) reach the outboard gap, the void beside the coil and the hall
200 to 700 times above the windows there, by the voids around the vessel. yamc
applies windows at collisions, so nothing splits either on the way, and in the
bioshield, outside the window mesh, nothing splits them at all. Finer voxels
would not change that, since a window falls the same 200-fold over a 40 cm
flight however finely it is sampled, and nor would energy groups: through the
WCLL back end and vessel the flux above 0.1 MeV falls at the same rate as the
total, within 8% (lambda 6.8 / 6.1 cm against 6.8 / 6.1 in the back end,
inboard / outboard, and 7.6 / 6.6 against 8.0 / 7.2 in the vessel). What would
is an importance that knows the streaming paths, such as adjoint (CADIS)
windows, which yamc does not generate.

The deep places are reached with weight windows on a mesh of 10 cm cubes over
the tokamak, one energy group, set from three runs per blanket: an analog run
whose midplane flux profile gives each layer's e-folding length on each side; a
run with windows from those, which reaches through the vessel and the coil and
measures the two voids no layer describes, the hall and the hole inside the
coil, each pooled over all its rings; and the production runs. The coil is
reached from the hole, the hall and the void where its outboard legs would be
as well as through the vessel, and the window map takes the easiest of those
ways. Before it did, the windows rouletted the neutrons crossing the coil up to
weights their neighbours did not have: on HCLL at 200,000 histories that change
took the bioshield total from 26% to 9.7% error and its tail slope from 1.8 to
2.7. DeGVR's generated windows were tried in the pilot and populated neither
the coil nor the bioshield.

Every run has a fixed seed and history count and no time limit. A run's
tallies come out the same to the last few bits however its threads finish
(4e-15 between two analog runs, with 4 and 8 threads), and the fitted lengths
are rounded to three figures before they set a window, so a rerun builds the
same windows and reproduces every result to those bits: the committed runs'
seeds 3 and 4 came out with the totals an earlier run of the same model gave
them. Unrounded, a window
that differed in its last bits flipped splits and roulettes, and two runs with
the same seed differed by 0.1% in the vessel's total and 1% in the coil's. The
generator refuses to write when a spectrum is short of its gate (99% of the
flux in groups under 5% error for the first wall, breeder zone and vessel, 80%
under 10% for the coil, 50% under 10% for the bioshield, and the runs
agreeing) unless it is given `--skip-gates`, and then the outputs say which
spectra are short.

### Data files

`spectra/data/<STRUCTURE>.csv`, one per neutron structure yamc and yani name
(XMAS-172, VITAMIN-J-175, SCALE-252, TRIPOLI-315, SHEM-361, LLNL-616, CCFE-709,
SCALE-999, UKAEA-1102, ECCO-1968), 2.4 MB in all. Each is its own tally
in the same runs rather than a collapse of a finer one: no structure's
boundaries are a subset of another's (the nearest, SCALE-252 in SCALE-999, is
three edges short), so a collapse would be inexact, and separate tallies keep
every group's error exact. Ten tallies cost about half as much again as one.
The header lines give the generator, the date, yamc-core, the data release, the
power, the seeds, the history counts, every spectrum's total, the totals of
the runs pooled into it and the uncertainty quoted; then a row per group in ascending energy: `group`,
`lower_eV`, `upper_eV`, and per tokamak spectrum its flux in n/cm2/s at full
power and `<key>_rel_err`, then the two emissions as shapes. The page does
not inline them, 6669 values a spectrum; the note under the presets links to
the folder.

### Limitations

- The section is rectangular, not D-shaped, and the layers are homogenised.
  There are no ports, divertor, central solenoid, PF coils or cryostat, and the
  outboard TF legs are left out so that a continuous coil shell does not shield
  the hall. The coil's top and bottom arms end at R0, where the void beside
  them feeds them.
- The bioshield value is an estimate, not a bound either way. With no ports or
  other penetrations there is nothing to stream through, which in a real
  machine raises the flux there; with no cryostat, outboard TF legs, PF coils
  or thermal shields, nothing shields the hall either, which lowers it. Its
  presets say so.
- Thermal scattering is free gas; the water and concrete thermal peaks move
  when yamc gains S(alpha,beta), and the generator is the thing to rerun then.
- yamc-core 0.16.3's `Torus` loses histories at the surfaces of nested tori
  (about 2%, "Surface crossed: unknown" with the particle on the surface;
  410 of 20,000 for four circular tori at R 9.07 m), which is why the shells
  are boxes. Moving to elliptical shells is local to `tokamak_model.py` once
  that is fixed.
- yamc-core 0.16.3's `Tally.units` says a mesh tally's flux is per cm3, but its
  mean is the track length in each bin; the generator divides by
  `mesh_element_volumes()` itself.

### Regenerating

```bash
pip install yamc numpy
python spectra/make_spectra.py --skip-gates --cache ~/.cache/yani-spectra
```

On 16 threads the four productions (six, two, four and two runs) took 80,
71, 69 and 20 minutes (HCPB, HCLL, WCLL, WCCB) and the eight calibration runs
7 minutes: about 4 h 10 min in all, on a machine heavily shared with other
work (load 20 to 60 on 32 cores).
`--skip-gates` is what wrote the committed files; without it the generator
refuses, because of the four spectra the Statistics table marks. The first run
downloads the transport data for the nuclides in these materials into
`~/.cache/yamc`. `--cache` keeps each production run's results and reuses them
while nothing that decides the transport has changed, so the outputs can be
rewritten in the few minutes the calibration takes; `--blankets`, `--scale`,
`--skip-gates`, `--out` and `--data` are for a quick look somewhere other than
the committed files, and a subset of the blankets is refused unless `--out`
and `--data` both point elsewhere.

### Checking it

`verify.mjs` checks the data rather than the physics: 22 presets in order, all
on CCFE-709, each a non-negative shape summing to one, labelled and grouped,
no two the same; a finite positive full-power flux on every tokamak preset and
none on the emissions; an uncertainty on every tokamak preset that its
description quotes, and a `shortOfGate` note exactly where the description
says it is short of its statistics gate; per blanket, the flux falling from the first wall
through the breeder zone to the vessel, with the coil and the bioshield below
the vessel; a first-wall flux between 1e14 and 2e15 that is more than half
above 0.1 MeV and under 5% thermal; a bioshield over 30% thermal; the emissions
narrow and the D-T one above the D-D one; the first walls and breeder zones
spread over 250 groups and carrying the uncollided source; and
`spectra/data/CCFE-709.csv`, normalised, equal to the presets to four figures,
with all ten files the right shape. In the browser it checks the dropdown
offers every preset in order under one heading per blanket, that the plotted
curve, the flux line with its uncertainty and the description follow the
selection, that a preset short of its gate says so on the page, that the flux
button fills every rate and is withdrawn where there is nothing to offer, and
that the Python export carries the magnitude, its uncertainty and any caveat.

## Irradiation scenarios

Two buttons under the schedule replace it with a whole irradiation, defined in
`src/schedules.js`:

- **One year, then cooling**: a year at the scenario's rate and ten cooling
  steps from a second to ten years, log-spaced. The page opens on the same
  rows at 1e14 n/cm2/s, built by the same call, so there is one definition;
  the button puts in the preset's full-power flux instead.
- **Five years at 80% availability, then cooling**: five calendar years read as
  4.0 full-power years, five 0.8 a pulses with four 0.2 a maintenance breaks
  between them, then twelve cooling steps from a second to a hundred years,
  since end-of-life waste is what a lifetime irradiation is for. Against one
  4 a pulse, or 5 a at 80% of the flux, the fluence and the long-lived
  inventory are the same; what differs is that the last step before shutdown
  runs at full power, so short-lived activity, dose and decay heat at shutdown
  are those of a running plant (5 a at 80% would understate them by a fifth),
  and nuclides with half-lives of weeks to a year see the breaks. Each 0.8 a
  is burn time at the full-power flux: DEMO's dwells between burns (2 h burns,
  0.5 h dwells) are not in it. Counted inside the 80% they would make it
  3.2 full-power years, a fifth less fluence; left out, they matter to the
  inventory only through half-lives of minutes to hours.

A scenario's pulses run at the selected preset's full-power flux when the
Preset tab is on one that has a magnitude, else at the table's first pulse's
rate, else 1e14. The rows stay editable, and nothing changes until a button is
pressed. `verify.mjs` checks both scenarios in Node, with durations converted by
the vendored solver's own `durationToSeconds` (the five pulses add up to 4.0 a,
shutdown at 4.8 a, the cooling log-even to 100 a), and in the browser that the
five-year button writes 21 rows at the preset's flux and that the Python export
carries all of them. With fixtures it also solves the five-year scenario at a
tokamak preset (21 steps, a positive peak) and exports and reopens that session,
before the temperature probe, so the restored preset, flux line and rows are
checked whether or not the run gets past that probe.

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

`node verify.mjs` is that check; it needs core's fixtures (`YANI_FIXTURES`, or
core's `fetch_test_fixtures.py`) and skips the form's own run without them. CI
has only what `scripts/fetch-fixtures.mjs` downloads, so there the form solves
once, in the Python tab's checks, where its numbers are held to the script's
(see "Checking it" under the Python tab).

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

The form reads the same release layout with its own fetch (`src/ranges.js` and
`app.js`, fusion-neutronics/yani-online#40), so the form and the tab read the
same files of the same release.

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
form's setup opened in the editor and run, drawing its five figures; the
form's own run of that setup, in a page whose data-origin requests are
answered from the same served release, giving the script's activity, decay
heat and contact dose at every step, to 1e-12; a figure line partway down a
script; completion of yani's names; tracebacks, Stop and share links; and that
nothing but Pyodide's CDN and PyPI is fetched from another origin. `--live`
also runs the iron example against the published release and compares it with
the native wheel's rows, and checks the byte ranges of the release that
`latest.json` names. With `YANI_FIXTURES=.fixtures` the form's own
transmutation checks are skipped, as they are in CI, since they need core's
fixtures in core's layout; the comparison with the script still runs.

Measured here on 2026-10-23 (yani-core 0.21.3 from PyPI, Pyodide 314.0.7,
Chromium): the first open of the tab starts Python in 2.1 to 2.6 s. The iron
example on the fixtures is 5.6 s, including plotly's install. Against the
published release (2026-10-12.1) it fetched **49.1 MB in 92 requests in 7 to
11 s**, on the deployed page as on a local copy, and printed the same values as
a native `pip install` of yani-core 0.21.3, to the last bit at every step
(5.9805e+14 Bq and 144.60 W at shutdown, Mn56; 1.9255e+13 Bq and 0.018027 W ten
years on, Fe55). Iron's closure reaches 20 nuclides with published cross
sections.

The wheel reads byte ranges only where every index entry it needs carries a
sha256 to check the bytes against. Release 2026-10-10.1's `version.json`s
carried the indexes without the hashes, so against it the same example fetched
whole files, 196.6 MB in 210 s, with Fe56's 39 MB `reactions.arrow` among them.
2026-10-12.1 carries the hashes. Against the fixtures, which `serve.mjs` gives
the hashes, the example fetches 21.7 MB.

**Same numbers as the form.** `verify.mjs` holds the form to the script on every
run, CI's included (above). Against the published release 2026-10-12.1, with
the page served from `localhost` and yani-core 0.21.3 on both sides, the form's
Fe56 setup (the default HCPB spectrum and schedule, 294 K) and its script in
the Python tab gave the same activity, decay heat and contact dose at all 11
steps, identical or within two units in the last place (218953519632458.25 Bq,
50.06054473676788 W and 7554.745102195669 Gy/h at shutdown in both), and a
native yani-core 0.21.3 run of the same script printed the script's values bit
for bit. The form's live run of that setup makes 5582 requests, and on
2026-10-23 the origin answered 429 after about a thousand of them in five
seconds, so it was run with 700 ms of latency added to each request.
