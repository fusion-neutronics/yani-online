// End-to-end check: run a transmutation in a real browser and look at what it
// draws.
//
// The point is to exercise the page's own fetch path rather than a stub of it,
// so requests to the data origin are intercepted and answered from the local
// test fixtures. Everything else -- the wasm boot, the chain parse, the
// cross-section load, the solve, the plots -- is the real thing.
//
//   node verify.mjs [--headed]
//
// Needs `node build.mjs` first, and core's fixtures:
//   python3 scripts/fetch_test_fixtures.py   (in core)

import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

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

async function main() {
  if (!existsSync("dist/index.html")) {
    console.error("dist/index.html missing -- run `node build.mjs` first");
    process.exit(2);
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
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = fixturePath(route.request().url());
    if (path && existsSync(path)) {
      served++;
      await route.fulfill({ status: 200, body: await readFile(path) });
    } else {
      // A 404 is the honest answer for a nuclide this fixture set does not
      // carry, and exercising it is the point: the page has to survive gaps.
      missed++;
      await route.fulfill({ status: 404, body: "" });
    }
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
  for (const id of ["plot-activity", "plot-heat", "plot-dose", "plot-inventory", "plot-photons"]) {
    const traces = await page.$eval(`#${id}`, (el) => el.data ? el.data.length : 0);
    if (traces > 0) ok(`${id} drew ${traces} traces`);
    else fail(`${id} drew nothing`);
  }

  // Non-zero physics: a page that renders empty axes passes a "did it draw"
  // check and is still useless.
  const activity = await page.$eval("#plot-activity", (el) =>
    Math.max(...el.data.flatMap((t) => t.y.filter((v) => v != null))));
  if (activity > 0) ok(`peak activity ${activity.toExponential(3)} Bq`);
  else fail("activity is zero -- data is loaded but nothing activated");

  // The contact dose is folded against attenuation tables the other three do
  // not touch, so it can be zero while activity is fine -- a chart drawn from
  // an empty fold still has traces and still passes the check above.
  const dose = await page.$eval("#plot-dose", (el) =>
    Math.max(...el.data.flatMap((t) => t.y.filter((v) => v != null))));
  if (dose > 0) ok(`peak contact dose ${dose.toExponential(3)} Gy/h`);
  else fail("contact dose is zero -- the photon coefficient fold produced nothing");

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
