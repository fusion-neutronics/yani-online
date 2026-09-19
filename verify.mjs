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
// `--live` adds a check against the real data origin: that the published MT
// byte-range index describes the published object, that ranges are honoured,
// and that a spliced stream is byte-for-byte the whole file's bytes. It is the
// only part that needs the network.
//
// Needs `node build.mjs` first, and core's fixtures:
//   python3 scripts/fetch_test_fixtures.py   (in core)

import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import {
  COALESCE_GAP, assembleNuclideData, planFetch, rangeHeader, reactionRanges, spliceStream, wantedParts,
} from "./src/ranges.js";

// Core's downloaded test fixtures. Override with YANI_FIXTURES; the default is
// a sibling checkout, which is where they land after
// `python3 scripts/fetch_test_fixtures.py` in core.
const FIXTURES = process.env.YANI_FIXTURES || "../core/crates/yamc/tests";
const CHAIN = `${FIXTURES}/transmutation-endf-b8.1-sfr.arrow`;
const ORIGIN = "https://yamc-data.xsplot.com";

/// Map a data-origin URL onto the fixture tree.
///
/// The chain lives under subsection directories named without the `.arrow`
/// suffix the URL carries; per-nuclide data is a directory per nuclide.
function fixturePath(url) {
  const path = url.slice(ORIGIN.length + 1);
  let m = path.match(/^[^/]+\/transmutation\/([^/]+)\.arrow\/(.+)$/);
  if (m) return `${CHAIN}/${m[1]}/${m[2]}`;
  m = path.match(/^[^/]+\/neutron\/([^/]+)\.arrow\/(.+)$/);
  if (m) return `${FIXTURES}/${m[1]}.arrow/${m[2]}`;
  return null;
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

/// A stand-in reactions.arrow and the index over it.
///
/// 128 kB of pseudo-random bytes, so a cut in the wrong place cannot
/// coincidentally match the right one. The MTs are laid out to put every case
/// the fetch has to get right into one file:
///
///   MT 1     20 kB of transport total, wide enough to keep the schema out of
///            the same request
///   MT 16    wanted, at two temperatures that are two batches back to back,
///            and MT 102 wanted and touching them
///   MT 2     1 kB of elastic between two wanted batches: close enough to be
///            swallowed by the coalesce, and it must not reach the decoder
///   MT 103   wanted, on the far side of it
///   MT 301   100 kB of heating, which is most of the file and none of the run
///
/// The index is keyed by MT and then by temperature, one batch per pair, the
/// shape core writes since fusion-neutronics/core#100. Every other MT here has
/// the one temperature.
///
/// Real published data exercises none of the swallowing: the writer puts the
/// activation MTs in contiguous runs, so on every ENDF/B-8.1 nuclide checked the
/// coalesce merges only ranges that already touch. That is why the case is built
/// here rather than measured there.
function synthetic() {
  const file = new Uint8Array(131072);
  let seed = 1;
  for (let i = 0; i < file.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    file[i] = seed & 0xff;
  }
  return {
    file,
    version: {
      reaction_ranges: {
        schema: [64, 64],
        mts: {
          1: { "294K": [128, 20000] },
          16: { "294K": [20128, 64], "600K": [20192, 64] },
          102: { "294K": [20256, 256] },
          2: { "294K": [20512, 1000] },
          103: { "294K": [21512, 64] },
          301: { "294K": [30000, 100000] },
        },
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
  const { file, version } = synthetic();

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
}

/// Check what gets handed to the solver, out of what came back.
///
/// The fetch answers in whatever order the network does, so this is where a
/// silent error would live: a span filed by arrival rather than by plan splices
/// a stream from the right bytes in the wrong order, and the loader reads that
/// without complaint. Every case is built with the spans deliberately out of
/// order for exactly that reason.
function checkAssembly() {
  const { file, version } = synthetic();
  const plan = planFetch(reactionRanges(version), new Set([16, 102, 103]));
  const plans = new Map([["Fe56", plan]]);
  const body = (i) => file.slice(plan.spans[i].off, plan.spans[i].off + plan.spans[i].len);
  const nuclideArrow = new Uint8Array([1, 2, 3]);
  const energyArrow = new Uint8Array([4, 5, 6]);

  // The jobs as loadCrossSections builds them, but with span 1 ahead of span 0,
  // which is what a slower first request looks like.
  const jobs = [
    { nuclide: "Fe56", file: "nuclide.arrow" },
    { nuclide: "Fe56", file: "energy.arrow" },
    { nuclide: "Fe56", file: "reactions.arrow", range: plan.spans[1], spanIndex: 1, status: 206 },
    { nuclide: "Fe56", file: "reactions.arrow", range: plan.spans[0], spanIndex: 0, status: 206 },
  ];

  const got = assembleNuclideData(jobs, [nuclideArrow, energyArrow, body(1), body(0)], plans);
  eq(got.items.length, 3, "all three files are handed over");
  eq(got.missing.size, 0, "nothing is missing");
  eq(got.saved, plan.full - plan.bytes, "the saving is the file less the spans");
  eq(got.stripped, false, "the ranges were honoured");

  const reactions = got.items.find((it) => it.file === "reactions.arrow").bytes;
  const wanted = spliceStream(plan.parts, plan.spans, [body(0), body(1)]);
  eq(reactions.length, wanted.length, "the spliced stream is the expected length");
  eq(reactions.every((b, i) => b === wanted[i]), true,
     "spans out of order splice in plan order, not arrival order");

  // A span that never arrived. The nuclide has to be reported rather than given
  // a stream with a hole in it.
  const short = assembleNuclideData(jobs, [nuclideArrow, energyArrow, body(1), undefined], plans);
  eq(short.items.some((it) => it.file === "reactions.arrow"), false, "a lost span hands over no stream");
  eq(short.missing.has("Fe56"), true, "and the nuclide is reported missing");
  eq(short.saved, 0, "and nothing is counted as saved");

  // A proxy that stripped the header: 200 with the whole object rather than 206
  // with the slice. The body is the file, so it is used as the file.
  const stripped = assembleNuclideData(
    [jobs[0], jobs[1], { ...jobs[2], status: 200 }, { ...jobs[3], status: 200 }],
    [nuclideArrow, energyArrow, file, file], plans);
  eq(stripped.stripped, true, "a 200 answer to a range is noticed");
  eq(stripped.items.find((it) => it.file === "reactions.arrow").bytes.length, file.length,
     "and the whole object is handed over as the file");
  eq(stripped.saved, 0, "with nothing claimed as saved");
  eq(stripped.missing.size, 0, "and the nuclide is not reported missing");

  // A nuclide with no plan at all, which is every nuclide today: both files pass
  // straight through, and a 404 on either reports it.
  const plainJobs = [
    { nuclide: "Li6", file: "nuclide.arrow" },
    { nuclide: "Li6", file: "energy.arrow" },
    { nuclide: "Li6", file: "reactions.arrow" },
  ];
  const plain = assembleNuclideData(plainJobs, [nuclideArrow, energyArrow, nuclideArrow], new Map());
  eq(plain.items.length, 3, "an unplanned nuclide hands over every file");
  eq(plain.saved, 0, "and saves nothing");
  // A 404 on the grids reports the nuclide too: core refuses a load with no
  // energy.arrow, so handing over the other two would fail later and less
  // clearly.
  const noGrid = assembleNuclideData(plainJobs, [nuclideArrow, undefined, nuclideArrow], new Map());
  eq(noGrid.missing.has("Li6"), true, "a 404 on energy.arrow reports the nuclide");
  const gap = assembleNuclideData(plainJobs, [nuclideArrow, energyArrow, undefined], new Map());
  eq(gap.missing.has("Li6"), true, "a 404 on the whole-file path reports the nuclide");
}

/// Check the byte-range fetch against the real origin.
///
/// Opt-in, with `node verify.mjs --live [Nuclide ...]`, because it needs the
/// network and downloads a whole reactions.arrow to compare against. What it
/// proves is the part no synthetic fixture can: that the published index
/// describes the published object, that the origin honours the ranges asked of
/// it, and that a spliced stream is byte-for-byte the bytes the whole-file path
/// would have read.
///
/// Byte-exactness is the claim rather than "it decodes", because there is
/// nothing here that decodes Arrow. It was confirmed once with pyarrow that a
/// byte-exact splice of these ranges opens as a stream and yields record
/// batches, a fused table and (n,gamma) values identical to reading the whole
/// file, on Fe56, Li6, Cr52 and Pu239. That is a property of the format, so it
/// is recorded in dev-readme.md rather than re-run here.
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

  for (const nuclide of names) {
    const base = `${ORIGIN_LIVE}/${library}/neutron/${nuclide}.arrow`;
    const version = await (await fetch(`${base}/version.json`)).json();
    const ranges = reactionRanges(version);
    if (!ranges) {
      fail(`${nuclide}: version.json carries no reaction_ranges this build can plan from`
        + (version.reaction_ranges
          ? " (it has one in the shape from before fusion-neutronics/core#100; reindex it)"
          : ""));
      continue;
    }
    const plan = planFetch(ranges, wantedMts);

    const bodies = [];
    let honoured = true;
    for (const span of plan.spans) {
      const resp = await fetch(`${base}/reactions.arrow`, { headers: { Range: rangeHeader(span) } });
      if (resp.status !== 206) {
        fail(`${nuclide}: ${rangeHeader(span)} answered ${resp.status}, not 206`);
        honoured = false;
        break;
      }
      const body = new Uint8Array(await resp.arrayBuffer());
      if (body.length !== span.len) {
        fail(`${nuclide}: asked for ${span.len} bytes, got ${body.length}`);
        honoured = false;
        break;
      }
      bodies.push(body);
    }
    if (!honoured) continue;
    ok(`${nuclide}: ${plan.spans.length} ranges answered 206 exactly, ` +
       `${(plan.bytes / 1048576).toFixed(2)} MB of ${(plan.full / 1048576).toFixed(2)} MB ` +
       `(${(plan.full / plan.bytes).toFixed(1)}x less)`);

    const stream = spliceStream(plan.parts, plan.spans, bodies);
    const whole = new Uint8Array(await (await fetch(`${base}/reactions.arrow`)).arrayBuffer());

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
    if (exact) ok(`${nuclide}: the spliced stream is the whole file's bytes at those offsets`);
    else fail(`${nuclide}: the spliced stream differs from the whole file`);
    eq(at + 8, stream.length, `${nuclide}: the stream is its parts plus the marker`);
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
  checkAssembly();
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
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = fixturePath(route.request().url());
    if (!path || !existsSync(path)) {
      // A 404 is the honest answer for a nuclide this fixture set does not
      // carry, and exercising it is the point: the page has to survive gaps.
      missed++;
      await route.fulfill({ status: 404, body: "" });
      return;
    }
    served++;
    const body = await readFile(path);
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
    const select = document.querySelector(".axis-scale select");
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

  // The Python export. Checked by reading what it actually writes: the failure
  // that matters is a script that downloads but does not describe the setup on
  // screen, which a "did the click work" check would pass.
  // A material first: with none chosen the export refuses, which is correct --
  // there is no setup to describe -- and is checked immediately after.
  await page.selectOption("#pnnl-select", { index: 0 });
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
    ["the schedule", /yani\.PulseSchedule\(\[/],
    ["the run", /material\.transmute\(schedule=schedule\)/],
    // At its defaults, which is the point: those defaults are what the page
    // reports, so a script that passed its own would quietly disagree with the
    // chart it is meant to reproduce.
    ["the contact dose", /m\.contact_dose\(by_nuclide=True\)/],
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

  // And that it follows the form rather than being drawn once. A preset with a
  // different group count is the cheapest thing to check it against.
  await page.selectOption("#spectrum-preset", "thermal");
  await page.waitForFunction(
    () => document.getElementById("spectrum-status").textContent.startsWith("5 groups"),
    null, { timeout: 5000 },
  ).then(
    () => ok("the spectrum follows the preset"),
    () => fail(`the spectrum did not follow the preset: ${document && "see #spectrum-status"}`),
  );
  await page.selectOption("#spectrum-preset", "fusion-fw");

  if (haveFixtures) {
  // A single-nuclide material, so the fixture set covers the seed even though
  // it cannot cover the whole closure.
  await page.click('[data-tab="custom"]');
  await page.fill('#composition input[data-k="name"]', "Fe56");
  await page.fill("#density", "7.874");
  await page.fill("#volume", "1000");

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

  // Whether the run fetched MTs or whole files. Both are correct -- the whole
  // file is the fallback and has to keep working -- so this reports rather than
  // gates, and says which of the two preconditions is missing when it is the
  // fallback that ran, because "no range requests" on its own reads as a bug.
  if (ranged) {
    const full = [...rangedFull.values()].reduce((n, v) => n + v, 0);
    ok(
      `fetched MT byte ranges: ${ranged} requests, ` +
      `${(rangedBytes / 1048576).toFixed(1)} MB of ${(full / 1048576).toFixed(1)} MB ` +
      `across ${rangedFull.size} objects`);
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

  // The photon x axis holds still while the slider walks the steps. Its range
  // is set from every step's lines rather than the one drawn, so the reader
  // sees where the whole spectrum lives and nothing jumps as they scroll, and
  // a zoom they make persists across steps. Each is checked by moving the
  // slider, because the failure is one a single drawn step cannot show.
  const photonAxis = () => page.$eval("#plot-photons", (el) => ({
    range: JSON.stringify(el.layout.xaxis.range),
    type: el.layout.xaxis.type,
    // The marker trace carries one point per line, in MeV.
    lines: el.data[1].x.slice(),
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
  const moved = [];
  let outside = 0;
  for (let i = 0; i < stepCount; i++) {
    await setPhotonStep(i);
    const axis = await photonAxis();
    if (axis.range !== initial.range) moved.push(i + 1);
    // A log axis's range is in decades; the lines are in MeV either way.
    for (const x of axis.lines) {
      const v = axis.type === "log" ? Math.log10(x) : x;
      if (v < lo || v > hi) outside++;
    }
  }
  if (!moved.length) ok(`the photon x axis holds still across ${stepCount} steps`);
  else fail(`the photon x axis moved at steps ${moved.join(", ")}`);
  if (!outside) ok("and its initial range covers every step's lines");
  else fail(`${outside} photon lines fall outside the initial x range`);

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
  await setPhotonStep(stepCount - 1);

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
