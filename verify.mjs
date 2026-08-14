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

const FIXTURES = "/workspace/core/crates/yamc/tests";
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
    console.error("dist/index.html missing — run `node build.mjs` first");
    process.exit(2);
  }
  if (!existsSync(`${CHAIN}/decay/nuclides.arrow`)) {
    console.error(`fixtures missing at ${CHAIN} — run fetch_test_fixtures.py in core`);
    process.exit(2);
  }

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
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

  // A single-nuclide material, so the fixture set covers the seed even though
  // it cannot cover the whole closure.
  await page.click('[data-tab="custom"]');
  await page.fill('#composition input[data-k="name"]', "Fe56");
  await page.fill("#density", "7.874");
  await page.fill("#volume", "1000");

  await page.click("#load-data");
  await page.waitForFunction(
    () => !document.getElementById("run").disabled,
    null, { timeout: 180000 },
  );
  ok(`data loaded (${served} fixture responses, ${missed} 404s survived)`);

  const warning = await page.textContent("#warning");
  if (!/No cross sections published for/.test(warning || "")) {
    fail("missing nuclides should be reported, not swallowed");
  } else {
    ok("missing nuclides are named in the warning");
  }

  await page.click("#run");
  await page.waitForFunction(
    () => document.getElementById("status").textContent.startsWith("Done"),
    null, { timeout: 120000 },
  );
  ok("transmutation completes");

  // The charts have to have actually drawn, not merely been asked to.
  for (const id of ["plot-activity", "plot-heat", "plot-inventory", "plot-photons"]) {
    const traces = await page.$eval(`#${id}`, (el) => el.data ? el.data.length : 0);
    if (traces > 0) ok(`${id} drew ${traces} traces`);
    else fail(`${id} drew nothing`);
  }

  // Non-zero physics: a page that renders empty axes passes a "did it draw"
  // check and is still useless.
  const activity = await page.$eval("#plot-activity", (el) =>
    Math.max(...el.data.flatMap((t) => t.y.filter((v) => v != null))));
  if (activity > 0) ok(`peak activity ${activity.toExponential(3)} Bq`);
  else fail("activity is zero — data is loaded but nothing activated");

  await page.screenshot({ path: "verify-light.png", fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.click("#run");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "verify-dark.png", fullPage: true });
  ok("screenshots written: verify-light.png, verify-dark.png");

  if (errors.length) fail(`console errors: ${errors.slice(0, 5).join(" | ")}`);
  else ok("no console errors");

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
