// A static server for dist/, with nuclear-data fixtures beside it.
//
// Adapted from yamc-online's serve.mjs.
//
//   node serve.mjs [--port 8000] [--no-isolation]
//
// Open http://localhost:8000/ to use the published data, or
// http://localhost:8000/?data=/fixtures/ for the Python tab to read local
// fixtures instead (offline, and what verify.mjs does). The form is not
// redirected: it fetches from the published origin whatever the URL says.
//
// The fixtures are core's crates/yamc/tests (`<Name>.arrow/` per nuclide, and
// the chain as `transmutation-endf-b8.1-sfr.arrow/<subsection>/`), filled by
// `python3 scripts/fetch_test_fixtures.py` in core; set YANI_FIXTURES to point
// elsewhere. Anything not there is looked for in .fixtures/, which
// `node scripts/fetch-fixtures.mjs` fills from the current published release
// (the chain there as `transmutation/<subsection>.arrow/`). Both are endf-b8.1.
//
// They are served in the published release layout: a `latest.json` naming a
// release called `fixtures`, whose `manifest.json` lists every fixture file
// with its size and sha256, worked out here from the files themselves, so the
// wheel checks what it reads as it does against the origin. A `version.json`
// whose byte-range index carries no sha256 per entry (core's fixtures predate
// them) is served with them added, as core's converter adds them to a
// published tree, so the wheel reads byte ranges here as it does from a
// release that has them.
//
// The page is served cross-origin isolated, as GitHub Pages serves it once
// coi-serviceworker has reloaded it, so Stop can interrupt Python.
// `--no-isolation` serves it without, to check the fallbacks.

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("./dist/", import.meta.url));
export const FIXTURES = resolve(process.env.YANI_FIXTURES || fileURLToPath(new URL("../core/crates/yamc/tests/", import.meta.url)));
export const FETCHED_FIXTURES = fileURLToPath(new URL("./.fixtures/", import.meta.url));
// Core's chain fixture, named for the library and the chain it was cut from.
const CORE_CHAIN = "transmutation-endf-b8.1-sfr.arrow";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".whl": "application/zip",
};

const KEYWORD = "endf-b8.1";
const RELEASE = "fixtures";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/// `version.json` with a sha256 on every byte-range index entry, taken from
/// the section it indexes. Unchanged if every entry already has one.
function withRangeHashes(versionFile, folder) {
  const bytes = readFileSync(versionFile);
  const version = JSON.parse(bytes);
  let added = false;
  for (const [key, section, nested] of [["reaction_ranges", "reactions.arrow", true], ["energy_ranges", "energy.arrow", false]]) {
    const index = version[key];
    const file = join(folder, section);
    if (!index || !existsSync(file)) continue;
    const body = readFileSync(file);
    const groups = nested ? Object.values(index.mts) : [index.temperatures];
    for (const entry of [index.schema, ...groups.flatMap((g) => Object.values(g))]) {
      if (entry.length >= 3) continue;
      entry[2] = sha256(body.subarray(entry[0], entry[0] + entry[1]));
      added = true;
    }
  }
  return added ? Buffer.from(JSON.stringify(version, null, 2)) : bytes;
}

/// The fixtures as one release: `files` maps each path in the release
/// (`neutron/Fe56.arrow/reactions.arrow`, `transmutation/decay.arrow/nuclides.arrow`)
/// to a function answering its bytes, and `latest` and `manifest` are the two
/// index objects. Only the `version.json`s are held; the rest are read per
/// request, since core's fixtures are a gigabyte. A path in both fixture directories is read from the first. Built
/// on first use.
let release = null;
function fixtureRelease() {
  if (release) return release;
  const files = new Map();
  const add = (releaseDir, dir) => {
    for (const f of readdirSync(dir)) {
      const file = join(dir, f);
      if (!/\.(arrow|json)$/.test(f) || !statSync(file).isFile()) continue;
      const path = `${releaseDir}/${f}`;
      if (files.has(path)) continue;
      if (f === "version.json") {
        const bytes = withRangeHashes(file, dir);
        files.set(path, () => bytes);
      } else {
        files.set(path, () => readFileSync(file));
      }
    }
  };
  for (const root of [FIXTURES, FETCHED_FIXTURES]) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      const dir = join(root, d);
      if (!statSync(dir).isDirectory()) continue;
      if (d === CORE_CHAIN) {
        for (const sub of readdirSync(dir)) {
          if (statSync(join(dir, sub)).isDirectory()) add(`transmutation/${sub}.arrow`, join(dir, sub));
        }
      } else if (d === "transmutation") {
        for (const sub of readdirSync(dir)) {
          if (sub.endsWith(".arrow")) add(`transmutation/${sub}`, join(dir, sub));
        }
      } else if (d.endsWith(".arrow")) {
        // A nuclide's name carries its mass number and an element's does not.
        add(`${/\d/.test(d) ? "neutron" : "photon"}/${d}`, dir);
      }
    }
  }
  const manifest = Buffer.from(JSON.stringify({
    schema: "yamc-data-manifest",
    keyword: KEYWORD,
    release: RELEASE,
    format_version: 2,
    files: [...files].sort().map(([path, read]) => {
      const bytes = read();
      return { path, bytes: bytes.length, sha256: sha256(bytes) };
    }),
  }));
  const latest = Buffer.from(JSON.stringify({
    schema: "yamc-data-latest",
    keyword: KEYWORD,
    release: RELEASE,
    format_version: 2,
    manifest: `${RELEASE}/manifest.json`,
    manifest_bytes: manifest.length,
    manifest_sha256: sha256(manifest),
  }));
  release = { files, latest, manifest };
  return release;
}

