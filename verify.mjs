// End-to-end check: run a transmutation in a real browser and look at what it
// draws.
//
// The point is to exercise the page's own fetch path rather than a stub of it,
// so requests to the data origin are intercepted and answered from the local
// test fixtures. Everything else -- the wasm boot, the chain parse, the
// cross-section load, the solve, the plots -- is the real thing.
//
//   node verify.mjs [--headed] [--live [Nuclide ...]]
//
// `--live` adds a check against the real data origin: that the published
// byte-range indexes describe the published objects, that ranges are honoured,
// and that a stream spliced at one temperature is byte-for-byte the whole
// file's bytes. It is the only part that needs the network.
//
// Needs `node build.mjs` first, and core's fixtures:
//   python3 scripts/fetch_test_fixtures.py   (in core)

import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";

import {
  COALESCE_GAP, assembleNuclideData, energyRanges, kelvin, nearestTemperature, planEnergyFetch,
  planFetch, planNuclide, publishedTemperatures, rangeHeader, reactionRanges, spliceStream,
  checkFile, checkParts, parseLatest, parseManifest, sha256Hex, SUPPORTED_FORMAT_VERSIONS,
  wantedParts,
} from "./src/ranges.js";
import { SPECTRA } from "./src/spectra.js";

// Core's downloaded test fixtures. Override with YANI_FIXTURES; the default is
// a sibling checkout, which is where they land after
// `python3 scripts/fetch_test_fixtures.py` in core.
const FIXTURES = process.env.YANI_FIXTURES || "../core/crates/yamc/tests";
const CHAIN = `${FIXTURES}/transmutation-endf-b8.1-sfr.arrow`;
const ORIGIN = "https://yamc-data.xsplot.com";

// The release the fixtures are served as, under every library keyword.
const FIXTURE_RELEASE = "fixtures";

/// The fixtures as one data release, in the layout the origin publishes:
/// `latest.json` naming a release called `fixtures`, its `manifest.json`
/// listing every file with its size and sha256, and the files under
/// `<keyword>/fixtures/`. The same tree answers for every keyword, as the
/// unversioned routing before it did: the fixtures are ENDF/B-8.1's, and a
/// library change is checked by what it refetches, not by what it reads.
///
/// Only the files an activation load reads are listed: per nuclide its
/// `version.json`, `nuclide.arrow`, `energy.arrow` and `reactions.arrow`, and
/// the chain's subsections, which core's fixture keeps in directories named
/// without the `.arrow` the URL carries. Core's fixtures predate the per-batch
/// sha256 in the byte-range indexes (fusion-neutronics/core#323), so each
/// `version.json` is served with them added from the section it indexes, as
/// the converter writes them now; the page's per-batch check then runs on
/// every range it fetches here.
let fixtureRelease = null;
async function fixtureFiles() {
  if (fixtureRelease) return fixtureRelease;
  const files = new Map();
  const NEUTRON = ["version.json", "nuclide.arrow", "energy.arrow", "reactions.arrow"];
  for (const d of readdirSync(FIXTURES)) {
    if (!/^[A-Z][a-z]?\d+(_m\d+)?\.arrow$/.test(d) || !statSync(`${FIXTURES}/${d}`).isDirectory()) continue;
    for (const f of NEUTRON) {
      const file = `${FIXTURES}/${d}/${f}`;
      if (existsSync(file)) files.set(`neutron/${d}/${f}`, file);
    }
  }
  for (const sub of existsSync(CHAIN) ? readdirSync(CHAIN) : []) {
    if (!statSync(`${CHAIN}/${sub}`).isDirectory()) continue;
    for (const f of readdirSync(`${CHAIN}/${sub}`)) {
      if (/\.(arrow|json)$/.test(f)) files.set(`transmutation/${sub}.arrow/${f}`, `${CHAIN}/${sub}/${f}`);
    }
  }
  const bodies = new Map();
  const listed = [];
  for (const [path, file] of [...files].sort()) {
    let body = await readFile(file);
    if (path.endsWith("/version.json")) body = await withRangeHashes(body, file.slice(0, -"version.json".length));
    bodies.set(path, body);
    listed.push({ path, bytes: body.length, sha256: await sha256Hex(body) });
  }
  fixtureRelease = { bodies, listed };
  return fixtureRelease;
}

/// A `version.json` with a sha256 on every byte-range index entry, from the
/// sections in `folder` it indexes.
async function withRangeHashes(bytes, folder) {
  const version = JSON.parse(bytes);
  for (const [key, section, nested] of [["reaction_ranges", "reactions.arrow", true], ["energy_ranges", "energy.arrow", false]]) {
    const index = version[key];
    if (!index || !existsSync(`${folder}${section}`)) continue;
    const body = await readFile(`${folder}${section}`);
    const groups = nested ? Object.values(index.mts) : [index.temperatures];
    for (const entry of [index.schema, ...groups.flatMap((g) => Object.values(g))]) {
      if (entry.length < 3) entry[2] = await sha256Hex(body.subarray(entry[0], entry[0] + entry[1]));
    }
  }
  return Buffer.from(JSON.stringify(version));
}

