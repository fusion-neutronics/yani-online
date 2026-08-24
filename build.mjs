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
//   node build.mjs
//
// Run `wasm-pack build --target web` in core's crates/yani-wasm and copy
// pkg/yani_wasm{.js,_bg.wasm} into vendor/ first.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const SRC = new URL("./src/", import.meta.url);
const VENDOR = new URL("./vendor/", import.meta.url);
const DIST = new URL("./dist/", import.meta.url);

const read = (base, name) => readFile(new URL(name, base));
const b64 = (buf) => buf.toString("base64");

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

async function main() {
  const [html, appJs, plotsJs, pythonJs, rangesJs, workerJs, wasm, glue, plotly] = await Promise.all([
    read(SRC, "index.html").then(String),
    read(SRC, "app.js").then(String),
    read(SRC, "plots.js").then(String),
    read(SRC, "python.js").then(String),
    read(SRC, "ranges.js").then(String),
    read(SRC, "worker.js").then(String),
    read(VENDOR, "yani_wasm_bg.wasm"),
    read(VENDOR, "yani_wasm.js").then(String),
    read(VENDOR, "plotly-basic.min.js"),
  ]);

  // plots.js, python.js and ranges.js are imported by app.js as modules. With
  // everything inlined into one <script type="module"> there is no module graph
  // left to resolve, so the imports are dropped and the files concatenated --
  // app.js last, since it is the one calling into the others.
  const app = appJs.replace(/^import\s+\{[^}]*\}\s+from\s+"\.\/(plots|python|ranges)\.js";\s*$/gm, "");
  const plots = plotsJs.replace(/^export\s+/gm, "");
  const python = pythonJs.replace(/^export\s+/gm, "");
  const ranges = rangesJs.replace(/^export\s+/gm, "");

  const plotlyGz = gzipSync(plotly, { level: 9 });

  // worker.js is inlined as a string rather than concatenated: it is the
  // source the page hands to `new Worker`, so it has to survive as text.
  const out = html
    .replace('"__WASM_B64__"', JSON.stringify(b64(wasm)))
    .replace('"__WASM_JS__"', JSON.stringify(glue))
    .replace('"__WORKER_JS__"', JSON.stringify(workerJs))
    .replace('"__PLOTLY_GZ_B64__"', JSON.stringify(b64(plotlyGz)))
    .replace("__APP_JS__", () => `${plots}\n${python}\n${ranges}\n${app}`);

  // A leftover placeholder means the page would fetch from vendor/ at runtime
  // and silently stop being self-contained, which is the one property the
  // single-file build exists to provide.
  const left = out.match(/__[A-Z_]+__/g);
  if (left) throw new Error(`unsubstituted placeholders: ${[...new Set(left)].join(", ")}`);

  await mkdir(DIST, { recursive: true });
  await writeFile(new URL("index.html", DIST), out);

  console.log(
    `dist/index.html  ${mb(Buffer.byteLength(out))}\n` +
    `  wasm          ${mb(wasm.length)} raw -> ${mb(b64(wasm).length)} base64\n` +
    `  plotly-basic  ${mb(plotly.length)} raw -> ${mb(plotlyGz.length)} gzip ` +
    `-> ${mb(b64(plotlyGz).length)} base64\n` +
    `  page + code   ${mb(html.length + app.length + plots.length + pythonJs.length + rangesJs.length + workerJs.length + glue.length)}`,
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
