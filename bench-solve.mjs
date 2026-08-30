// What a solve costs, and what a second solve costs.
//
//   node bench-solve.mjs <label> [repeats]
//
// The two numbers are different questions. The first solve carries the fetch,
// the chain parse and the Arrow decode of every reachable nuclide. The ones
// after it change nothing about the material, which is what anyone actually
// does here: move a pulse, add a cooldown, run again. That second number is the
// page's interaction loop, and it is the one the solver's own speed work moves.
//
// Answers are read back per run as well as timings, because a solve that got
// faster and quietly changed its answer is not a solve that got faster.
//
// Needs `node build.mjs` first, and core's fixtures (see verify.mjs). It drives
// the built page against them, so it measures the real thing rather than a
// harness around the wasm.
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const FIXTURES = process.env.YANI_FIXTURES || "../core/crates/yamc/tests";
const CHAIN = `${FIXTURES}/transmutation-endf-b8.1-sfr.arrow`;
const ORIGIN = "https://yamc-data.xsplot.com";
const label = process.argv[2] || "run";
const repeats = Number(process.argv[3] || 6);

if (!existsSync(`${CHAIN}/decay/nuclides.arrow`)) {
  console.error(`no fixtures at ${CHAIN}: set YANI_FIXTURES, or run fetch_test_fixtures.py in core`);
  process.exit(2);
}

function fixturePath(url) {
  const path = url.slice(ORIGIN.length + 1);
  let m = path.match(/^[^/]+\/transmutation\/([^/]+)\.arrow\/(.+)$/);
  if (m) return `${CHAIN}/${m[1]}/${m[2]}`;
  m = path.match(/^[^/]+\/neutron\/([^/]+)\.arrow\/(.+)$/);
  if (m) return `${FIXTURES}/${m[1]}.arrow/${m[2]}`;
  return null;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });

// The same Range-honouring fixture server verify.mjs uses, so a build whose
// solver can splice MT streams is measured fetching the way it would.
let ranged = 0;
let rangedBytes = 0;
await page.route(`${ORIGIN}/**`, async (route) => {
  const path = fixturePath(route.request().url());
  if (!path || !existsSync(path)) return route.fulfill({ status: 404, body: "" });
  const body = await readFile(path);
  const want = (route.request().headers().range || "").match(/^bytes=(\d+)-(\d+)$/);
  if (!want) return route.fulfill({ status: 200, body });
  const start = Number(want[1]);
  const end = Math.min(Number(want[2]), body.length - 1);
  ranged++;
  rangedBytes += end - start + 1;
  return route.fulfill({
    status: 206,
    headers: { "content-range": `bytes ${start}-${end}/${body.length}` },
    body: body.subarray(start, end + 1),
  });
});

await page.goto(`file://${process.cwd()}/dist/index.html`);
await page.waitForFunction(
  () => document.getElementById("status").textContent.startsWith("Ready"),
  null, { timeout: 30000 });

// A pure Fe56 material on the custom tab: the setup dev-readme's 4.4380e14 Bq
// comes from. The page opens on the PNNL tab with nothing selected.
await page.click('[data-tab="custom"]');
await page.fill('#composition input[data-k="name"]', "Fe56");
await page.waitForTimeout(300);

// Completions are counted from the page rather than matched in the status text:
// the text repeats between runs, and it ticks every 100 ms while solving, so
// only the transition into "Done" is a run finishing.
await page.evaluate(() => {
  window.__done = 0;
  const el = document.getElementById("status");
  new MutationObserver(() => {
    if (el.textContent.startsWith("Done")) window.__done++;
  }).observe(el, { childList: true, characterData: true, subtree: true });
});

const peak = () => page.$eval("#plot-activity", (el) =>
  Math.max(...el.data.flatMap((t) => t.y.filter((v) => v != null))));

const times = [];
const answers = [];
for (let i = 0; i <= repeats; i++) {
  const before = await page.evaluate(() => window.__done);
  const t0 = Date.now();
  await page.click("#run");
  await page.waitForFunction((b) => window.__done > b, before, { timeout: 300000 });
  times.push(Date.now() - t0);
  // The status reaches "Done" in the same task that asks Plotly to draw, so the
  // traces can still be the previous run's until this settles.
  await page.waitForTimeout(400);
  answers.push(await peak());
}

const repeatMs = times.slice(1).sort((a, b) => a - b);
console.log(JSON.stringify({
  label,
  first_ms: times[0],
  repeat_ms: times.slice(1),
  repeat_median_ms: repeatMs[Math.floor(repeatMs.length / 2)],
  activity_bq: answers[0],
  // Every run is the same material, so every run must give the same number.
  stable: answers.every((v) => v === answers[0]),
  budget: await page.textContent("#budget"),
  // Whether the byte-range fetch engaged, which changes what a first solve
  // costs and how much decode a repeat solve has left to save.
  ranged_requests: ranged,
  ranged_mb: Number((rangedBytes / 1048576).toFixed(2)),
}, null, 2));
await browser.close();