/// The fixture answer to a data-origin URL, `{ path, body }`, or null for
/// anything the release does not carry. A URL in the unversioned layout the
/// page used before releases is null too, and counted by the caller.
async function fixtureBody(url) {
  const m = url.slice(ORIGIN.length + 1).match(/^([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, keyword, rest] = m;
  const { bodies, listed } = await fixtureFiles();
  const manifest = Buffer.from(JSON.stringify({
    schema: "yamc-data-manifest", keyword, release: FIXTURE_RELEASE, format_version: 2, files: listed,
  }));
  if (rest === "latest.json") {
    return {
      path: `${keyword}/latest.json`,
      body: Buffer.from(JSON.stringify({
        schema: "yamc-data-latest", keyword, release: FIXTURE_RELEASE, format_version: 2,
        manifest: `${FIXTURE_RELEASE}/manifest.json`, manifest_bytes: manifest.length,
        manifest_sha256: await sha256Hex(manifest),
      })),
    };
  }
  if (rest === `${FIXTURE_RELEASE}/manifest.json`) return { path: `${keyword}/${rest}`, body: manifest };
  const inRelease = rest.startsWith(`${FIXTURE_RELEASE}/`) && rest.slice(FIXTURE_RELEASE.length + 1);
  const body = inRelease && bodies.get(inRelease);
  return body ? { path: inRelease, body } : null;
}

const fail = (msg) => { console.error(`FAIL  ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`ok    ${msg}`);

const eq = (got, want, what) =>
  (got === want ? ok(`${what}: ${got}`) : fail(`${what}: got ${got}, wanted ${want}`));

const threw = (what, fn) => {
  try {
    fn();
    fail(`${what}: no error raised`);
  } catch {
    ok(`${what}: refused`);
  }
};

/// Pseudo-random bytes, so a cut in the wrong place cannot coincidentally match
/// the right one.
function noise(length, seed) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out[i] = seed & 0xff;
  }
  return out;
}

/// A stand-in reactions.arrow and energy.arrow, and the index over them.
///
/// 128 kB of noise for the reactions. The MTs are laid out to put every case
/// the fetch has to get right into one file:
///
///   MT 1     20 kB of transport total, wide enough to keep the schema out of
///            the same request
///   MT 16    wanted, at two temperatures that are two batches back to back,
///            and MT 102 wanted and touching them
///   MT 2     1 kB of elastic between two wanted batches: close enough to be
///            swallowed by the coalesce, and it must not reach the decoder. At
///            0 K, as ENDF/B-8.1 publishes it, which is the one label in a
///            real index that no activation channel is tabulated at.
///   MT 103   wanted, on the far side of it
///   MT 301   100 kB of heating, which is most of the file and none of the run
///
/// The index is keyed by MT and then by temperature, one batch per pair, the
/// shape core writes since fusion-neutronics/core#100. Every other MT here has
/// the one temperature.
///
/// The energy file is 32 kB of noise carrying a grid per label the reactions
/// use, plus the 0 K one, laid out the way the writer does: the schema, then
/// the grids back to back, with the 0 K grid first and wide enough to keep the
/// schema and the wanted grid in separate requests, as it is in the real files
/// (200 kB on Fe56).
///
/// Real published data exercises none of the swallowing: the writer puts the
/// activation MTs in contiguous runs, so on every ENDF/B-8.1 nuclide checked the
/// coalesce merges only ranges that already touch. That is why the case is built
/// here rather than measured there.
function synthetic() {
  return {
    file: noise(131072, 1),
    energyFile: noise(32768, 7),
    version: {
      reaction_ranges: {
        schema: [64, 64],
        mts: {
          1: { "294K": [128, 20000] },
          16: { "294K": [20128, 64], "600K": [20192, 64] },
          102: { "294K": [20256, 256] },
          2: { "0K": [20512, 1000] },
          103: { "294K": [21512, 64] },
          301: { "294K": [30000, 100000] },
        },
      },
      energy_ranges: {
        schema: [64, 64],
        temperatures: { "0K": [128, 20000], "294K": [20128, 300], "600K": [20428, 300] },
      },
    },
  };
}

/// Check the byte-range arithmetic, without a browser and without fixtures.
///
/// This is the part of the cross-section fetch with sums in it, and the part
/// whose failures are quiet: a range off by one splices a stream that still
/// decodes, out of bytes that mean something else.
function checkRanges() {
  const { file, energyFile, version } = synthetic();

  eq(reactionRanges(null), null, "no version.json is no index");
  eq(reactionRanges({}), null, "a version.json without the key is no index");
  eq(reactionRanges({ reaction_ranges: { schema: [64, 64], mts: { 16: [20128, 128] } } }), null,
     "an index from before the temperature split is no index");

  const ranges = reactionRanges(version);
  eq([...ranges.mts.get(16).keys()].join(","), "294K,600K", "the temperatures of an MT are read");
  const plan = planFetch(ranges, new Set([16, 102, 103]));
  eq(plan.full, 130000, "the file is as long as its last batch ends");

  // File order, not MT order, and the schema first whatever the sort would do.
  // Both temperatures of (n,2n) are wanted, since no temperature was named.
  eq(plan.parts.map((p) => p.off).join(","), "64,20128,20192,20256,21512", "parts in file order");

  // The schema is 20 kB clear of the first wanted batch, so it keeps its own
  // request. The four wanted batches and the elastic between them are one run.
  eq(plan.spans.length, 2, "five parts coalesce into two requests");
  eq(plan.spans[1].off, 20128, "the second span starts at (n,2n)");
  eq(plan.spans[1].len, 1448, "and runs to the end of (n,p), elastic included");
  eq(plan.bytes, 1512, "the transfer is the two spans");
  eq(plan.parts.reduce((n, p) => n + p.len, 0), 512, "of which 512 bytes are wanted");
  eq(plan.bytes < plan.full / 80, true, "which is under a hundredth of the file");

  // One temperature of one MT is one batch: the plotter's request, and the
  // reason the index carries the temperature axis at all.
  const one = planFetch(ranges, new Set([16]), COALESCE_GAP, new Set(["600K"]));
  eq(one.parts.map((p) => p.off).join(","), "64,20192", "one temperature of (n,2n) is its own batch");
  eq(one.parts.reduce((n, p) => n + p.len, 0), 128, "the schema and that batch");

  // A file written one batch per MT lists the same batch under each of its
  // temperatures; asking for both must fetch it once.
  const shared = reactionRanges({ reaction_ranges: { schema: [64, 64],
    mts: { 16: { "294K": [128, 100], "600K": [128, 100] } } } });
  eq(wantedParts(shared, new Set([16])).length, 2, "a batch shared by two temperatures is one part");

  // Elastic was fetched because it sat in the middle of a run. It has to be
  // dropped on the way into the stream rather than handed to the decoder: a
  // batch the loader was not asked for is a reaction it would fold into a rate.
  const bodies = plan.spans.map((s) => file.subarray(s.off, s.off + s.len));
  const stream = spliceStream(plan.parts, plan.spans, bodies);
  eq(stream.length, 512 + 8, "the stream is the wanted parts plus the marker");

  let at = 0;
  let exact = true;
  for (const part of plan.parts) {
    for (let i = 0; i < part.len; i++) {
      if (stream[at + i] !== file[part.off + i]) exact = false;
    }
    at += part.len;
  }
  eq(exact, true, "every spliced byte is the file's byte at that offset");
  eq([...stream.slice(-8)].join(","), "255,255,255,255,0,0,0,0", "the stream ends in the EOS marker");

  // A span that came back short would splice a stream whose framing still
  // walks, out of the wrong bytes. It has to be refused rather than trusted.
  threw("a short span", () => spliceStream(plan.parts, plan.spans, [bodies[0], bodies[1].subarray(0, 1400)]));
  threw("a missing span", () => spliceStream(plan.parts, plan.spans, [bodies[0], undefined]));

  // A nuclide publishing none of the wanted reactions plans nothing but a
  // schema, and that plan is kept rather than dropped: the solver reads a
  // schema-and-nothing-after-it stream as the empty subset it is, which is the
  // same zero reactions the whole file would have given once the MT filter ran.
  // He4 is the real case. So this is the plan that saves the most -- the whole
  // file -- and reading it as "fetch everything" would have inverted that.
  eq(planFetch(ranges, new Set([200])).parts.length, 1, "no wanted MT is a schema-only plan");

  // The header is inclusive at both ends, so a span of 64 bytes at offset 64
  // ends at 127 and not 128. One past would splice from a body a byte longer
  // than the span, one short would truncate every batch in the stream.
  eq(rangeHeader({ off: 64, len: 64 }), "bytes=64-127", "the range header is inclusive at both ends");
  eq(rangeHeader(plan.spans[1]), "bytes=20128-21575", "and covers the whole coalesced span");

  // The threshold is a tuning constant rather than a correctness one, so it is
  // stated rather than pinned. A zero would quietly turn every run of MTs back
  // into one request each, which is the thing it exists to prevent.
  eq(COALESCE_GAP > 0, true, "the coalesce threshold is set");

  // --- the energy grids, and choosing a temperature ---------------------

  eq(energyRanges({}), null, "a version.json without energy_ranges is no grid index");
  eq(energyRanges({ energy_ranges: { schema: [64, 64], temperatures: {} } }), null,
     "a grid index naming no temperature is no index");
  const grids = energyRanges(version);
  eq([...grids.temperatures.keys()].join(","), "0K,294K,600K", "every grid is indexed, the 0 K one included");

  // One temperature is the schema and that grid, two requests: the 0 K grid
  // between them is not wanted, and the merge does not reach across it.
  const grid = planEnergyFetch(grids, new Set(["294K"]));
  eq(grid.parts.map((p) => p.off).join(","), "64,20128", "one temperature's grid is the schema and one batch");
  eq(grid.spans.length, 2, "in two requests");
  eq(grid.bytes, 364, "of 364 bytes");
  eq(grid.full, 20728, "where the whole file runs to the end of the last grid");
  const gridStream = spliceStream(grid.parts, grid.spans,
    grid.spans.map((s) => energyFile.subarray(s.off, s.off + s.len)));
  eq(gridStream.length, 364 + 8, "and splices to those bytes plus the marker");
  eq(planEnergyFetch(grids, new Set(["1200K"])).parts.length, 1,
     "a grid the nuclide does not publish is simply absent");

  eq(kelvin("294K"), 294, "a label reads as Kelvin");
  eq(kelvin("293.6K"), 293.6, "with a decimal");
  eq(Number.isNaN(kelvin("room")), true, "and anything else does not");

  // The labels to choose among are the ones a wanted MT is tabulated at. The
  // 0 K label is real and indexed, and carries elastic scattering only: chosen,
  // it would plan a stream with every wanted channel absent, which the solver
  // reads as a nuclide that reacts at zero.
  eq([...publishedTemperatures(ranges, new Set([16, 102, 103]))].join(","), "294K,600K",
     "the candidate temperatures are those carrying a wanted MT");
  eq(publishedTemperatures(ranges, new Set([16, 102, 103])).has("0K"), false,
     "a label only elastic is tabulated at is not a candidate");

  const labels = ["294K", "600K"];
  eq(nearestTemperature(labels, 294), "294K", "an exact temperature is chosen");
  eq(nearestTemperature(labels, 500), "600K", "otherwise the nearest");
  eq(nearestTemperature(labels, 447), "294K", "and a tie goes to the lower");
  eq(nearestTemperature(labels, 5000), "600K", "far above every label is the highest");
  eq(nearestTemperature([], 294), null, "no label is no choice");
  eq(nearestTemperature(["warm"], 294), null, "a label that is not a temperature is never chosen");

  // The whole decision for one nuclide, as loadCrossSections takes it.
  const at294 = planNuclide(version, new Set([16, 102, 103]), 294);
  eq(at294.temperature, "294K", "the form's temperature is chosen when published");
  eq(at294.reactions.parts.map((p) => p.off).join(","), "64,20128,20256,21512",
     "the reactions are the wanted MTs at that temperature alone");
  eq(at294.energy.parts.map((p) => p.off).join(","), "64,20128", "and the grid is that temperature's");

  const at600 = planNuclide(version, new Set([16, 102, 103]), 600);
  eq(at600.temperature, "600K", "another temperature is another plan");
  eq(at600.reactions.parts.map((p) => p.off).join(","), "64,20192",
     "with the one wanted MT published there, and the others absent");
  eq(at600.energy.parts.map((p) => p.off).join(","), "64,20428", "and its own grid");

  // No reaction index is no narrowing of either file. The energy index alone
  // cannot be used: the whole reactions file carries every temperature, the
  // solver settles on the lowest of them, and a grid fetched for another label
  // would leave that one interpolating against nothing.
  const unindexed = planNuclide({ energy_ranges: version.energy_ranges }, new Set([16]), 294);
  eq(unindexed.temperature, null, "no reaction index chooses no temperature");
  eq(unindexed.reactions, null, "and fetches the reactions whole");
  eq(unindexed.energy, null, "and the grids whole");

  // A reaction index without a grid index narrows the reactions and fetches
  // the grids whole, which carry every temperature.
  const halfIndexed = planNuclide({ reaction_ranges: version.reaction_ranges }, new Set([16]), 294);
  eq(halfIndexed.temperature, "294K", "a reaction index alone still chooses a temperature");
  eq(halfIndexed.reactions.parts.length, 2, "and narrows the reactions");
  eq(halfIndexed.energy, null, "while the grids are fetched whole");

  // A nuclide publishing none of the wanted MTs: the reaction schema alone, and
  // one grid nearest the form's temperature, because the loader requires the
  // section for a nuclide whose nuclide.arrow lists temperatures.
  const inert = planNuclide(version, new Set([200]), 294);
  eq(inert.temperature, "294K", "with no wanted MT published the grid decides the label");
  eq(inert.reactions.parts.length, 1, "the reactions are a schema-only plan");
  eq(inert.energy.parts.map((p) => p.off).join(","), "64,20128", "and one grid is fetched");

  // A plan no smaller than the file is no plan: the whole file asked for plainly
  // is one request rather than one plus a splice.
  const single = planNuclide({
    reaction_ranges: { schema: [0, 8], mts: { 16: { "294K": [8, 8] } } },
    energy_ranges: { schema: [0, 8], temperatures: { "294K": [8, 8] } },
  }, new Set([16]), 294);
  eq(single.reactions, null, "a plan covering the whole reactions file is fetched whole");
  eq(single.energy, null, "and so is one covering the whole grid file");
}

/// Check the spectrum presets, without a browser.
///
/// They are generated data (spectra/make_spectra.py), so what can go wrong is
/// what goes wrong with data: a file half-written, a preset copied over another,
/// a shape that is not one. The physics of each is the generator's business and
/// is not re-derived here; what is checked is that the seven are seven, that each
/// is a shape on the same structure, and that the two emissions and the five
/// first-wall spectra sit where they should relative to each other.
function checkSpectra() {
  const keys = Object.keys(SPECTRA);
  eq(keys.length, 7, "seven spectrum presets");
  eq([...new Set(keys.map((k) => SPECTRA[k].structure))].join(","), "CCFE-709", "all on one structure");
  eq([...new Set(keys.map((k) => SPECTRA[k].values.length))].join(","), "709", "one value per group");
  let shapes = 0;
  for (const key of keys) {
    const { values, label, description } = SPECTRA[key];
    const sum = values.reduce((n, v) => n + v, 0);
    if (Math.abs(sum - 1) > 1e-3) fail(`${key} sums to ${sum}, not one`);
    else if (values.some((v) => !(v >= 0))) fail(`${key} has a negative or missing value`);
    else if (!label || !description) fail(`${key} has no label or description`);
    else shapes++;
  }
  eq(shapes, keys.length, "every preset is a non-negative shape summing to one, labelled");

  // A copy of one spectrum under five names passes everything above.
  const fingerprint = (k) => SPECTRA[k].values.map((v) => v.toExponential(3)).join();
  eq(new Set(keys.map(fingerprint)).size, keys.length, "no two presets are the same spectrum");

  // Where the mass sits. The groups ascend in energy, so the D-T emission peaks
  // in a higher group than the D-D one, and both are narrow: a Gaussian a few
  // hundred keV wide covers a handful of the 709 groups. A first-wall spectrum
  // is the same source after a blanket has scattered it, so it is spread over
  // hundreds of groups, and it still carries the uncollided source: the group
  // the D-T emission peaks in holds a good percent of every one of them. Not
  // its peak group, though. In the lithium-lead blankets the flux the breeder
  // reflects, multiplied by (n,2n) on lead and slowed by inelastic scattering,
  // outweighs the source at a few hundred keV, which is a finding rather than
  // a fault.
  const argmax = (k) => SPECTRA[k].values.indexOf(Math.max(...SPECTRA[k].values));
  const populated = (k) => SPECTRA[k].values.filter((v) => v > 1e-6).length;
  const sourceGroup = argmax("dt-plasma");
  eq(sourceGroup > argmax("dd-plasma"), true, "the D-T emission peaks above the D-D one");
  eq(populated("dt-plasma") < 40 && populated("dd-plasma") < 40, true, "the emissions are narrow");
  for (const key of keys.filter((k) => k.startsWith("fw-"))) {
    eq(populated(key) > 250, true, `${key} is spread across the structure`);
    eq(SPECTRA[key].values[sourceGroup] > 0.01, true, `${key} carries the uncollided source`);
  }
}

/// Check what gets handed to the solver, out of what came back.
///
/// The fetch answers in whatever order the network does, so this is where a
/// silent error would live: a span filed by arrival rather than by plan splices
/// a stream from the right bytes in the wrong order, and the loader reads that
/// without complaint. Every case is built with the spans deliberately out of
/// order for exactly that reason, and with both ranged files of one nuclide in
/// flight together, since a span of the grids filed under the reactions would
/// be the same silent error across files.
async function checkAssembly() {
  const { file, energyFile, version } = synthetic();
  const { reactions: plan, energy: grid } = planNuclide(version, new Set([16, 102, 103]), 294);
  const plans = new Map([["Fe56", new Map([["energy.arrow", grid], ["reactions.arrow", plan]])]]);
  const body = (i) => file.slice(plan.spans[i].off, plan.spans[i].off + plan.spans[i].len);
  const gridBody = (i) => energyFile.slice(grid.spans[i].off, grid.spans[i].off + grid.spans[i].len);
  const nuclideArrow = new Uint8Array([1, 2, 3]);

  // The jobs as loadCrossSections builds them, but with every second span
  // ahead of its first, which is what a slower first request looks like.
  const jobs = [
    { nuclide: "Fe56", file: "nuclide.arrow" },
    { nuclide: "Fe56", file: "energy.arrow", range: grid.spans[1], spanIndex: 1, status: 206 },
    { nuclide: "Fe56", file: "reactions.arrow", range: plan.spans[1], spanIndex: 1, status: 206 },
    { nuclide: "Fe56", file: "energy.arrow", range: grid.spans[0], spanIndex: 0, status: 206 },
    { nuclide: "Fe56", file: "reactions.arrow", range: plan.spans[0], spanIndex: 0, status: 206 },
  ];
  const arrived = [nuclideArrow, gridBody(1), body(1), gridBody(0), body(0)];

  const got = await assembleNuclideData(jobs, arrived, plans);
  eq(got.items.length, 3, "all three files are handed over");
  eq(got.missing.size, 0, "nothing is missing");
  eq(got.saved, (plan.full - plan.bytes) + (grid.full - grid.bytes), "the saving is both files less their spans");
  eq(got.stripped, false, "the ranges were honoured");

  const reactions = got.items.find((it) => it.file === "reactions.arrow").bytes;
  const wanted = spliceStream(plan.parts, plan.spans, [body(0), body(1)]);
  eq(reactions.length, wanted.length, "the spliced reactions are the expected length");
  eq(reactions.every((b, i) => b === wanted[i]), true,
     "spans out of order splice in plan order, not arrival order");
  const grids = got.items.find((it) => it.file === "energy.arrow").bytes;
  const wantedGrids = spliceStream(grid.parts, grid.spans, [gridBody(0), gridBody(1)]);
  eq(grids.every((b, i) => b === wantedGrids[i]) && grids.length === wantedGrids.length, true,
     "and the grids splice from their own spans, not the reactions'");

  // A span that never arrived. The nuclide has to be reported rather than given
  // a stream with a hole in it, whichever file the hole is in.
  const short = await assembleNuclideData(jobs, [nuclideArrow, gridBody(1), body(1), gridBody(0), undefined], plans);
  eq(short.items.some((it) => it.file === "reactions.arrow"), false, "a lost span hands over no stream");
  eq(short.items.some((it) => it.file === "energy.arrow"), true, "while the file that did arrive whole is handed over");
  eq(short.missing.has("Fe56"), true, "and the nuclide is reported missing");
  const noGrid = await assembleNuclideData(jobs, [nuclideArrow, undefined, body(1), gridBody(0), body(0)], plans);
  eq(noGrid.missing.has("Fe56"), true, "a lost span of the grids reports the nuclide too");

  // A proxy that stripped the header: 200 with the whole object rather than 206
  // with the slice. The body is the file, so it is used as the file.
  const stripped = await assembleNuclideData(
    [jobs[0], jobs[1], { ...jobs[2], status: 200 }, jobs[3], { ...jobs[4], status: 200 }],
    [nuclideArrow, gridBody(1), file, gridBody(0), file], plans);
  eq(stripped.stripped, true, "a 200 answer to a range is noticed");
  eq(stripped.items.find((it) => it.file === "reactions.arrow").bytes.length, file.length,
     "and the whole object is handed over as the file");
  eq(stripped.items.find((it) => it.file === "energy.arrow").bytes.length, wantedGrids.length,
     "while the file whose ranges were honoured is still spliced");
  eq(stripped.saved, grid.full - grid.bytes, "with only that file's saving claimed");
  eq(stripped.missing.size, 0, "and the nuclide is not reported missing");

  // A nuclide with no plan at all, which is what a library without an index
  // gives: every file passes straight through, and a 404 on any reports it.
  const plainJobs = [
    { nuclide: "Li6", file: "nuclide.arrow" },
    { nuclide: "Li6", file: "energy.arrow" },
    { nuclide: "Li6", file: "reactions.arrow" },
  ];
  const plain = await assembleNuclideData(plainJobs, [nuclideArrow, nuclideArrow, nuclideArrow], new Map());
  eq(plain.items.length, 3, "an unplanned nuclide hands over every file");
  eq(plain.saved, 0, "and saves nothing");
  // A 404 on the grids reports the nuclide too: core refuses a load with no
  // energy.arrow, so handing over the other two would fail later and less
  // clearly.
  const noGrids = await assembleNuclideData(plainJobs, [nuclideArrow, undefined, nuclideArrow], new Map());
  eq(noGrids.missing.has("Li6"), true, "a 404 on energy.arrow reports the nuclide");
  const gap = await assembleNuclideData(plainJobs, [nuclideArrow, nuclideArrow, undefined], new Map());
  eq(gap.missing.has("Li6"), true, "a 404 on the whole-file path reports the nuclide");
}

/// Check the sha256 checks: the per-batch hashes a byte-range index can carry
/// (fusion-neutronics/core#323), and the release pointer, manifest and whole
/// files. No browser and no network; WebCrypto is Node's.
async function checkHashes() {
  const { file, energyFile, version } = synthetic();
  const hashed = structuredClone(version);
  const add = async (entry, body) => entry.push(await sha256Hex(body.subarray(entry[0], entry[0] + entry[1])));
  await add(hashed.reaction_ranges.schema, file);
  for (const byTemperature of Object.values(hashed.reaction_ranges.mts)) {
    for (const entry of Object.values(byTemperature)) await add(entry, file);
  }
  await add(hashed.energy_ranges.schema, energyFile);
  for (const entry of Object.values(hashed.energy_ranges.temperatures)) await add(entry, energyFile);

  const index = reactionRanges(hashed);
  eq(index !== null && /^[0-9a-f]{64}$/.test(index.mts.get(16).get("294K").sha256), true,
     "a range index entry of [offset, length, sha256] is read with its hash");
  eq(reactionRanges(version).mts.get(16).get("294K").sha256, undefined, "and one of [offset, length] without");
  const badHash = structuredClone(hashed);
  badHash.reaction_ranges.mts[16]["294K"][2] = "not a hash";
  eq(reactionRanges(badHash), null, "a third element that is not a sha256 makes the index unusable");
  const four = structuredClone(hashed);
  four.reaction_ranges.mts[16]["294K"].push(0);
  eq(reactionRanges(four), null, "and so does a fourth element");

  const wanted = new Set([16, 102, 103]);
  const { reactions: plan, energy: grid } = planNuclide(hashed, wanted, 294);
  const plain = planNuclide(version, wanted, 294);
  eq(JSON.stringify(plan.spans), JSON.stringify(plain.reactions.spans), "the hashes change no span asked for");
  const plans = new Map([["Fe56", new Map([["energy.arrow", grid], ["reactions.arrow", plan]])]]);
  const slice = (bytes, s) => bytes.slice(s.off, s.off + s.len);
  const jobs = [
    ...grid.spans.map((range, spanIndex) => ({ nuclide: "Fe56", file: "energy.arrow", range, spanIndex, status: 206 })),
    ...plan.spans.map((range, spanIndex) => ({ nuclide: "Fe56", file: "reactions.arrow", range, spanIndex, status: 206 })),
  ];
  const bodies = [...grid.spans.map((sp) => slice(energyFile, sp)), ...plan.spans.map((sp) => slice(file, sp))];
  const got = await assembleNuclideData(jobs, bodies, plans);
  eq(got.checked, plan.parts.length + grid.parts.length, "every batch fetched by range is checked against its sha256");
  eq(got.items.length, 2, "and the checked streams are handed over");
  const unhashed = await assembleNuclideData(jobs, bodies,
    new Map([["Fe56", new Map([["energy.arrow", plain.energy], ["reactions.arrow", plain.reactions]])]]));
  eq(unhashed.checked, 0, "an index without hashes checks nothing and still splices");

  // One byte flipped inside a wanted batch, which the splice would hand over
  // without complaint since the framing still walks.
  const damaged = bodies.map((b) => b.slice());
  const part = plan.parts[1];
  const span = plan.spans.findIndex((sp) => part.off >= sp.off && part.off + part.len <= sp.off + sp.len);
  damaged[grid.spans.length + span][part.off - plan.spans[span].off] ^= 0xff;
  try {
    await assembleNuclideData(jobs, damaged, plans);
    fail("a batch that differs from its sha256 was spliced");
  } catch (e) {
    if (/do not match the sha256/.test(e.message)) ok(`a batch that differs from its sha256 is refused: ${e.message}`);
    else fail(`a damaged batch threw something else: ${e.message}`);
  }
  eq(await checkParts(plan, plan.spans.map((sp) => slice(file, sp)), "Fe56"), plan.parts.length, "checkParts counts what it checked");

  // The release pointer and manifest, the way the origin publishes them.
  const manifestBytes = new TextEncoder().encode(JSON.stringify({
    keyword: "endf-b8.1", release: "r1", format_version: 2,
    files: [{ path: "neutron/Fe56.arrow/reactions.arrow", bytes: file.length, sha256: await sha256Hex(file) }],
  }));
  const pointer = {
    keyword: "endf-b8.1", release: "r1", format_version: 2, manifest: "r1/manifest.json",
    manifest_bytes: manifestBytes.length, manifest_sha256: await sha256Hex(manifestBytes),
  };
  const latest = parseLatest(JSON.stringify(pointer), "endf-b8.1");
  eq(latest.release, "r1", "latest.json is read for its release");
  threw("a release in a format this solver does not read",
    () => parseLatest(JSON.stringify({ ...pointer, format_version: Math.max(...SUPPORTED_FORMAT_VERSIONS) + 1 }), "endf-b8.1"));
  threw("a latest.json without a manifest", () => parseLatest(JSON.stringify({ ...pointer, manifest: undefined }), "endf-b8.1"));
  const files = await parseManifest(manifestBytes, latest, "endf-b8.1");
  eq(files.get("neutron/Fe56.arrow/reactions.arrow").bytes, file.length, "the manifest is indexed by path");
  const refused = async (what, promise) => {
    try {
      await promise;
      fail(`${what}: accepted`);
    } catch {
      ok(`${what}: refused`);
    }
  };
  await refused("a manifest that is not the one latest.json names",
    parseManifest(manifestBytes, { ...latest, manifest_sha256: "0".repeat(64) }, "endf-b8.1"));
  const entry = files.get("neutron/Fe56.arrow/reactions.arrow");
  eq(await checkFile(file, entry, "reactions.arrow"), true, "a whole file is checked against its manifest line");
  const flipped = file.slice();
  flipped[5] ^= 1;
  await refused("a whole file that differs from its manifest line", checkFile(flipped, entry, "reactions.arrow"));
  eq(await checkFile(file, undefined, "reactions.arrow"), false, "and a file with no manifest line is not checked");
}

/// Check the byte-range fetch against the real origin.
///
/// Opt-in, with `node verify.mjs --live [Nuclide ...]`, because it needs the
/// network and downloads whole objects to compare against. What it proves is
/// the part no synthetic fixture can: that the published indexes describe the
/// published objects, that the origin honours the ranges asked of it, and that
/// a stream spliced at one temperature is byte-for-byte the bytes the
/// whole-file path would have read, for the reactions and for the grids.
///
/// Byte-exactness is the claim rather than "it decodes", because there is
/// nothing here that decodes Arrow. It was confirmed once with pyarrow that a
/// byte-exact splice of these ranges opens as a stream and yields record
/// batches, a fused table and (n,gamma) values identical to reading the whole
/// file, on Fe56, Li6, Cr52 and Pu239. That is a property of the format, so it
/// is recorded in dev-readme.md rather than re-run here. That a one-temperature
/// splice solves to the same answer as the whole file at that temperature is
/// checked by the browser run against the fixtures, where the solver is real.
async function checkLive(names) {
  const ORIGIN_LIVE = "https://yamc-data.xsplot.com";
  const library = "endf-b8.1";
  // The MTs a chain can name, which is the widest set the solver could ask for.
  // Hard-coded here and nowhere in the page: this is a check, and what the page
  // uses comes from the solver.
  const wantedMts = new Set([
    102, 18, 16, 17, 37, 152, 153, 160, 161, 103, 104, 105, 106, 107, 111, 108,
    109, 22, 28, 32, 33, 112, 117, 155, 115, 116, 182, 34, 11, 29, 23, 24, 25,
    30, 35, 36, 113, 114, 45, 158, 189, 41, 42, 44, 154, 193, 183, 184, 185,
    191, 192, 186, 187, 188, 156, 162, 163, 164, 157, 169, 170, 171, 172, 173,
    174, 175, 165, 166, 167, 168, 176, 177, 178, 179, 180, 181, 159, 190, 194,
    195, 196, 197, 198, 199, 200,
  ]);

  /// Fetch a plan's spans, requiring 206 with exactly the bytes asked for, and
  /// compare the splice against the object fetched whole.
  async function checkFile(nuclide, base, file, plan) {
    const bodies = [];
    for (const span of plan.spans) {
      const resp = await fetch(`${base}/${file}`, { headers: { Range: rangeHeader(span) } });
      if (resp.status !== 206) {
        fail(`${nuclide} ${file}: ${rangeHeader(span)} answered ${resp.status}, not 206`);
        return;
      }
      const body = new Uint8Array(await resp.arrayBuffer());
      if (body.length !== span.len) {
        fail(`${nuclide} ${file}: asked for ${span.len} bytes, got ${body.length}`);
        return;
      }
      bodies.push(body);
    }
    ok(`${nuclide} ${file}: ${plan.spans.length} ranges answered 206 exactly, ` +
       `${(plan.bytes / 1048576).toFixed(2)} MB of ${(plan.full / 1048576).toFixed(2)} MB ` +
       `(${(plan.full / plan.bytes).toFixed(1)}x less)`);

    const stream = spliceStream(plan.parts, plan.spans, bodies);
    const whole = new Uint8Array(await (await fetch(`${base}/${file}`)).arrayBuffer());

    // Every part, in the order the stream carries them, against the same bytes
    // of the object fetched whole.
    let at = 0;
    let exact = true;
    for (const part of plan.parts) {
      for (let i = 0; i < part.len; i++) {
        if (stream[at + i] !== whole[part.off + i]) exact = false;
      }
      at += part.len;
    }
    if (exact) ok(`${nuclide} ${file}: the spliced stream is the whole file's bytes at those offsets`);
    else fail(`${nuclide} ${file}: the spliced stream differs from the whole file`);
    eq(at + 8, stream.length, `${nuclide} ${file}: the stream is its parts plus the marker`);
  }

  for (const nuclide of names) {
    const base = `${ORIGIN_LIVE}/${library}/neutron/${nuclide}.arrow`;
    const version = await (await fetch(`${base}/version.json`)).json();
    const plan = planNuclide(version, wantedMts, 294);
    if (!plan.reactions) {
      fail(`${nuclide}: version.json carries no reaction_ranges this build can plan from`
        + (version.reaction_ranges
          ? " (it has one in the shape from before fusion-neutronics/core#100; reindex it)"
          : ""));
      continue;
    }
    ok(`${nuclide}: planned at ${plan.temperature} for 294 K`);
    await checkFile(nuclide, base, "reactions.arrow", plan.reactions);
    if (plan.energy) await checkFile(nuclide, base, "energy.arrow", plan.energy);
    else fail(`${nuclide}: version.json carries no energy_ranges, so the grids would be fetched whole`);
  }
}

async function main() {
  if (!existsSync("dist/index.html")) {
    console.error("dist/index.html missing -- run `node build.mjs` first");
    process.exit(2);
  }
  // First, and without a browser or a byte of nuclear data: the range
  // arithmetic the cross-section fetch is built on.
  checkRanges();
  await checkAssembly();
  await checkHashes();
  checkSpectra();
  if (process.argv.includes("--live")) {
    const named = process.argv.slice(2).filter((a) => !a.startsWith("--"));
    await checkLive(named.length ? named : ["Li6", "Al27"]);
  }
  // A transmutation needs core's nuclear-data fixtures, which are gigabytes and
  // are not present in CI. Everything before the first run does not: whether the
  // page boots, whether the solver starts, and whether it fetches anything it
  // should have carried are all answerable without a single nuclide. So the run
  // is skipped rather than the check failed, and the parts that still mean
  // something still run.
  const haveFixtures = existsSync(`${CHAIN}/decay/nuclides.arrow`);
  if (!haveFixtures) {
    console.log(`note  no fixtures at ${CHAIN}: skipping the transmutation`);
    console.log("note  set YANI_FIXTURES, or run fetch_test_fixtures.py in core");
  }

  // Only pin the binary when this environment ships one at a fixed path. On a
  // runner, `playwright install` puts it under ~/.cache/ms-playwright and
  // Playwright finds it itself; pointing at a path that does not exist there
  // fails the launch outright.
  const pinned = "/opt/pw-browsers/chromium";
  const browser = await chromium.launch({
    ...(existsSync(pinned) ? { executablePath: pinned } : {}),
    headless: !process.argv.includes("--headed"),
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1600 } });

  const errors = [];
  page.on("pageerror", (e) => errors.push(`PAGEERROR ${e.message}`));
  // The 404s are deliberate -- this fixture set covers a handful of nuclides
  // and the chain names hundreds -- so the browser logs one per miss. Filtering
  // them keeps the check meaningful; anything else is a real error.
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/status of 404/.test(m.text())) return;
    errors.push(m.text());
  });

  let served = 0;
  let missed = 0;
  // Anything the page asks for that is not nuclear data. The built file is
  // supposed to carry the solver and the plotting library inside it, and the
  // only way to know it does is to watch what it actually requests: the dev
  // fallback that fetches them from vendor/ is still present in the bundle as
  // dead code, so its absence cannot be grepped for.
  const foreign = [];
  page.on("request", (r) => {
    const url = r.url();
    // blob: is the page reading its own bytes back -- the worker source and the
    // wasm glue are handed to the browser as blobs because a Worker takes a URL
    // and a one-file page has no file to give it. Nothing leaves the machine.
    if (url.startsWith("file://") || url.startsWith("blob:") || url.startsWith(ORIGIN)) return;
    foreign.push(url);
  });
  // Range requests are answered the way the origin answers them, 206 with the
  // slice and a content-range. The page's cross-section fetch depends on that:
  // with an MT byte-range index it asks for reactions.arrow in pieces, and a
  // fixture server that ignored the header would hand back whole files, which
  // the page correctly takes as "the range was stripped" and falls back on. The
  // path under test would then never run while every check still passed.
  let ranged = 0;
  let rangedBytes = 0;
  // The whole size of each object a range was asked of, once per object. It is
  // what the same run would have downloaded before the index existed, and
  // without it the transfer below is a number with nothing to be small against.
  const rangedFull = new Map();
  // Requests in the unversioned layout from before releases, which the page
  // should no longer make at all.
  let unversioned = 0;
  await page.route(`${ORIGIN}/**`, async (route) => {
    const found = await fixtureBody(route.request().url());
    if (!/^[^/]+\/(latest\.json|fixtures\/)/.test(route.request().url().slice(ORIGIN.length + 1))) unversioned++;
    const path = found && found.path;
    if (!found) {
      // A 404 is the honest answer for a nuclide this fixture set does not
      // carry, and exercising it is the point: the page has to survive gaps.
      missed++;
      await route.fulfill({ status: 404, body: "" });
      return;
    }
    served++;
    const body = found.body;
    const want = (route.request().headers().range || "").match(/^bytes=(\d+)-(\d+)$/);
    if (!want) {
      await route.fulfill({ status: 200, body });
      return;
    }
    const start = Number(want[1]);
    const end = Math.min(Number(want[2]), body.length - 1);
    ranged++;
    rangedBytes += end - start + 1;
    rangedFull.set(path, body.length);
    await route.fulfill({
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${body.length}` },
      body: body.subarray(start, end + 1),
    });
  });

  await page.goto(`file://${process.cwd()}/dist/index.html`);
  await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"), null, { timeout: 30000 });
  ok("page boots and the solver starts");

  // Where the solver started, which is the whole point of the worker: a page
  // that boots and answers is not evidence of anything if it is answering from
  // the thread that paints.
  const workers = page.workers();
  if (workers.length) ok(`the solver runs in a Worker (${workers[0].url().slice(0, 22)}…)`);
  else fail("no Worker was created -- the solve would block the UI");

  // The layout: the spectrum ahead of the material in both columns, and the
  // inventory under the material's make-up rather than among the results, so
  // the material before and the material after are two bar charts a glance
  // apart. Checked by document order, which is what a reader scrolls.
  const layout = await page.evaluate(() => {
    const before = (a, b) => Boolean(document.getElementById(a).compareDocumentPosition(document.getElementById(b)) & Node.DOCUMENT_POSITION_FOLLOWING);
    const panel = (id) => document.getElementById(id).closest(".panel");
    return {
      inputsOrdered: before("spectrum-panel", "material-panel"),
      viewsOrdered: before("plot-spectrum", "plot-material"),
      inventoryWithMaterial: panel("plot-inventory") === panel("plot-material") && before("plot-material", "plot-inventory"),
      inventoryHidden: document.getElementById("material-steps").hidden,
    };
  });
  eq(layout.inputsOrdered, true, "the spectrum inputs come before the material inputs");
  eq(layout.viewsOrdered, true, "and the spectrum plot before the material plot");
  eq(layout.inventoryWithMaterial, true, "the inventory sits under the material's make-up");
  eq(layout.inventoryHidden, true, "and is hidden until there are results");

  // The material as built is drawn before any run, from the solver's own
  // expansion of the form: natural iron is four isotopes, and their atom
  // fractions add to a hundred. It follows the form, so a single nuclide is
  // one bar, and a compendium material is many. The page opens on the
  // compendium tab with nothing picked, where there is no material to draw
  // and the line under the chart says so; the custom tab carries iron.
  const materialBars = () => page.$eval("#plot-material", (el) => ({
    names: el.data[0].y.slice(),
    fractions: el.data[0].x.slice(),
    title: el.layout.title.text,
  }));
  const unpicked = await page.textContent("#material-status");
  if (/No material to show/.test(unpicked)) ok("with nothing picked, the material panel says so");
  else fail(`the material line before a pick reads: ${unpicked}`);
  await page.click('[data-tab="custom"]');
  await page.waitForFunction(() => {
    const el = document.getElementById("plot-material");
    return el.data && el.data[0].y.length === 4;
  }, null, { timeout: 10000 }).then(
    () => ok("the material's make-up is drawn before any run"),
    () => fail("the material chart did not draw natural iron"),
  );
  const iron = await materialBars();
  eq([...iron.names].sort().join(","), "Fe54,Fe56,Fe57,Fe58", "natural iron expands to its four isotopes");
  const ironTotal = iron.fractions.reduce((n, v) => n + v, 0);
  if (Math.abs(ironTotal - 100) < 1e-6) ok("whose atom fractions add to a hundred");
  else fail(`the atom fractions add to ${ironTotal}`);
  eq(iron.title, "Material as built: 4 nuclides", "and the title counts them");
  const ironStatus = await page.textContent("#material-status");
  if (/4 nuclides, 7\.87 g\/cm3, .* atom\/barn-cm in all, 1000 cm3, 7870 g/.test(ironStatus)) {
    ok("and the line under it adds the material up");
  } else {
    fail(`the material line reads: ${ironStatus}`);
  }
  await page.click('[data-tab="pnnl"]');

  // The spectrum is an input, so it is drawn before anything has been run and
  // before any nuclear data exists to draw it from. Checked here rather than
  // after the run, because after the run a plot that only ever appeared with
  // results would pass too.
  const spectrumBefore = await page.$eval("#plot-spectrum", (el) => (el.data ? el.data.length : 0));
  if (spectrumBefore > 0) ok("the neutron spectrum is plotted before any run");
  else fail("no spectrum drawn before the run");

  // The scale toggles, checked by their effect rather than their presence: a
  // select that renders and changes nothing is the failure this is for. The
  // spectrum's is the one that works before a run.
  const flipped = await page.evaluate(async () => {
    const select = document.querySelector('.axis-scale[data-for="plot-spectrum"] select');
    select.value = "linear";
    select.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 300));
    const type = document.getElementById("plot-spectrum").layout.xaxis.type;
    select.value = "log";
    select.dispatchEvent(new Event("change"));
    return type;
  });
  if (flipped === "linear") ok("an axis scale toggle changes the axis");
  else fail(`toggling the spectrum's x scale left it '${flipped}'`);

  // The default schedule: a pulse, then ten cooling steps whose cumulative
  // times run log-evenly from a second to ten years. Read off the table as a
  // user would, since the rows are what the run is built from. Rounded to
  // three figures for display, so the ratio between consecutive times is
  // constant to a percent or so rather than exactly.
  const SECONDS = { s: 1, min: 60, h: 3600, d: 86400, a: 365.25 * 86400 };
  const schedule = await page.$$eval("#schedule tr", (trs) => trs.map((tr) => ({
    kind: tr.children[0].textContent.trim(),
    value: Number(tr.querySelector('input[data-k="value"]').value),
    unit: tr.querySelector('select[data-k="unit"]').value,
  })));
  const cooling = schedule.filter((s) => s.kind === "Cooldown");
  eq(schedule[0].kind, "Pulse", "the default schedule starts with a pulse");
  eq(cooling.length, 10, "and has ten cooling steps");
  const cumulative = [];
  for (const step of cooling) {
    cumulative.push((cumulative.at(-1) || 0) + step.value * SECONDS[step.unit]);
  }
  const ratios = cumulative.slice(1).map((t, i) => t / cumulative[i]);
  const logEven = ratios.every((r) => Math.abs(r / ratios[0] - 1) < 0.03);
  if (Math.abs(cumulative[0] - 1) < 1e-9 && Math.abs(cumulative.at(-1) / (10 * SECONDS.a) - 1) < 0.01 && logEven) {
    ok(`the cooling times run log-evenly from 1 s to 10 a (ratio ${ratios[0].toFixed(2)} per step)`);
  } else {
    fail(`the cooling times are ${cumulative.map((t) => t.toExponential(2)).join(", ")} s`);
  }

  // The Python export. Checked by reading what it actually writes: the failure
  // that matters is a script that downloads but does not describe the setup on
  // screen, which a "did the click work" check would pass.
  // A material first: with none chosen the export refuses, which is correct --
  // there is no setup to describe -- and is checked immediately after.
  await page.selectOption("#pnnl-select", { index: 0 });
  await page.waitForFunction(() => {
    const el = document.getElementById("plot-material");
    return el.data && el.data[0].y.length > 4;
  }, null, { timeout: 10000 }).then(
    () => ok("a compendium material draws its many nuclides"),
    () => fail("the material chart did not follow the compendium pick"),
  );
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#download-python"),
  ]);
  const script = await new Promise((resolve, reject) => {
    download.createReadStream().then((stream) => {
      let text = "";
      stream.on("data", (chunk) => { text += chunk; });
      stream.on("end", () => resolve(text));
      stream.on("error", reject);
    }, reject);
  });
  const rows = await page.$$eval("#schedule tr", (trs) => trs.length);
  const wants = [
    ["import yani", /^import yani$/m],
    ["a material", /^material = yani\./m],
    ["the spectrum", /yani\.sources\.Histogram\(/],
    // By the structure's name, not 710 inlined boundaries: the preset is a flux
    // on CCFE-709 and the wheel resolves that itself.
    ["the group structure", /yani\.sources\.Histogram\("CCFE-709", flux\)/],
    ["the schedule", /yani\.PulseSchedule\(\[/],
    ["the run", /material\.transmute\(schedule=schedule\)/],
    // At its defaults, which is the point: those defaults are what the page
    // reports, so a script that passed its own would quietly disagree with the
    // chart it is meant to reproduce.
    ["the contact dose", /m\.contact_dose\(by_nuclide=True\)/],
    // The temperature the page fetched at, so the script reads the same one
    // rather than the library's lowest, which is what the wheel settles on when
    // a material names none.
    ["the temperature", /^material\.temperature = 294\b/m],
    ["plotly", /^import plotly\.graph_objects as go$/m],
  ];
  const missing = wants.filter(([, pattern]) => !pattern.test(script)).map(([name]) => name);
  const steps = (script.match(/^ {4}\("(pulse|cooldown)"/gm) || []).length;
  if (download.suggestedFilename() !== "yani_run.py") {
    fail(`the export is named ${download.suggestedFilename()}`);
  } else if (missing.length) {
    fail(`the exported script is missing: ${missing.join(", ")}`);
  } else if (steps !== rows) {
    fail(`the exported schedule has ${steps} steps against ${rows} on screen`);
  } else {
    ok(`the Python export describes the setup (${steps} schedule steps)`);
  }

  // Refusing is part of the contract: an export written from an empty form
  // would be a script that cannot run, handed over as though it could.
  await page.click('[data-tab="custom"]');
  const before = await page.$eval("#composition input[data-k='name']", (el) => el.value);
  await page.fill("#composition input[data-k='name']", "");
  await page.click("#download-python");
  await page.waitForTimeout(200);
  const refused = await page.$eval("#warning", (el) => !el.hidden && el.textContent);
  if (refused && /composition is empty/.test(refused)) ok("an empty composition is refused, not exported");
  else fail(`an empty composition exported anyway (warning: ${refused || "none"})`);
  await page.fill("#composition input[data-k='name']", before);
  await page.click('[data-tab="pnnl"]');

  // The presets are offered from the data, so the dropdown has to carry every
  // one of them, and the spectrum has to follow the form rather than being
  // drawn once. Every preset has the same group count now, so the curve itself
  // is compared: the unmoderated emission and a first-wall spectrum share no
  // more than their peak.
  const offered = await page.$$eval("#spectrum-preset option", (opts) => opts.map((o) => o.value));
  eq(offered.join(","), Object.keys(SPECTRA).join(","), "the dropdown offers every preset in order");
  const curve = () => page.$eval("#plot-spectrum", (el) => JSON.stringify(el.data[0].y.slice(0, 200)));
  const firstWall = await curve();
  await page.selectOption("#spectrum-preset", "dt-plasma");
  await page.waitForFunction(
    (before) => document.getElementById("spectrum-status").textContent.startsWith("709 groups")
      && JSON.stringify(document.getElementById("plot-spectrum").data[0].y.slice(0, 200)) !== before,
    firstWall, { timeout: 5000 },
  ).then(
    () => ok("the spectrum follows the preset, on 709 groups"),
    () => fail("the spectrum did not follow the preset"),
  );
  await page.selectOption("#spectrum-preset", offered[0]);

  if (haveFixtures) {
  // A single-nuclide material, so the fixture set covers the seed even though
  // it cannot cover the whole closure.
  await page.click('[data-tab="custom"]');
  await page.fill('#composition input[data-k="name"]', "Fe56");
  await page.fill("#density", "7.874");
  await page.fill("#volume", "1000");
  await page.waitForFunction(() => {
    const el = document.getElementById("plot-material");
    return el.data && el.data[0].y.length === 1 && el.data[0].y[0] === "Fe56";
  }, null, { timeout: 10000 }).then(
    () => ok("a single nuclide draws as one bar"),
    () => fail("the material chart did not follow the composition to Fe56"),
  );

  // Count frames while the run happens, and count separately those painted
  // while the solve is in flight. A solve on the main thread paints none: the
  // status says "Solving" and then nothing moves until wasm returns. So the
  // second number is a direct test of where the solve ran, and unlike a timing
  // threshold it does not depend on how big the fixture set is.
  //
  // Measured inside the page rather than by polling over CDP: the fetch phase
  // makes over a thousand intercepted requests, and the interception delays
  // replies on the same channel by seconds, which reads as a freeze that the
  // page is not having.
  await page.evaluate(() => {
    const status = document.getElementById("status");
    const live = { frames: 0, solving: 0, worstGap: 0, last: performance.now() };
    window.__liveness = live;
    const tick = () => {
      const now = performance.now();
      live.worstGap = Math.max(live.worstGap, now - live.last);
      live.last = now;
      live.frames++;
      if (status.textContent.startsWith("Solving")) live.solving++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.click("#run");
  await page.waitForFunction(
    () => document.getElementById("status").textContent.startsWith("Done"),
    null, { timeout: 300000 },
  );
  ok(`run fetched and solved (${served} fixture responses, ${missed} 404s survived)`);
  // Every file through the release: the pointer, the manifest, and paths
  // under the release folder. Nuclides the manifest does not list are not
  // asked for at all, so the 404s above are what is left after that.
  eq(unversioned, 0, "requests outside the release layout");

  // Whether the run fetched MTs or whole files. Both are correct -- the whole
  // file is the fallback and has to keep working -- so this reports rather than
  // gates, and says which of the two preconditions is missing when it is the
  // fallback that ran, because "no range requests" on its own reads as a bug.
  if (ranged) {
    const full = [...rangedFull.values()].reduce((n, v) => n + v, 0);
    ok(
      `fetched byte ranges: ${ranged} requests, ` +
      `${(rangedBytes / 1048576).toFixed(1)} MB of ${(full / 1048576).toFixed(1)} MB ` +
      `across ${rangedFull.size} objects`);
    // Both files, or the grids are still coming down whole: at one temperature
    // the grids are a sixth of what they were, and a fetch that left them whole
    // would pass every check above while paying most of the old bill.
    for (const file of ["reactions.arrow", "energy.arrow"]) {
      const objects = [...rangedFull.keys()].filter((path) => path.endsWith(`/${file}`)).length;
      if (objects) ok(`  ${file}: ${objects} objects fetched by range`);
      else fail(`  ${file}: fetched whole rather than by range`);
    }
  } else {
    const sample = `${FIXTURES}/Fe56.arrow/version.json`;
    const version = existsSync(sample) ? JSON.parse(await readFile(sample, "utf8")) : {};
    // Planned from, not merely present: a fixture carrying the one-level index
    // from before fusion-neutronics/core#100 has the key and is still no index
    // to this build, and blaming the solver for that reads as the wrong bug.
    const indexed = reactionRanges(version) !== null;
    const stale = !indexed && Boolean(version.reaction_ranges);
    const from = (await readFile("vendor/CORE_COMMIT", "utf8")).trim().slice(0, 8);
    console.log(
      `skip  MT byte ranges: ${indexed
        ? `the solver vendored from core ${from} cannot say which MTs a chain needs (core#527)`
        : stale
          ? "these fixtures carry the reaction_ranges shape from before "
            + "fusion-neutronics/core#100 -- run core's index_reactions over them"
          : "these fixtures carry no reaction_ranges -- run core's index_reactions over them"}`);
  }

  const live = await page.evaluate(() => window.__liveness);
  if (!live.frames) {
    fail("no frames were painted at all -- liveness could not be measured");
  } else if (!live.solving) {
    fail("no frame was painted while the solve was in flight: it ran on the main thread");
  } else {
    // The worst gap is reported rather than gated. Plotting four charts is
    // main-thread work by nature and costs a couple of hundred milliseconds;
    // the number worth watching is whether it grows, not whether it is zero.
    ok(`UI stayed live: ${live.solving} frames painted during the solve, ` +
       `worst gap ${live.worstGap.toFixed(0)} ms`);
  }

  const warning = await page.textContent("#warning");
  if (!/No cross sections published for/.test(warning || "")) {
    fail("missing nuclides should be reported, not swallowed");
  } else {
    ok("missing nuclides are named in the warning");
  }

  // Re-running must not refetch. The data a run needs is decided by the
  // material, so iterating on a schedule has to be free.
  const before = served + missed;
  await page.click("#run");
  await page.waitForFunction(
    () => document.getElementById("status").textContent.startsWith("Done"),
    null, { timeout: 120000 },
  );
  if (served + missed === before) ok("a second run refetches nothing");
  else fail(`second run made ${served + missed - before} requests; should make none`);

  // The charts have to have actually drawn, not merely been asked to.
  for (const id of ["plot-activity", "plot-heat", "plot-inventory", "plot-photons"]) {
    const traces = await page.$eval(`#${id}`, (el) => el.data ? el.data.length : 0);
    if (traces > 0) ok(`${id} drew ${traces} traces`);
    else fail(`${id} drew nothing`);
  }

  // The controls above a series chart: how many nuclides it names, whether
  // the total is drawn, whether the nuclides are. Read off the activity chart
  // by what it draws, since a control that renders and changes nothing is the
  // failure this is for. The fixture set gives iron more than four products,
  // so "Other" is non-empty at four and the count has room to move both ways.
  const control = (name) => `.axis-scale[data-for="plot-activity"] [data-control="${name}"]`;
  const drawn = () => page.$eval("#plot-activity", (el) => ({
    names: el.data.map((t) => t.name),
    first: Object.fromEntries(el.data.map((t) => [t.name, t.y[0]])),
  }));
  const namedCount = (d) => d.names.filter((n) => n !== "Other" && n !== "total").length;
  const opening = await drawn();
  eq(namedCount(opening), 4, "a series chart opens naming four nuclides");
  eq(opening.names.includes("Other"), true, "with the rest as Other");
  eq(opening.names.includes("total"), true, "and the total drawn with them");
  await page.selectOption(control("named"), "2");
  await page.waitForTimeout(300);
  eq(namedCount(await drawn()), 2, "the count control names fewer");
  await page.selectOption(control("named"), "8");
  await page.waitForTimeout(300);
  const eight = await drawn();
  eq(namedCount(eight) >= 5 && namedCount(eight) <= 8, true, `and more (${namedCount(eight)} at eight)`);
  await page.selectOption(control("named"), "4");
  await page.waitForTimeout(300);
  const withTotal = await drawn();
  // Summed from the drawn traces, which the log floor has cut six decades
  // below the peak, so the sum runs a few parts in a billion short of the
  // total: within a hundred thousandth is the floor's dust and no more.
  const summed = withTotal.names.filter((n) => n !== "total").reduce((n, k) => n + (withTotal.first[k] || 0), 0);
  if (withTotal.names.includes("total") && Math.abs(withTotal.first.total / summed - 1) < 1e-5) {
    ok("the total is the sum of the nuclides and Other");
  } else {
    fail(`the chart drew ${withTotal.names.join(", ")}, total ${withTotal.first.total} against a sum of ${summed}`);
  }
  await page.uncheck(control("byNuclide"));
  await page.waitForTimeout(300);
  eq((await drawn()).names.join(","), "total", "the by-nuclide box off leaves the total alone");
  await page.check(control("byNuclide"));
  await page.uncheck(control("total"));
  await page.waitForTimeout(300);
  const nuclidesOnly = await drawn();
  eq(namedCount(nuclidesOnly) === 4 && !nuclidesOnly.names.includes("total"), true, "the total box off leaves the nuclides alone");
  await page.check(control("total"));
  await page.waitForTimeout(300);
  eq((await drawn()).names.includes("total") && namedCount(await drawn()) === 4, true, "and the chart comes back as it opened");

  // The decay charts plot time after shutdown, so the ten cooling points of the
  // default schedule spread evenly across the log axis instead of bunching
  // against the end of the year of irradiation; the pulse itself sits at zero,
  // which a log axis leaves off. Checked on the activity chart's x values, and
  // on the marks it labels the axis with, which are the units a reader thinks
  // in rather than powers of ten of years.
  const axis = await page.$eval("#plot-activity", (el) => ({
    x: el.data[0].x.slice(),
    ticks: el.layout.xaxis.ticktext ? el.layout.xaxis.ticktext.slice() : [],
    title: el.layout.xaxis.title.text,
  }));
  const afterShutdown = axis.x.filter((t) => t > 0);
  const xRatios = afterShutdown.slice(1).map((t, i) => t / afterShutdown[i]);
  if (axis.x.length === schedule.length && axis.x[0] <= 0 && afterShutdown.length === cooling.length
      && xRatios.every((r) => Math.abs(r / xRatios[0] - 1) < 0.03)) {
    ok("the activity chart plots the cooling steps log-evenly after shutdown");
  } else {
    fail(`the activity chart's x is ${axis.x.map((t) => t.toExponential(2)).join(", ")}`);
  }
  eq(axis.ticks.join(" "), "1 s 1 min 1 h 1 d 30 d 1 a 10 a", "and marks the axis in units a reader thinks in");
  eq(axis.title, "time after shutdown", "under the right name");

  // The inventory has a slider of its own, like the photon lines, and its x
  // axis holds still across the steps for the same reason: a bar's length has
  // to mean the same thing at every step for two steps to be comparable. The
  // first step and the last differ in what they show, since the trace products
  // of the first hour are gone by ten years.
  const inventory = () => page.$eval("#plot-inventory", (el) => ({
    title: el.layout.title.text,
    range: JSON.stringify(el.layout.xaxis.range),
    bars: el.data[0].y.slice(),
  }));
  const setInventoryStep = async (i) => {
    await page.evaluate((i) => {
      const slider = document.getElementById("inventory-step");
      slider.value = String(i);
      slider.dispatchEvent(new Event("input"));
    }, i);
    await page.waitForTimeout(250);
  };
  eq(await page.$eval("#material-steps", (el) => el.hidden), false, "the inventory is shown once there are results");
  const inventorySteps = await page.$eval("#inventory-step", (el) => Number(el.max) + 1);
  eq(inventorySteps, schedule.length, "the inventory slider has a step per result");
  const lastInventory = await inventory();
  eq(lastInventory.title, `Inventory at step ${inventorySteps}`, "the inventory opens on the last step");
  const inventoryMoved = [];
  for (let i = 0; i < inventorySteps; i++) {
    await setInventoryStep(i);
    if ((await inventory()).range !== lastInventory.range) inventoryMoved.push(i + 1);
  }
  if (!inventoryMoved.length) ok("the inventory x axis holds still across the steps");
  else fail(`the inventory x axis moved at steps ${inventoryMoved.join(", ")}`);
  await setInventoryStep(0);
  const firstInventory = await inventory();
  eq(firstInventory.title, "Inventory at step 1", "the slider changes the inventory's step");
  eq(firstInventory.bars.join() !== lastInventory.bars.join(), true, "and the first step's inventory differs from the last");
  await setInventoryStep(inventorySteps - 1);

  // The photon x axis holds still while the slider walks the steps. Its range
  // is set from every step's lines rather than the one drawn, so the reader
  // sees where the whole spectrum lives and nothing jumps as they scroll, and
  // a zoom they make persists across steps. Each is checked by moving the
  // slider, because the failure is one a single drawn step cannot show.
  const photonAxis = () => page.$eval("#plot-photons", (el) => ({
    range: JSON.stringify(el.layout.xaxis.range),
    type: el.layout.xaxis.type,
    yRange: JSON.stringify(el.layout.yaxis.range),
    yType: el.layout.yaxis.type,
    // The marker trace carries one point per line, in MeV and photons/s.
    lines: el.data[1].x.slice(),
    intensities: el.data[1].y.slice(),
  }));
  const setPhotonStep = async (i) => {
    await page.evaluate((i) => {
      const slider = document.getElementById("photon-step");
      slider.value = String(i);
      slider.dispatchEvent(new Event("input"));
    }, i);
    await page.waitForTimeout(250);
  };
  const stepCount = await page.$eval("#photon-step", (el) => Number(el.max) + 1);
  const initial = await photonAxis();
  const [lo, hi] = JSON.parse(initial.range);
  const [yLo, yHi] = JSON.parse(initial.yRange);
  const moved = [];
  const movedY = [];
  let outside = 0;
  let outsideY = 0;
  let peaks = 0;
  for (let i = 0; i < stepCount; i++) {
    await setPhotonStep(i);
    const axis = await photonAxis();
    if (axis.range !== initial.range) moved.push(i + 1);
    if (axis.yRange !== initial.yRange) movedY.push(i + 1);
    // A log axis's range is in decades; the lines are in MeV and photons/s
    // either way.
    for (const x of axis.lines) {
      const v = axis.type === "log" ? Math.log10(x) : x;
      if (v < lo || v > hi) outside++;
    }
    for (const y of axis.intensities) {
      const v = axis.yType === "log" ? Math.log10(y) : y;
      if (v < yLo || v > yHi) outsideY++;
    }
    // The y range is set from the strongest line of the whole run, so at
    // least one step's strongest has to come close to its top: an axis with
    // decades of empty headroom passes the containment check and is still
    // wrong.
    const strongest = Math.max(...axis.intensities);
    const top = axis.yType === "log" ? Math.log10(strongest) : strongest;
    if (top > yHi - 1.5) peaks++;
  }
  if (!moved.length) ok(`the photon x axis holds still across ${stepCount} steps`);
  else fail(`the photon x axis moved at steps ${moved.join(", ")}`);
  if (!outside) ok("and its initial range covers every step's lines");
  else fail(`${outside} photon lines fall outside the initial x range`);
  if (!movedY.length) ok("the photon y axis holds still across the steps too");
  else fail(`the photon y axis moved at steps ${movedY.join(", ")}`);
  if (!outsideY && peaks) ok("and its initial range is set from the strongest line of the run");
  else fail(`${outsideY} photon lines fall outside the initial y range, ${peaks} steps reach its top`);

  // A zoom the reader makes, by dragging across the plot as they would. Not
  // `Plotly.relayout`: that is the page's edit, not the reader's, and it is
  // the reader's that `uirevision` keeps. A level drag zooms the x axis alone.
  await page.$eval("#plot-photons", (el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(250);
  const box = await page.$eval("#plot-photons .nsewdrag", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const level = box.y + box.h / 2;
  await page.mouse.move(box.x + box.w * 0.3, level);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.7, level, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const zoomed = await photonAxis();
  await setPhotonStep(0);
  const after = await photonAxis();
  if (zoomed.range === initial.range) fail("dragging across the photon plot did not zoom it");
  else if (after.range === zoomed.range) ok("a zoom of the photon x axis survives moving the slider");
  else fail(`the slider undid a zoom: ${after.range} against ${zoomed.range}`);
  // And the same up the plot, which zooms the y axis alone.
  const upright = box.x + box.w / 2;
  await page.mouse.move(upright, box.y + box.h * 0.3);
  await page.mouse.down();
  await page.mouse.move(upright, box.y + box.h * 0.7, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const zoomedY = await photonAxis();
  await setPhotonStep(stepCount - 1);
  const afterY = await photonAxis();
  if (zoomedY.yRange === initial.yRange) fail("dragging up the photon plot did not zoom it");
  else if (afterY.yRange === zoomedY.yRange) ok("a zoom of the photon y axis survives moving the slider");
  else fail(`the slider undid a y zoom: ${afterY.yRange} against ${zoomedY.yRange}`);

  // The dose chart draws only when the vendored solver reports the field, so a
  // checkout whose vendor/ predates it skips rather than fails. Once bumped
  // this is an assertion like the others.
  const doseTraces = await page.$eval("#plot-dose", (el) => el.data ? el.data.length : 0);
  if (doseTraces > 0) {
    ok(`plot-dose drew ${doseTraces} traces`);
    const shown = await page.$eval("#plot-dose", (el) => !el.closest(".plot-wrap").hidden);
    if (shown) ok("the dose chart is visible");
    else fail("the dose chart drew but stayed hidden");
    // Non-zero, checked here rather than beside the activity check below so it
    // inherits the same skip: the dose is folded against photon attenuation
    // tables the other series never touch, so it can be zero while they are
    // fine, and a chart drawn from an empty fold still has traces.
    const peak = await page.$eval("#plot-dose", (el) =>
      Math.max(...el.data.flatMap((t) => t.y.filter((v) => v != null))));
    if (peak > 0) ok(`peak contact dose ${peak.toExponential(3)} Gy/h`);
    else fail("contact dose is zero -- the photon coefficient fold produced nothing");
  } else {
    const from = (await readFile("vendor/CORE_COMMIT", "utf8")).trim().slice(0, 8);
    console.log(`skip  plot-dose: the solver vendored from core ${from} predates contact dose`);
  }

  // Non-zero physics: a page that renders empty axes passes a "did it draw"
  // check and is still useless.
  const activity = await page.$eval("#plot-activity", (el) =>
    Math.max(...el.data.flatMap((t) => t.y.filter((v) => v != null))));
  if (activity > 0) ok(`peak activity ${activity.toExponential(3)} Bq`);
  else fail("activity is zero -- data is loaded but nothing activated");

  // The material is only rebuilt when something about it changed, because a
  // rebuilt Material is an empty one and the solver keeps its decoded cross
  // sections in the one it was handed. The hazard that opens is a cache key
  // that misses a field: the page would then solve a changed material against
  // the one before it and report the old answer as the new one, with nothing
  // to see. So each input is changed and the answer has to follow it.
  //
  // Volume and density are the probes because they move the answer without
  // moving which nuclides are needed, so none of this refetches. Both are
  // linear in the inventory, which is what makes the expected value exact
  // rather than merely different.
  await page.evaluate(() => {
    window.__done = 0;
    const el = document.getElementById("status");
    new MutationObserver(() => {
      if (el.textContent.startsWith("Done")) window.__done++;
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });
  const solve = async () => {
    const before = await page.evaluate(() => window.__done);
    await page.click("#run");
    await page.waitForFunction((b) => window.__done > b, before, { timeout: 300000 });
    // The status reaches "Done" inside the same task that asks Plotly to draw,
    // so the traces on the element can still be the previous run's. Settle
    // before reading, or every value here is one run behind.
    await page.waitForTimeout(400);
    return page.$eval("#plot-activity", (el) =>
      Math.max(...el.data.flatMap((t) => t.y.filter((v) => v != null))));
  };
  const close = (got, want) => Math.abs(got - want) <= Math.abs(want) * 1e-9;

  const volume = await page.$eval("#volume", (el) => el.value);
  const base = await solve();

  await page.fill("#volume", String(Number(volume) * 2));
  const doubled = await solve();
  if (close(doubled, base * 2)) ok("doubling the volume doubles the activity");
  else fail(`volume is missing from the material key: ${doubled.toExponential(4)} against ${(base * 2).toExponential(4)}`);

  await page.fill("#volume", volume);
  const restored = await solve();
  if (restored === base) ok("restoring the volume restores the answer exactly");
  else fail(`volume round trip drifted: ${restored.toExponential(6)} against ${base.toExponential(6)}`);

  const density = await page.$eval("#density", (el) => el.value);
  await page.fill("#density", String(Number(density) * 2));
  const denser = await solve();
  if (close(denser, base * 2)) ok("doubling the density doubles the activity");
  else fail(`density is missing from the material key: ${denser.toExponential(4)} against ${(base * 2).toExponential(4)}`);
  await page.fill("#density", density);

  // The flux. Shown in exponent form, since a number input showed 1e14 as
  // fifteen digits in a cell with room for eight, and read back the same way.
  // Doubling it doubles the activity to within the burn-up of the target over
  // a year, which is a fraction of a percent at 1e14; a half-typed value is
  // marked and the last good one kept rather than reaching the solver.
  const rateInput = '#schedule input[data-k="rate"]';
  eq(await page.$eval(rateInput, (el) => el.value), "1e14", "the flux reads as an exponent");
  await page.fill(rateInput, "2e");
  eq(await page.$eval(rateInput, (el) => el.classList.contains("invalid")), true, "a half-typed flux is marked");
  await page.fill(rateInput, "2e14");
  eq(await page.$eval(rateInput, (el) => el.classList.contains("invalid")), false, "and a whole one is not");
  const brighter = await solve();
  if (Math.abs(brighter / (base * 2) - 1) < 0.01) ok(`doubling the flux doubles the activity (${(brighter / base).toFixed(4)}x)`);
  else fail(`doubling the flux gave ${brighter.toExponential(4)} against ${(base * 2).toExponential(4)}`);
  await page.fill(rateInput, "1e14");
  const dimmed = await solve();
  if (dimmed === base) ok("and restoring it restores the answer exactly");
  else fail(`flux round trip drifted: ${dimmed.toExponential(6)} against ${base.toExponential(6)}`);

  // The composition itself, on a nuclide the fixtures carry, so this does not
  // fetch either. Fe57 activates differently from Fe56; equal answers would
  // mean the second run was solved against the first one's material.
  await page.fill('#composition input[data-k="name"]', "Fe57");
  const fe57 = await solve();
  if (fe57 !== base && fe57 > 0) ok(`changing the nuclide changes the answer (Fe57 ${fe57.toExponential(3)} Bq)`);
  else fail(`composition is missing from the material key: Fe57 gave ${fe57.toExponential(6)}`);
  await page.fill('#composition input[data-k="name"]', "Fe56");
  const back = await solve();
  if (back === base) ok("and changing it back restores the original exactly");
  else fail(`composition round trip drifted: ${back.toExponential(6)} against ${base.toExponential(6)}`);

  // Which nuclides get a name. Aluminium is the case that showed the old rule
  // up: its four largest peaks (Al28, Mg27, Na24 and its isomer) are all gone
  // within a week, and naming by peak left the whole of the years as the grey
  // "Other" line. Naming by who leads at some step has to put a name on the
  // largest series at the last step as well as at the first, and keep the
  // early leader too.
  await page.fill('#composition input[data-k="name"]', "Al27");
  await solve();
  const leaders = await page.$eval("#plot-activity", (el) => {
    // The total is drawn too, and is by construction the largest; the
    // question is which nuclide series leads, so it is left out here.
    const at = (i) => el.data
      .filter((t) => t.name !== "total")
      .map((t) => [t.name, t.y[i]])
      .filter(([, v]) => v != null)
      .sort((a, b) => b[1] - a[1])[0];
    return { first: at(0), last: at(el.data[0].y.length - 1), names: el.data.map((t) => t.name) };
  });
  if (leaders.last && leaders.last[0] !== "Other") ok(`the nuclide leading at the last step is named (${leaders.last[0]})`);
  else fail(`the last step's largest series is ${leaders.last ? leaders.last[0] : "nothing"}: ${leaders.names.join(", ")}`);
  if (leaders.first && leaders.first[0] !== "Other") ok(`and so is the one leading at the first (${leaders.first[0]})`);
  else fail(`the first step's largest series is ${leaders.first ? leaders.first[0] : "nothing"}`);
  await page.fill('#composition input[data-k="name"]', "Fe56");
  const ironAgain = await solve();
  if (ironAgain === base) ok("and iron comes back exactly");
  else fail(`iron drifted after aluminium: ${ironAgain.toExponential(6)} against ${base.toExponential(6)}`);

  // The temperature. Unlike the probes above it changes what is fetched, not
  // just what is built: the cross sections held are held at 294 K, so a run at
  // 600 K has to fetch again, solve against the new bytes rather than the ones
  // decoded into the old material, and come back to the original exactly when
  // the form does. Every failure here is a silent one: a stale set of held
  // nuclides would solve the 600 K run at 294 K and report it as 600 K.
  const fetched = () => served + missed;
  const beforeHot = fetched();
  await page.fill("#temperature", "600");
  const hot = await solve();
  if (fetched() > beforeHot) ok(`changing the temperature refetches (${fetched() - beforeHot} requests)`);
  else fail("changing the temperature refetched nothing: the held nuclides were not invalidated");
  if (hot > 0 && hot !== base) ok(`and changes the answer (600 K: ${hot.toExponential(4)} Bq against ${base.toExponential(4)})`);
  else fail(`the 600 K run gave ${hot.toExponential(6)}: the same data as 294 K was solved`);
  const beforeCold = fetched();
  await page.fill("#temperature", "294");
  const cold = await solve();
  if (fetched() > beforeCold) ok("changing it back refetches too");
  else fail("changing the temperature back refetched nothing");
  if (cold === base) ok("and restores the original exactly");
  else fail(`temperature round trip drifted: ${cold.toExponential(6)} against ${base.toExponential(6)}`);
  // And a run that changes nothing about the data does not fetch: the
  // invalidation above must not have turned every run into a download.
  const beforeStill = fetched();
  await solve();
  if (fetched() === beforeStill) ok("a run at the same temperature refetches nothing");
  else fail(`a run at the same temperature made ${fetched() - beforeStill} requests`);

  // A chain library. The chain is parsed once and held, and a change to any of
  // its four libraries after a run used to change nothing: the dropdown moved
  // and the old chain solved on. Now it starts the session over, so the chain
  // and every cross section are fetched again. The fixture server answers for
  // any library from the one fixture set, so the answer has to come back the
  // same; what is checked is that the fetch happened, and that the budget said
  // so before the run.
  await page.selectOption("#data-decay", "jeff-4.0");
  await page.waitForFunction(
    () => document.getElementById("budget").textContent.startsWith("The chain libraries changed"),
    null, { timeout: 5000 },
  ).then(
    () => ok("changing a chain library says the chain will be fetched again"),
    () => fail(`the budget did not notice the chain change: ${"see #budget"}`),
  );
  const beforeChain = fetched();
  const rechained = await solve();
  const chainFiles = 6;
  if (fetched() - beforeChain > chainFiles) ok(`changing a chain library refetches the chain and the cross sections (${fetched() - beforeChain} requests)`);
  else fail(`changing a chain library made ${fetched() - beforeChain} requests`);
  if (rechained === base) ok("and, from the same fixtures, gives the same answer");
  else fail(`the rechained run gave ${rechained.toExponential(6)} against ${base.toExponential(6)}`);
  await page.selectOption("#data-decay", "endf-b8.1");
  await solve();
  const beforeSettled = fetched();
  await solve();
  if (fetched() === beforeSettled) ok("and a run after that refetches nothing again");
  else fail(`a run after the chain change made ${fetched() - beforeSettled} requests`);

  // The session export. The file it writes is this page with the setup and
  // the results inside it, so the check is to open that file in a fresh page
  // with the data origin unreachable and find the run there: the same peak,
  // the same schedule, the same material, and no request for data.
  const [sessionDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#export"),
  ]);
  const sessionPath = `${process.cwd()}/verify-session.html`;
  await sessionDownload.saveAs(sessionPath);
  const sessionBytes = (await readFile(sessionPath)).length;
  if (/^yani_session_.*\.html$/.test(sessionDownload.suggestedFilename())) {
    ok(`the session exports as one file (${(sessionBytes / 1048576).toFixed(2)} MB)`);
  } else {
    fail(`the session export is named ${sessionDownload.suggestedFilename()}`);
  }
  const sessionPage = await browser.newPage({ viewport: { width: 1400, height: 1600 } });
  let fetchedOffline = 0;
  await sessionPage.route(`${ORIGIN}/**`, async (route) => {
    fetchedOffline++;
    await route.abort();
  });
  const restoredErrors = [];
  sessionPage.on("pageerror", (e) => restoredErrors.push(e.message));
  await sessionPage.goto(`file://${sessionPath}`);
  await sessionPage.waitForFunction(
    () => document.getElementById("status").textContent.startsWith("Restored"),
    null, { timeout: 60000 },
  ).then(
    () => ok("the exported file opens on the saved session"),
    () => fail("the exported file did not restore its session"),
  );
  await sessionPage.waitForTimeout(500);
  const restoredPeak = await sessionPage.$eval("#plot-activity", (el) =>
    Math.max(...el.data.flatMap((t) => t.y.filter((v) => v != null))));
  if (restoredPeak === base) ok("with the run's results on the charts, to the last digit");
  else fail(`the sessionPage activity is ${restoredPeak} against ${base}`);
  const restoredForm = await sessionPage.evaluate(() => ({
    material: document.querySelector('#composition input[data-k="name"]').value,
    rows: document.querySelectorAll("#schedule tr").length,
    temperature: document.getElementById("temperature").value,
    preset: document.getElementById("spectrum-preset").value,
    inventorySteps: Number(document.getElementById("inventory-step").max) + 1,
  }));
  eq(restoredForm.material, "Fe56", "and the material back on the form");
  eq(restoredForm.rows, schedule.length, "and the schedule");
  eq(restoredForm.temperature, "294", "and the temperature");
  eq(restoredForm.preset, offered[0], "and the spectrum preset");
  eq(restoredForm.inventorySteps, schedule.length, "and the stepped charts sized to the run");
  eq(fetchedOffline, 0, "with nothing fetched from the data origin");
  if (restoredErrors.length) fail(`the exported file raised: ${restoredErrors.slice(0, 3).join(" | ")}`);
  else ok("and no errors in the exported file");
  await sessionPage.close();

  await page.screenshot({ path: "verify-light.png", fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.click("#run");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "verify-dark.png", fullPage: true });
  ok("screenshots written: verify-light.png, verify-dark.png");
  }  // haveFixtures

  // The single-file property, checked by behaviour rather than by text.
  if (foreign.length === 0) {
    ok("self-contained: nothing fetched except nuclear data");
  } else {
    fail(`page fetched ${foreign.length} foreign resources: ${foreign.slice(0, 5).join(", ")}`);
  }

  if (errors.length) fail(`console errors: ${errors.slice(0, 5).join(" | ")}`);
  else ok("no console errors");

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