/// Answer a `/fixtures/` request: the release index, or a fixture file by
/// its path in the release. Anything else is not in the fixtures.
function sendFixture(req, res, path, headers) {
  const rel = path.slice("/fixtures/".length);
  const { files, latest, manifest } = fixtureRelease();
  const prefix = `${KEYWORD}/${RELEASE}/`;
  const index = { [`${KEYWORD}/latest.json`]: latest, [`${KEYWORD}/${RELEASE}/manifest.json`]: manifest }[rel];
  const read = rel.startsWith(prefix) && files.get(rel.slice(prefix.length));
  if (!index && !read) return res.writeHead(404, headers).end("not in the fixtures");
  return sendBytes(req, res, index || read(), extname(rel), headers);
}

function staticPath(path) {
  const file = normalize(join(DIST, path.endsWith("/") ? `${path}index.html` : path));
  return file.startsWith(DIST) ? file : null;
}

/// Answer with `body`, honouring a `Range` header as the data origin does: one
/// range is a plain 206, several are a `multipart/byteranges` 206.
function sendBytes(req, res, body, ext, headers) {
  const size = body.length;
  const type = TYPES[ext] || "application/octet-stream";
  const spec = req.headers.range && req.headers.range.match(/^bytes=(\d+-\d+(?:,\d+-\d+)*)$/);
  const ranges = spec
    ? spec[1].split(",").map((r) => r.split("-").map(Number)).map(([a, b]) => [a, Math.min(b, size - 1)])
    : [];
  if (ranges.length === 1) {
    const [start, end] = ranges[0];
    res.writeHead(206, { ...headers, "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}` });
    res.end(body.subarray(start, end + 1));
  } else if (ranges.length > 1) {
    const boundary = "yani-online-fixtures";
    const parts = ranges.map(([a, b]) => Buffer.concat([
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${type}\r\nContent-Range: bytes ${a}-${b}/${size}\r\n\r\n`),
      body.subarray(a, b + 1),
    ]));
    const multipart = Buffer.concat([...parts, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    res.writeHead(206, { ...headers, "Content-Type": `multipart/byteranges; boundary=${boundary}`, "Content-Length": multipart.length });
    res.end(multipart);
  } else {
    res.writeHead(200, { ...headers, "Content-Type": type, "Content-Length": size });
    res.end(body);
  }
}

function sendFile(req, res, file, headers) {
  let st;
  try {
    st = statSync(file);
    if (!st.isFile()) throw new Error("not a file");
  } catch {
    res.writeHead(404, headers).end("not found");
    return;
  }
  if (req.headers.range) {
    sendBytes(req, res, readFileSync(file), extname(file), headers);
    return;
  }
  res.writeHead(200, { ...headers, "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Content-Length": st.size });
  createReadStream(file).pipe(res);
}

export function serve({ port = 8000, isolation = true } = {}) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const headers = { "Cache-Control": "no-store" };
    if (isolation) {
      headers["Cross-Origin-Opener-Policy"] = "same-origin";
      headers["Cross-Origin-Embedder-Policy"] = "require-corp";
    }
    if (path.startsWith("/fixtures/")) return sendFixture(req, res, path, headers);
    const file = staticPath(path);
    if (!file) return res.writeHead(403, headers).end();
    return sendFile(req, res, file, headers);
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? Number(args[portArg + 1]) : 8000;
  const server = await serve({ port, isolation: !args.includes("--no-isolation") });
  console.log(`http://localhost:${server.address().port}/  (fixtures: ${FIXTURES}, then ${FETCHED_FIXTURES})`);
}
