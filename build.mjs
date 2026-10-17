// Produce dist/index.html: one file, no runtime dependencies.
//
// The page in src/ is written to be servable as-is during development, with the
// wasm, its glue and plotly fetched from vendor/. This substitutes them in as
// base64 so the built page needs nothing but a browser.
//
// Plotly is gzipped before base64 and inflated with DecompressionStream in the
// page: 0.98 MB raw becomes 0.36 MB gzipped, and base64 inflates by a third, so
// carrying it compressed costs 0.45 MB against 1.31 MB. The wasm is left
// uncompressed -- it is already LZ4-dense and gzip buys little, while the page
// would pay to inflate 2.5 MB before it can start.
//
//   node build.mjs [--wheel path/to/yani_core-...-pyemscripten_..._wasm32.whl]
//
// Run `wasm-pack build --target web` in core's crates/yani-wasm and copy
// pkg/yani_wasm{.js,_bg.wasm} into vendor/ first.
//
// The Python tab is the exception to the one file, and only it: it is loaded
// the first time the tab is opened, from files beside index.html (its module,
// its Pyodide worker, the worker's fetch helper, CodeMirror, coi-serviceworker
// and config.js, which pins Pyodide and yani-core and carries the examples).
// Pyodide comes from the jsDelivr CDN and yani-core from PyPI, at the versions
// vendor/PYODIDE_VERSION and vendor/YANI_CORE_VERSION pin. `--wheel` copies a
// local Pyodide wheel of yani-core into dist/ and installs that instead: for
// trying an unreleased core, and for checking the page offline. A published
// page is built without it.

import { readFile, writeFile, mkdir, readdir, rm, copyFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const SRC = new URL("./src/", import.meta.url);
const VENDOR = new URL("./vendor/", import.meta.url);
const EXAMPLES = new URL("./examples/", import.meta.url);
const DIST = new URL("./dist/", import.meta.url);

// The order of the Python tab's examples menu. The first is what a new
// visitor sees.
const EXAMPLE_ORDER = ["iron_activation", "lithium_breeding"];

/// The title is the first comment line up to its colon: "# Iron activation: ..."
function exampleTitle(name, code) {
  const m = code.match(/^#\s*([^:\n]+):/);
  if (!m) throw new Error(`examples/${name}.py must open with "# Title: description"`);
  return m[1].trim();
}

/// dist/config.js and the examples it carries.
async function pythonTab(wheel) {
  const text = async (url) => (await readFile(url, "utf8")).trim();
  const pyodideVersion = await text(new URL("PYODIDE_VERSION", VENDOR));
  const yaniCoreVersion = await text(new URL("YANI_CORE_VERSION", VENDOR));
  const names = (await readdir(EXAMPLES)).filter((f) => f.endsWith(".py")).map((f) => f.slice(0, -3));
  const unlisted = names.filter((n) => !EXAMPLE_ORDER.includes(n));
  if (unlisted.length) throw new Error(`examples not in EXAMPLE_ORDER: ${unlisted.join(", ")}`);
  const examples = [];
  for (const name of EXAMPLE_ORDER) {
    const code = `${await text(new URL(`${name}.py`, EXAMPLES))}\n`;
    examples.push({ name, title: exampleTitle(name, code), code });
  }
  const config =
    "// Written by build.mjs. Edit vendor/ and examples/, not this file.\n" +
    `export const PYODIDE_VERSION = ${JSON.stringify(pyodideVersion)};\n` +
    `export const YANI_CORE_VERSION = ${JSON.stringify(yaniCoreVersion)};\n` +
    "// A wheel beside the page to install instead of the PyPI release, or null.\n" +
    `export const WHEEL = ${JSON.stringify(wheel)};\n` +
    `export const EXAMPLES = ${JSON.stringify(examples, null, 2)};\n`;
  return { config, pyodideVersion, yaniCoreVersion, examples };
}

const read = (base, name) => readFile(new URL(name, base));
const b64 = (buf) => buf.toString("base64");

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

async function main() {
  const args = process.argv.slice(2);
  const wheelArg = args.indexOf("--wheel");
  const localWheel = wheelArg >= 0 ? resolve(args[wheelArg + 1] || "") : null;
  if (localWheel && !/^yani_core-.+-pyemscripten_\d+_\d+_wasm32\.whl$/.test(basename(localWheel))) {
    throw new Error(`--wheel wants a Pyodide wheel of yani-core (yani_core-*-pyemscripten_*_wasm32.whl), not ${localWheel}`);
  }
  const wheel = localWheel && basename(localWheel);

  const [html, appJs, plotsJs, pythonJs, rangesJs, spectraJs, workerJs, wasm, glue, plotly] = await Promise.all([
    read(SRC, "index.html").then(String),
    read(SRC, "app.js").then(String),
    read(SRC, "plots.js").then(String),
    read(SRC, "python.js").then(String),
    read(SRC, "ranges.js").then(String),
    read(SRC, "spectra.js").then(String),
    read(SRC, "worker.js").then(String),
    read(VENDOR, "yani_wasm_bg.wasm"),
    read(VENDOR, "yani_wasm.js").then(String),
    read(VENDOR, "plotly-basic.min.js"),
  ]);

  // plots.js, python.js, ranges.js and spectra.js are imported by app.js as
  // modules. With everything inlined into one <script type="module"> there is
  // no module graph left to resolve, so the imports are dropped and the files
  // concatenated -- app.js last, since it is the one calling into the others.
  const app = appJs.replace(/^import\s+\{[^}]*\}\s+from\s+"\.\/(plots|python|ranges|spectra)\.js";\s*$/gm, "");
  const plots = plotsJs.replace(/^export\s+/gm, "");
  const python = pythonJs.replace(/^export\s+/gm, "");
  const ranges = rangesJs.replace(/^export\s+/gm, "");
  const spectra = spectraJs.replace(/^export\s+/gm, "");

  const plotlyGz = gzipSync(plotly, { level: 9 });

  // worker.js is inlined as a string rather than concatenated: it is the
  // source the page hands to `new Worker`, so it has to survive as text.
  const out = html
    .replace('"__WASM_B64__"', JSON.stringify(b64(wasm)))
    .replace('"__WASM_JS__"', JSON.stringify(glue))
    .replace('"__WORKER_JS__"', JSON.stringify(workerJs))
    .replace('"__PLOTLY_GZ_B64__"', JSON.stringify(b64(plotlyGz)))
    .replace("__APP_JS__", () => `${plots}\n${python}\n${ranges}\n${spectra}\n${app}`);

  // A leftover placeholder means the page would fetch from vendor/ at runtime
  // and silently stop being self-contained, which is the one property the
  // single-file build exists to provide.
  const left = out.match(/__[A-Z_]+__/g);
  if (left) throw new Error(`unsubstituted placeholders: ${[...new Set(left)].join(", ")}`);

  // From empty, so a wheel from an earlier `--wheel` build cannot linger.
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await writeFile(new URL("index.html", DIST), out);

  // The Python tab, beside the page.
  const tab = await pythonTab(wheel);
  for (const f of ["script.js", "script-worker.js", "fetcher.js"]) await copyFile(new URL(f, SRC), new URL(f, DIST));
  for (const f of ["codemirror.js", "coi-serviceworker.min.js"]) await copyFile(new URL(f, VENDOR), new URL(f, DIST));
  if (wheel) await copyFile(pathToFileURL(localWheel), new URL(wheel, DIST));
  await writeFile(new URL("config.js", DIST), tab.config);
  // GitHub Pages runs Jekyll otherwise, which would drop nothing here today
  // but has opinions about underscored names.
  await writeFile(new URL(".nojekyll", DIST), "");
  const tabBytes = (await Promise.all(
    ["script.js", "script-worker.js", "fetcher.js", "codemirror.js", "config.js"].map((f) => readFile(new URL(f, DIST))),
  )).reduce((n, b) => n + b.length, 0);

  console.log(
    `dist/index.html  ${mb(Buffer.byteLength(out))}\n` +
    `  wasm          ${mb(wasm.length)} raw -> ${mb(b64(wasm).length)} base64\n` +
    `  plotly-basic  ${mb(plotly.length)} raw -> ${mb(plotlyGz.length)} gzip ` +
    `-> ${mb(b64(plotlyGz).length)} base64\n` +
    `  page + code   ${mb(html.length + app.length + plots.length + pythonJs.length + rangesJs.length + workerJs.length + glue.length)}\n` +
    `  spectra       ${mb(spectraJs.length)}\n` +
    `Python tab, loaded when first opened: ${mb(tabBytes)} beside the page, ` +
    `Pyodide ${tab.pyodideVersion} from the CDN, ` +
    `${wheel ? `yani-core from ${wheel} (not PyPI)` : `yani-core ${tab.yaniCoreVersion} from PyPI`}, ` +
    `${tab.examples.length} examples`,
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
