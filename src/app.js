// Application logic: set up a calculation, fetch exactly the data it needs,
// run it off the main thread, hand the results to the plots.
//
// Loaded as a module from index.html, which supplies WASM_B64, WASM_JS,
// WORKER_JS and PLOTLY_GZ_B64 as inlined payloads.
//
// The solver itself lives in a Worker (src/worker.js); everything here is the
// page around it. The division is: this thread fetches, because fetching is
// waiting and the data origin is answered from a cache edge, and the worker
// holds the wasm session, because parsing a chain and solving a network are
// the parts that would otherwise stop the page dead for the duration.

import { drawAll, drawPhotons, drawSpectrum, wireAxisScales } from "./plots.js";
import { pythonScript } from "./python.js";
import { assembleNuclideData, planNuclide, rangeHeader } from "./ranges.js";

// --- nuclear data ---------------------------------------------------------

const ORIGIN = "https://yamc-data.xsplot.com";

// Which library publishes which chain subsection. Mirrors
// `keyword_transmutation_subsections` in yamc-nuclide/src/storage/url_cache.rs.
// Offering a library a subsection it does not publish fails at fetch time with
// a 404, so the dropdowns are built from this rather than from a flat list.
const LIBRARIES = {
  "endf-b8.1": { xs: true, decay: true, reactions: true, fission_yields: true, branching: true },
  "jeff-4.0": { xs: true, decay: true, reactions: true, fission_yields: true, branching: true },
  "jendl-5.0": { xs: true, decay: true, reactions: true, fission_yields: true, branching: true },
  "tendl-2025": { xs: true, decay: false, reactions: true, fission_yields: false, branching: true },
  "tendl-2017": { xs: true, decay: false, reactions: true, fission_yields: false, branching: true },
  "fendl-3.2d": { xs: true, decay: false, reactions: false, fission_yields: false, branching: false },
};

// ENDF/B-8.1 by default for every subsection. Three libraries publish a
// complete, self-consistent network (it, jeff-4.0 and jendl-5.0), and this one
// is the default because it is what the rest of the stack defaults to, so a
// calculation set up here matches one set up in yamc without being told to.
//
// TENDL covers far more parent nuclides for `reactions` and is the better
// choice when it is available, but making it the default would silently require
// a second library for decay.
const DEFAULTS = {
  xs: "endf-b8.1",
  reactions: "endf-b8.1",
  decay: "endf-b8.1",
  fission_yields: "endf-b8.1",
  branching: "endf-b8.1",
};

// The section files each chain subsection publishes, and whether a 404 is
// fatal. Mirrors `transmutation_sections` in url_cache.rs, less the
// `provenance.json` each subsection now also carries: the solver takes it and
// does nothing with it, so fetching it would be one request per subsection
// spent on bytes nothing reads.
const CHAIN_SECTIONS = {
  decay: [["nuclides.arrow", true], ["decay_modes.arrow", false], ["sources.arrow", false]],
  reactions: [["reactions.arrow", true]],
  fission_yields: [["fission_yields.arrow", true], ["aliases.arrow", false]],
  // Optional as a whole, not just per-file. The isomeric-branching overlay is
  // an overlay: `parse_chain_parts` takes it as an Option, and core's config
  // defaults `transmutation_branch_ratios` to None. Marking its file required
  // makes a library that does not publish one fail the entire chain load,
  // which is what it did.
  branching: [["branching.arrow", false]],
};

// --- spectra --------------------------------------------------------------

// Coarse shapes, deliberately. These are starting points for someone without a
// tallied spectrum; anyone with one should paste it against a named group
// structure instead, where the boundaries are exact.
const PRESETS = {
  "fusion-fw": {
    label: "Fusion first wall",
    boundaries: [1e-5, 1e2, 1e4, 1e5, 1e6, 5e6, 1.2e7, 1.5e7],
    // Seven groups for eight boundaries, the last carrying the 14 MeV peak.
    values: [0.06, 0.05, 0.06, 0.10, 0.18, 0.15, 0.40],
  },
  "dt-point": {
    label: "D-T point source",
    boundaries: [1e-5, 1e5, 1e6, 1.2e7, 1.5e7],
    values: [0.01, 0.02, 0.05, 0.92],
  },
  "fission-pwr": {
    label: "Fission, PWR-like",
    boundaries: [1e-5, 0.625, 1e3, 1e5, 1e6, 1e7],
    values: [0.42, 0.16, 0.14, 0.18, 0.10],
  },
  thermal: {
    label: "Thermal Maxwellian",
    boundaries: [1e-5, 0.025, 0.1, 1.0, 1e3, 1e6],
    values: [0.55, 0.24, 0.13, 0.06, 0.02],
  },
};

// A preset with the wrong number of values is only caught by the solver, deep
// in a run, as "boundaries (8) must be one longer than masses (8)" -- after the
// user has waited through a data download. Checked at load instead, so a typo
// here fails immediately and visibly rather than at the worst moment.
for (const [name, preset] of Object.entries(PRESETS)) {
  if (preset.boundaries.length !== preset.values.length + 1) {
    throw new Error(
      `spectrum preset '${name}': ${preset.boundaries.length} boundaries needs ` +
      `${preset.boundaries.length - 1} values, has ${preset.values.length}`);
  }
}

// --- state ----------------------------------------------------------------

const state = {
  solver: null,
  chainLoaded: false,
  // What the vendored solver can do that an older one could not. Feature
  // detected at boot rather than read off vendor/CORE_COMMIT: the page has to
  // choose a fetch strategy before it has fetched anything, and a commit hash
  // is not a capability.
  caps: {},
  // The material currently in the session, as the arguments that built it.
  // Compared before rebuilding: a fresh Material is an empty one, and throwing
  // the old one away throws away the cross sections decoded into it.
  materialKey: null,
  // The MT numbers the loaded chain names, from the solver, or null when this
  // build cannot say. Null is what puts the fetch back on whole files: the set
  // decides which byte ranges to ask for, and guessing it wrong is a reaction
  // rate that silently collapses to zero rather than a 404.
  wantedMts: null,
  // Nuclides whose cross sections are already in the session. Checked before
  // every fetch so changing a schedule, a spectrum or the volume re-solves
  // without touching the network, and changing the material fetches only the
  // difference.
  haveNuclide: new Set(),
  // What those cross sections were fetched for: the library and the
  // temperature, as `dataKey` spells them. A held nuclide is only held for the
  // data it was fetched from, so when either changes the set above is emptied
  // and every nuclide is fetched again, from the other library or at the other
  // temperature.
  dataKey: null,
  results: null,
  // A year of irradiation, then cooling sampled log-spaced from an hour to ten
  // years. A single cooldown step is a defensible default and a useless plot:
  // two points a day apart on a log axis show nothing, and the whole shape of
  // an activation problem is which nuclide dominates at which decade. Each
  // cooldown's duration is the length of *that step*, so these are the gaps
  // between the cumulative times, not the times themselves.
  schedule: [
    { kind: "pulse", rate: 1e14, value: 1, unit: "a" },
    { kind: "cooldown", value: 1, unit: "h" },
    { kind: "cooldown", value: 5, unit: "h" },
    { kind: "cooldown", value: 18, unit: "h" },
    { kind: "cooldown", value: 3, unit: "d" },
    { kind: "cooldown", value: 10, unit: "d" },
    { kind: "cooldown", value: 46, unit: "d" },
    { kind: "cooldown", value: 305, unit: "d" },
    { kind: "cooldown", value: 3, unit: "a" },
    { kind: "cooldown", value: 6, unit: "a" },
  ],
  composition: [{ name: "Fe", fraction: 1.0 }],
};

const $ = (id) => document.getElementById(id);
const setStatus = (text) => { $("status").textContent = text; };
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
function warn(text) {
  const el = $("warning");
  el.hidden = !text;
  el.textContent = text || "";
}

// --- wasm bootstrap -------------------------------------------------------

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/// Inflate a gzipped base64 payload. Used for plotly-basic, which is 1.07 MB
/// raw but 0.36 MB gzipped -- worth the four lines to keep the single file
/// under control.
async function gunzipB64(b64) {
  const stream = new Blob([b64ToBytes(b64)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// --- the solver, and where it runs ----------------------------------------

/// One end of the message protocol in worker.js, with the ids and the promises
/// hidden behind ordinary method calls.
///
/// Every method is async because the solver is not on this thread. That is the
/// whole cost of the move, and it is paid here rather than at the call sites,
/// which read as they did.
class Solver {
  constructor(host) {
    this.host = host;
    this.pending = new Map();
    this.nextId = 1;
    // Set once the far side is gone. A worker that dies -- out of memory on a
    // large closure is the way it would -- takes its session with it, so every
    // later call is answered with the same error rather than left hanging.
    this.dead = null;
    host.onmessage = ({ data }) => {
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      if (data.error === undefined) entry.resolve(data.value);
      else entry.reject(new Error(data.error));
    };
    // Every call in flight dies with it, and a promise that never settles is a
    // UI stuck on "Solving…" with nothing to report.
    host.onerror = (e) => this.fail(new Error(e.message || "the solver stopped"));
  }

  fail(error) {
    this.dead = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  call(method, args = [], transfer = []) {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.host.postMessage({ id, method, args }, transfer);
    });
  }

  init(payload) { return this.call("init", [payload]); }
  pnnlNames() { return this.call("pnnlNames"); }
  pnnlSearch(query) { return this.call("pnnlSearch", [query]); }
  groupStructure(name) { return this.call("groupStructure", [name]); }
  requiredNuclides() { return this.call("requiredNuclides"); }
  capabilities() { return this.call("capabilities"); }
  requiredMts() { return this.call("requiredMts"); }
  durationsToSeconds(steps) { return this.call("durationsToSeconds", [steps]); }
  pnnlMaterial(name, volume) { return this.call("pnnlMaterial", [name, volume]); }
  buildMaterial(...args) { return this.call("buildMaterial", args); }
  loadChain() { return this.call("loadChain"); }
  run(spectraJson, scheduleJson) { return this.call("run", [spectraJson, scheduleJson]); }

  // The two that hand over data. The buffers are transferred rather than
  // copied, so a few hundred MB of cross sections cross for free -- and are
  // detached here afterwards, which is why the byte count comes back from the
  // other side rather than being measured on this one.
  addChainSections(sections) {
    return this.call("addChainSections", [sections], sections.map((s) => s.bytes.buffer));
  }
  addNuclideData(items) {
    return this.call("addNuclideData", [items], items.map((i) => i.bytes.buffer));
  }
}

/// Turn the wasm-bindgen glue into a classic script.
///
/// The glue is generated by `wasm-pack build --target web`, so it is an ES
/// module. The worker has to be a classic script (a module Worker will not
/// load a blob URL on an opaque origin), and a classic worker cannot pull the
/// module in either: Safari refuses to load *any* second script into a worker
/// from a blob -- "Cross-origin script load denied by Cross-Origin Resource
/// Sharing policy" -- for `importScripts` and dynamic `import()` alike. So
/// there is no second script. The glue is converted here and concatenated into
/// the one blob the worker is made of.
///
/// This is the same shape `wasm-pack build --target no-modules` would produce,
/// done at boot instead of in core's build, so this repository keeps vendoring
/// a single `--target web` package.
///
/// `import.meta.url` has to go even though the branch using it never runs: it
/// is a syntax error in a classic script, so the parse fails before anything
/// executes.
function glueToClassic(source) {
  const classic = source
    .replace(/^export\s+\{[^}]*\};?[ \t]*$/gm, "")
    .replace(/^export\s+(?=(?:async\s+)?(?:class|function|const|let|var)\b)/gm, "")
    .replace(/\bimport\.meta\.url\b/g, "self.location.href");
  // Anything left is a module form this does not know about, and the failure it
  // would otherwise cause is a parse error inside a blob with no line to look
  // at. Better to say so here, where the text is still in hand.
  const leftover = classic.match(/^\s*(?:export|import)\b.*$/m);
  if (leftover) {
    throw new Error(`the wasm glue has a module form this build does not handle: ${leftover[0].trim()}`);
  }
  return classic;
}

/// Start the solver in a Worker.
///
/// One blob, holding the glue and worker.js, evaluated as one strict-mode
/// function so the glue's module semantics survive and nothing it declares
/// lands on the worker's global object.
///
/// There is no main-thread fallback. Chromium, Firefox and WebKit all start
/// this worker from `file://`, and a browser that cannot is better off saying
/// so than quietly freezing on every solve. (WebKit starts the worker and then
/// rejects the wasm itself, which is a build flag in core rather than anything
/// a fallback could rescue -- see dev-readme.md.)
async function bootSolver() {
  const glueSource = WASM_JS.startsWith("__")
    ? await (await fetch("./yani_wasm.js")).text()
    : WASM_JS;
  const workerSource = WORKER_JS.startsWith("__")
    ? await (await fetch("./worker.js")).text()
    : WORKER_JS;
  const wasm = WASM_B64.startsWith("__")
    ? { wasmBytes: await (await fetch("./yani_wasm_bg.wasm")).arrayBuffer() }
    : { wasmB64: WASM_B64 };

  const source = `(function () {\n"use strict";\n${glueToClassic(glueSource)}\n${workerSource}\n})();`;
  const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "application/javascript" })));
  const solver = new Solver(worker);
  await solver.init(wasm);
  return solver;
}

async function bootPlotly() {
  if (PLOTLY_GZ_B64.startsWith("__")) {
    await import("./vendor/plotly-basic.min.js");
  } else {
    const src = await gunzipB64(PLOTLY_GZ_B64);
    // Plotly-basic is a UMD bundle, not a module, so it is evaluated rather
    // than imported and lands on window.Plotly.
    new Function(src)();
  }
}

// --- fetching -------------------------------------------------------------

/// Fetch with a bounded number of concurrent requests, reporting progress.
///
/// The origin is Cloudflare in front of R2 with a one-year TTL, so repeat
/// visits are answered from the edge cache and never reach the bucket. The cap
/// exists to keep a few hundred parallel requests from starving the UI thread,
/// not to be polite to the origin.
///
/// A job carrying a `range` asks for those bytes alone. The origin serves
/// `accept-ranges: bytes` and answers a range 206 out of the same edge cache as
/// the whole object, so a slice costs what a file costs. The status is written
/// back onto the job because the caller has to be able to tell 206 from 200: a
/// proxy that strips the header answers with the entire object, and splicing
/// that as though it were the slice asked for yields a stream of the wrong
/// bytes that still decodes.
async function fetchAll(jobs, onProgress, limit = 12) {
  let done = 0;
  let next = 0;
  const results = new Array(jobs.length);
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      const job = jobs[i];
      try {
        const resp = await fetch(
          job.url, job.range ? { headers: { Range: rangeHeader(job.range) } } : undefined);
        job.status = resp.status;
        if (resp.ok) {
          results[i] = new Uint8Array(await resp.arrayBuffer());
        } else if (!job.optional) {
          throw new Error(`${resp.status} ${job.url}`);
        }
      } catch (e) {
        if (!job.optional) throw e;
      }
      onProgress(++done / jobs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

async function loadChain(solver) {
  const jobs = [];
  for (const [subsection, files] of Object.entries(CHAIN_SECTIONS)) {
    const library = DEFAULTS[subsection] && $(`data-${shortKey(subsection)}`)?.value;
    if (!library) continue;
    for (const [file, required] of files) {
      jobs.push({
        url: `${ORIGIN}/${library}/transmutation/${subsection}.arrow/${file}`,
        optional: !required,
        subsection,
        file,
      });
    }
  }
  setStatus("Fetching the transmutation chain…");
  const bytes = await fetchAll(jobs, (f) => { $("progress").value = f; });
  const sections = [];
  jobs.forEach((job, i) => {
    if (bytes[i]) sections.push({ subsection: job.subsection, file: job.file, bytes: bytes[i] });
  });
  await solver.addChainSections(sections);
  setStatus("Parsing the transmutation chain…");
  const n = await solver.loadChain();
  setStatus(`Chain loaded: ${n.toLocaleString()} nuclides.`);
  return n;
}

const shortKey = (subsection) =>
  ({ decay: "decay", reactions: "reactions", fission_yields: "fpy", branching: "branching" }[subsection]);

/// The fetch plan for one nuclide, from its `version.json`, or `null` to fetch
/// every file whole.
///
/// A `version.json` that does not parse is left for the solver to complain
/// about: it is handed over either way, and the error it raises there names the
/// section, where one raised here would name a fetch and send the reader
/// looking in the wrong place.
///
/// Which temperature to read at is decided here, per nuclide, as the published
/// label nearest the one on the form. The solver is not told: it reads the
/// spliced stream, finds one temperature carrying reactions, and settles on it,
/// which is the same rule it applies to a whole file with every temperature in
/// it, where it settles on the lowest. Fetching one temperature is what makes
/// that rule land on the one asked for.
function nuclidePlan(versionBytes, wantedMts, kelvin) {
  let version;
  try {
    version = JSON.parse(new TextDecoder().decode(versionBytes));
  } catch {
    return null;
  }
  return planNuclide(version, wantedMts, kelvin);
}

/// The temperature on the form, in Kelvin. An empty or unreadable field is
/// 294 K, which is what the wheel's `Material` reports when none is given.
function requestedKelvin() {
  const text = $("temperature").value.trim();
  const value = Number(text);
  return text !== "" && Number.isFinite(value) && value >= 0 ? value : 294;
}

/// The library and temperature the cross sections are fetched for, as one
/// string to compare against the last fetch's.
function dataKey() {
  return `${$("data-xs").value} at ${requestedKelvin()} K`;
}

/// How many cross-section requests to keep in flight at once.
///
/// Well above the default for a fetch of a few whole files, because reading one
/// temperature turns each nuclide into about nine small range requests (seven
/// for the reactions, two for the grid), and a small request costs its round
/// trip rather than its bytes: measured against the origin, twenty ranges of
/// 64 kB take 0.6 s over one connection. Every request here goes to one HTTP/2
/// origin, which multiplexes them over a connection or two, so this is streams
/// on a connection rather than sockets. Measured on the 462-nuclide Fe56
/// closure, 5019 requests for 156 MB: 38 s with 12 in flight, 26 s with 24,
/// 21 s with 48 and 19 s with 96, so past this it is noise.
const XS_CONCURRENCY = 48;

/// Fetch the cross sections for `nuclides`, and say what came back.
///
/// Two passes, because the first one is the index for the second. `version.json`
/// is a few tens of kB, the loader requires it anyway, and it carries the byte
/// range of every (MT, temperature) record batch in `reactions.arrow` and of
/// every temperature's grid in `energy.arrow`. So it is fetched first, and what
/// it says decides how the two big files are fetched:
///
///   - an index, and a solver that can say which MTs it needs and read a
///     spliced stream: the wanted MTs at the one published temperature nearest
///     the form's, and the grid at that temperature, as range requests.
///     Measured on the 462-nuclide closure of Fe56 against ENDF/B-8.1, that is
///     a fifth of the bytes that every temperature of the wanted MTs was, and a
///     thirtieth of the whole files.
///   - anything else: the whole files, which is what this did before.
///
/// Fetching `version.json` first pays for itself on the fallback path too. The
/// chain names far more nuclides than any one library publishes, and an
/// unpublished nuclide used to 404 three times; now it 404s once and the rest of
/// its requests are never issued.
///
/// Every fetch here is optional, which is a deliberate difference from the
/// wheel. The chain names more nuclides than any single library evaluates, so a
/// handful of 404s is normal rather than exceptional, and failing the run over
/// one would make the app unusable on a library with a gap. What is NOT
/// acceptable is swallowing them: a nuclide with no cross sections reacts at
/// zero, so the count is surfaced rather than logged.
async function loadCrossSections(solver, nuclides) {
  const library = $("data-xs").value;
  const kelvin = requestedKelvin();
  const url = (nuclide, file) => `${ORIGIN}/${library}/neutron/${nuclide}.arrow/${file}`;

  setStatus(`Checking what ${nuclides.length} nuclides publish…`);
  const versions = await fetchAll(
    nuclides.map((nuclide) => ({ url: url(nuclide, "version.json"), optional: true, nuclide })),
    (f) => { $("progress").value = f; }, XS_CONCURRENCY);

  const items = [];
  const missing = new Set();
  // Nuclide to file to the plan its range requests were issued from.
  const plans = new Map();
  const jobs = [];
  // How many nuclides were planned at each temperature label, for the status:
  // the label chosen is the nearest published one, which is usually the one
  // asked for and is worth saying when it is not.
  const temperatures = new Map();
  for (const [i, nuclide] of nuclides.entries()) {
    if (!versions[i]) {
      // Not published by this library. Nothing else under this directory can
      // exist, so the rest of that nuclide's requests are not made.
      missing.add(nuclide);
      continue;
    }
    items.push({ nuclide, file: "version.json", bytes: versions[i] });
    jobs.push({ url: url(nuclide, "nuclide.arrow"), optional: true, nuclide, file: "nuclide.arrow" });

    const plan = state.wantedMts && nuclidePlan(versions[i], state.wantedMts, kelvin);
    if (plan && plan.temperature !== null) {
      temperatures.set(plan.temperature, (temperatures.get(plan.temperature) || 0) + 1);
    }
    // The union energy grids, their own object since fusion-neutronics/core#100
    // moved them out of nuclide.arrow. Every cross section is interpolated
    // against them, so a nuclide without this one cannot activate: core refuses
    // the load outright rather than answering with no grid. One grid is fetched
    // when the index says where it is, the whole file when it does not.
    //
    // Optional in the same sense the others are: a 404 puts the nuclide in
    // `missing` and the count is surfaced, which beats failing the whole run
    // over one nuclide the library does not carry.
    const files = [["energy.arrow", plan && plan.energy], ["reactions.arrow", plan && plan.reactions]];
    for (const [file, filePlan] of files) {
      if (!filePlan) {
        jobs.push({ url: url(nuclide, file), optional: true, nuclide, file });
        continue;
      }
      if (!plans.has(nuclide)) plans.set(nuclide, new Map());
      plans.get(nuclide).set(file, filePlan);
      filePlan.spans.forEach((range, spanIndex) => {
        jobs.push({ url: url(nuclide, file), range, spanIndex, optional: true, nuclide, file });
      });
    }
  }

  let budget = 0;
  let whole = 0;
  for (const byFile of plans.values()) {
    for (const plan of byFile.values()) {
      budget += plan.bytes;
      whole += plan.full;
    }
  }
  const count = nuclides.length - missing.size;
  const labels = [...temperatures.keys()].sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b));
  setStatus(
    `Fetching cross sections for ${count} nuclides` +
    (labels.length ? ` at ${labels.join(", ")}` : "") +
    (plans.size ? `, ${mb(budget)} rather than ${mb(whole)}…` : "…"));
  $("progress").value = 0;
  const bytes = await fetchAll(jobs, (f) => { $("progress").value = f; }, XS_CONCURRENCY);

  // The assembly is in ranges.js so it can be checked without a browser: which
  // span belongs to which stream, and what to do with a range that came back as
  // a whole file, are the decisions here whose mistakes are silent.
  const got = assembleNuclideData(jobs, bytes, plans);
  items.push(...got.items);
  for (const nuclide of got.missing) missing.add(nuclide);
  if (got.stripped) {
    // A proxy that strips the header strips it from every request, so a plan of
    // several spans downloads the whole file several times. The requests
    // already in flight here pay that; the next run does not, and it is the
    // runs after the first that a session spends.
    state.wantedMts = null;
  }

  const held = await solver.addNuclideData(items);
  return { held, missing: [...missing], saved: got.saved };
}

// --- building the calculation --------------------------------------------

function activeTab(panel) {
  return panel.querySelector('[role="tab"][aria-selected="true"]').dataset.tab;
}

/// The arguments that would build the material the form describes.
///
/// Split out from applying it so the two can be compared: what decides whether
/// a rebuild is needed is exactly what the builders are passed.
function materialSpec() {
  const volume = Number($("volume").value);
  const materialPanel = document.querySelector(".panel");
  if (activeTab(materialPanel) === "pnnl") {
    const name = $("pnnl-select").value;
    if (!name) throw new Error("choose a material");
    return { kind: "pnnl", args: [name, volume] };
  }
  const composition = {};
  for (const { name, fraction } of state.composition) {
    if (name.trim()) composition[name.trim()] = fraction;
  }
  if (!Object.keys(composition).length) throw new Error("the composition is empty");
  return {
    kind: "custom",
    args: [
      JSON.stringify(composition),
      Number($("density").value),
      $("density-units").value,
      $("fraction-type").value,
      volume,
    ],
  };
}

/// Put the material the form describes into the session, if it is not there.
///
/// The skip is the point, not an optimisation of the call itself. The solver
/// decodes each nuclide's cross sections into the material it was handed and
/// keeps them there, and the global cache behind that holds only weak
/// references (core#588), so a rebuilt material is an empty one and the next
/// solve re-decodes every reachable nuclide. Rebuilding on every run, which is
/// what this did, threw that away every time.
///
/// It is the page's own interaction loop that this buys: changing a schedule, a
/// spectrum or a step and running again touches nothing about the material, and
/// that is most of what anyone does here after the first run.
///
/// The key is the builder arguments themselves, so anything that changes the
/// material -- composition, density, units, fraction type, volume -- rebuilds,
/// and the decoded data goes with the material it belonged to. Set after the
/// call, so a build that failed is not recorded as applied.
///
/// The library and temperature the cross sections come from are in the key as
/// well, though the builder never sees them, for the same reason: the material
/// holds the sections decoded into it, and a change of either is a change of
/// what every one of those should say. Rebuilding is what lets go of them, so
/// that the next solve decodes what `ensureData` fetches in their place rather
/// than reading the cached ones through.
async function applyMaterial(solver) {
  const spec = materialSpec();
  const key = JSON.stringify({ spec, data: dataKey() });
  if (key === state.materialKey) return;
  // Cleared first: a failed build leaves the session holding whichever material
  // it had before, and calling that one applied would run the next solve
  // against a material the form no longer describes.
  state.materialKey = null;
  await (spec.kind === "pnnl"
    ? solver.pnnlMaterial(...spec.args)
    : solver.buildMaterial(...spec.args));
  state.materialKey = key;
}

async function currentSpectrum() {
  const panel = [...document.querySelectorAll(".panel")].find((p) =>
    p.querySelector("#spectrum-preset, #group-structure"));
  if (activeTab(panel) === "preset") {
    const preset = PRESETS[$("spectrum-preset").value];
    return { boundaries: preset.boundaries, values: preset.values };
  }
  const values = $("group-flux").value.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (values.some(Number.isNaN)) throw new Error("the pasted flux has a non-numeric entry");
  // Boundaries come from the wasm side so the browser and the wheel agree on
  // what "CCFE-709" means, rather than this file carrying a second copy.
  const boundaries = await state.solver.groupStructure($("group-structure").value);
  if (values.length !== boundaries.length - 1) {
    throw new Error(
      `${$("group-structure").value} has ${boundaries.length - 1} groups, ` +
      `but ${values.length} values were given`);
  }
  return { boundaries, values };
}

/// Durations come from the solver's own unit table rather than a copy of it
/// here: one round trip for the whole schedule, and no second definition of
/// what "a" means to drift away from the wheel's.
async function currentSchedule(solver) {
  const seconds = await solver.durationsToSeconds(
    state.schedule.map(({ value, unit }) => ({ value, unit })));
  return state.schedule.map((step, i) =>
    step.kind === "pulse"
      ? { dt: seconds[i], rate: step.rate, spectrum: 0 }
      : { dt: seconds[i] });
}

/// The form's state, resolved into plain data.
///
/// Everything the script generator needs and nothing it does not: no DOM, no
/// solver handle. The one part that has to be asked for is a named group
/// structure's boundaries, and those the generator does not use -- `Histogram`
/// resolves the name itself -- so this stays synchronous except where the
/// spectrum tab makes it otherwise.
async function currentSetup() {
  const materialPanel = document.querySelector(".panel");
  const volume = Number($("volume").value);
  const material = activeTab(materialPanel) === "pnnl"
    ? { kind: "pnnl", name: $("pnnl-select").value, volume }
    : {
      kind: "custom",
      composition: Object.fromEntries(
        state.composition.filter((c) => c.name.trim()).map((c) => [c.name.trim(), c.fraction])),
      density: Number($("density").value),
      units: $("density-units").value,
      fractionType: $("fraction-type").value,
      volume,
    };
  if (material.kind === "pnnl" && !material.name) throw new Error("choose a material");
  if (material.kind === "custom" && !Object.keys(material.composition).length) {
    throw new Error("the composition is empty");
  }

  const panel = [...document.querySelectorAll(".panel")].find((p) =>
    p.querySelector("#spectrum-preset, #group-structure"));
  const preset = PRESETS[$("spectrum-preset").value];
  const spectrum = activeTab(panel) === "preset"
    ? { label: preset.label, boundaries: preset.boundaries, values: preset.values }
    : { structure: $("group-structure").value, values: (await currentSpectrum()).values };

  return {
    libraries: {
      xs: $("data-xs").value,
      decay: $("data-decay").value,
      reactions: $("data-reactions").value,
      fission_yields: $("data-fpy").value,
      branching: $("data-branching").value,
    },
    temperature: requestedKelvin(),
    material,
    spectrum,
    schedule: state.schedule.map((s) => ({ ...s })),
  };
}

/// Hand the browser a file. `download` on an anchor is the only route that
/// works from `file://` as well as over http, which the export has to.
function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

// --- run ------------------------------------------------------------------

/// Draw the spectrum the run would use, whatever is currently selected.
///
/// Shares `currentSpectrum` with the run rather than reading the form a second
/// time, so what is plotted is what is solved. A spectrum that does not parse
/// -- a half-typed group vector, the wrong count for a structure -- says so and
/// leaves the previous curve up, because clearing the plot on every keystroke
/// is worse than a plot that lags a stale entry by one edit.
///
/// Stale answers are dropped the way the budget's are: `groupStructure` is a
/// round trip to the worker, and a fast typist can outrun it.
let spectrumToken = 0;

async function refreshSpectrum() {
  if (!state.solver) return;
  const token = ++spectrumToken;
  try {
    const { boundaries, values } = await currentSpectrum();
    if (token !== spectrumToken) return;
    drawSpectrum(boundaries, values);
    $("spectrum-status").textContent =
      `${values.length} groups, ${boundaries[0].toExponential(0)} to ` +
      `${boundaries[boundaries.length - 1].toExponential(2)} eV`;
  } catch (e) {
    if (token !== spectrumToken) return;
    $("spectrum-status").textContent = String(e.message || e);
  }
}

/// Report what the current material would have to download.
///
/// Fired by every keystroke and every dropdown, and each answer now takes a
/// round trip, so replies can arrive out of order. `budgetToken` keeps only the
/// newest: a stale answer describes a material the user has already moved on
/// from, and showing it would be worse than showing nothing.
let budgetToken = 0;

async function refreshBudget() {
  if (!state.solver) return;
  const token = ++budgetToken;
  try {
    await applyMaterial(state.solver);
  } catch {
    if (token === budgetToken) {
      $("budget").textContent = "Choose a material to see what needs downloading.";
    }
    return;
  }
  if (token !== budgetToken) return;
  if (!state.chainLoaded) {
    $("budget").textContent = "Run to fetch the chain and see the nuclide count.";
    return;
  }
  const required = await state.solver.requiredNuclides();
  if (token !== budgetToken) return;
  const wanted = required.filter((n) => !heldNuclides().has(n));
  $("budget").textContent = wanted.length
    ? `${required.length} nuclides needed, ${wanted.length} still to fetch.`
    : `${required.length} nuclides needed, all held.`;
}

/// The nuclides held for the library and temperature currently on the form.
///
/// Empty when either has changed since they were fetched: a nuclide held at
/// 294 K is not held at 600 K, and the budget has to say so before the run
/// rather than the run discovering it.
function heldNuclides() {
  return state.dataKey === dataKey() ? state.haveNuclide : new Set();
}

/// Fetch whatever the current material needs that is not already held.
///
/// Called by `run`, not by a button. The data a calculation needs is decided by
/// its material, so a separate "download" step could only ever be right until
/// the material changed -- and then it silently was not, which is worse than
/// slow. Recomputing here means the set can never be stale.
///
/// Already-loaded nuclides are skipped, so iterating on a schedule or a
/// spectrum costs nothing after the first run.
async function ensureData() {
  if (!state.chainLoaded) {
    await loadChain(state.solver);
    state.chainLoaded = true;
    // Which MTs a run reads is a property of the chain, so it is asked once the
    // chain is in and then held: it decides which byte ranges of every
    // nuclide's reactions.arrow are worth fetching. A solver too old to answer
    // leaves it null and every file is fetched whole, as it was.
    if (state.caps.requiredMts) {
      state.wantedMts = new Set(await state.solver.requiredMts());
    }
  }
  const key = dataKey();
  if (state.dataKey !== key) {
    // Fetched for another library or temperature, so held for nothing the
    // current form asks for. The material was rebuilt by `applyMaterial` on the
    // same change, which is what let go of the sections decoded from them.
    state.haveNuclide.clear();
    state.dataKey = key;
  }
  const required = await state.solver.requiredNuclides();
  const wanted = required.filter((n) => !state.haveNuclide.has(n));
  $("budget").textContent =
    `${required.length} nuclides needed` +
    (wanted.length ? `, ${wanted.length} still to fetch.` : ", all held.");
  if (!wanted.length) return;

  const { held, missing, saved } = await loadCrossSections(state.solver, wanted);
  for (const n of wanted) state.haveNuclide.add(n);
  if (missing.length) {
    // Named, not just counted: which nuclides are missing decides whether the
    // answer is usable. A gap in a trace activation product is noise; a gap in
    // something the material is made of is not.
    const shown = missing.slice(0, 12).join(", ");
    warn(
      `No cross sections published for ${missing.length} of ${wanted.length} ` +
      `nuclides: ${shown}${missing.length > 12 ? `, and ${missing.length - 12} more` : ""}. ` +
      `They react at zero, so anything downstream of them is missing from the ` +
      `result rather than wrong.`,
    );
  }
  // The saving is worth naming rather than just being fast. It is the whole
  // point of the byte-range index, and it is the difference between a page that
  // can run a closure over a slow connection and one that cannot.
  setStatus(
    `Loaded ${mb(held)}` +
    (saved ? `, skipping ${mb(saved)} of other temperatures and transport cross sections.` : "."));
}

async function run() {
  const btn = $("run");
  btn.disabled = true;
  warn("");
  $("progress").hidden = false;
  try {
    await applyMaterial(state.solver);
    await ensureData();
    const spectrum = await currentSpectrum();
    const schedule = await currentSchedule(state.solver);
    // The clock is not decoration. A solve is the one operation with no
    // progress to report -- it is a single call into wasm that returns when it
    // is done -- and a counter that keeps counting is how someone watching can
    // tell the page is alive rather than wedged. It ticks because the solve is
    // no longer on this thread; before, it could not have.
    const started = performance.now();
    const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)} s`;
    setStatus("Solving… 0.0 s");
    const tick = setInterval(() => setStatus(`Solving… ${elapsed()}`), 100);
    try {
      state.results = await state.solver.run(
        JSON.stringify([{ boundaries: spectrum.boundaries, values: spectrum.values }]),
        JSON.stringify(schedule),
      );
    } finally {
      clearInterval(tick);
    }
    $("results-empty").hidden = true;
    $("results").hidden = false;
    const slider = $("photon-step");
    slider.max = String(state.results.length - 1);
    slider.value = String(state.results.length - 1);
    $("photon-step-label").value = state.results.length;
    drawAll(state.results);
    drawPhotons(state.results, state.results.length - 1);
    setStatus(`Done in ${elapsed()}. ${state.results.length} steps.`);
  } catch (e) {
    warn(String(e.message || e));
    setStatus("");
  } finally {
    btn.disabled = false;
    $("progress").hidden = true;
  }
}

// --- wiring ---------------------------------------------------------------

function wireTabs() {
  for (const tablist of document.querySelectorAll('[role="tablist"]')) {
    tablist.addEventListener("click", (e) => {
      const btn = e.target.closest('[role="tab"]');
      if (!btn) return;
      const panel = tablist.closest(".panel");
      for (const t of tablist.querySelectorAll('[role="tab"]')) {
        t.setAttribute("aria-selected", String(t === btn));
      }
      for (const body of panel.querySelectorAll("[data-panel]")) {
        body.hidden = body.dataset.panel !== btn.dataset.tab;
      }
      refreshBudget();
      refreshSpectrum();
    });
  }
}

function wireDataDropdowns() {
  const fields = [
    ["data-xs", "xs"],
    ["data-reactions", "reactions"],
    ["data-decay", "decay"],
    ["data-fpy", "fission_yields"],
    ["data-branching", "branching"],
  ];
  for (const [id, subsection] of fields) {
    const select = $(id);
    select.innerHTML = "";
    for (const [name, publishes] of Object.entries(LIBRARIES)) {
      if (!publishes[subsection]) continue;
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      option.selected = name === DEFAULTS[subsection];
      select.append(option);
    }
  }
}

function renderComposition() {
  const body = $("composition");
  body.innerHTML = "";
  state.composition.forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><input value="${row.name}" data-i="${i}" data-k="name"
                  placeholder="Fe, Li6, H2O"></td>` +
      `<td class="num"><input type="number" step="any" value="${row.fraction}"
                  data-i="${i}" data-k="fraction"></td>` +
      `<td><button class="secondary" data-remove="${i}">&times;</button></td>`;
    body.append(tr);
  });
}

function renderSchedule() {
  const body = $("schedule");
  body.innerHTML = "";
  state.schedule.forEach((step, i) => {
    const units = ["s", "min", "h", "d", "a"]
      .map((u) => `<option value="${u}"${u === step.unit ? " selected" : ""}>${u}</option>`)
      .join("");
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${step.kind === "pulse" ? "Pulse" : "Cooldown"}</td>` +
      `<td class="num">${
        step.kind === "pulse"
          ? `<input type="number" step="any" value="${step.rate}" data-s="${i}" data-k="rate">`
          : "--"
      }</td>` +
      `<td class="num"><div class="inline">` +
      `<input type="number" step="any" value="${step.value}" data-s="${i}" data-k="value">` +
      `<select data-s="${i}" data-k="unit">${units}</select></div></td>` +
      `<td><button class="secondary" data-remove-step="${i}">&times;</button></td>`;
    body.append(tr);
  });
}

async function main() {
  wireTabs();
  wireDataDropdowns();
  renderComposition();
  renderSchedule();

  setStatus("Starting the solver…");
  await bootPlotly();
  state.solver = await bootSolver();
  state.caps = await state.solver.capabilities();
  setStatus("Ready. Choose a material, then download the data it needs.");

  // The compendium is compiled into the wasm, so the picker works before a
  // single byte is fetched.
  const names = await state.solver.pnnlNames();
  const fill = (list) => {
    const select = $("pnnl-select");
    select.innerHTML = "";
    for (const name of list.slice(0, 400)) {
      const option = document.createElement("option");
      option.value = option.textContent = name;
      select.append(option);
    }
  };
  fill(names);
  // Searching is a round trip now, so a fast typist can outrun the answers.
  // Only the newest is drawn, for the same reason the budget drops stale ones.
  let searchToken = 0;
  $("pnnl-search").addEventListener("input", async (e) => {
    const q = e.target.value.trim();
    const token = ++searchToken;
    const list = q ? await state.solver.pnnlSearch(q) : names;
    if (token === searchToken) fill(list);
  });
  $("pnnl-select").addEventListener("change", refreshBudget);
  $("volume").addEventListener("change", refreshBudget);
  // The library and the temperature decide what is fetched, so a change of
  // either turns "all held" back into a download.
  $("data-xs").addEventListener("change", refreshBudget);
  $("temperature").addEventListener("change", refreshBudget);

  // Every control that changes the spectrum redraws it. `input` rather than
  // `change` on the pasted vector so the plot follows the typing.
  $("spectrum-preset").addEventListener("change", refreshSpectrum);
  $("group-structure").addEventListener("change", refreshSpectrum);
  $("group-flux").addEventListener("input", refreshSpectrum);
  refreshSpectrum();

  $("composition").addEventListener("input", (e) => {
    const { i, k } = e.target.dataset;
    if (i === undefined) return;
    state.composition[i][k] = k === "fraction" ? Number(e.target.value) : e.target.value;
    refreshBudget();
  });
  $("composition").addEventListener("click", (e) => {
    const i = e.target.dataset.remove;
    if (i === undefined) return;
    state.composition.splice(Number(i), 1);
    renderComposition();
  });
  $("add-component").addEventListener("click", () => {
    state.composition.push({ name: "", fraction: 1.0 });
    renderComposition();
  });

  $("schedule").addEventListener("input", (e) => {
    const { s, k } = e.target.dataset;
    if (s === undefined) return;
    state.schedule[s][k] = k === "unit" ? e.target.value : Number(e.target.value);
  });
  $("schedule").addEventListener("click", (e) => {
    const i = e.target.dataset.removeStep;
    if (i === undefined) return;
    state.schedule.splice(Number(i), 1);
    renderSchedule();
  });
  $("add-pulse").addEventListener("click", () => {
    state.schedule.push({ kind: "pulse", rate: 1e14, value: 1, unit: "h" });
    renderSchedule();
  });
  $("add-cooldown").addEventListener("click", () => {
    state.schedule.push({ kind: "cooldown", value: 1, unit: "d" });
    renderSchedule();
  });

  $("run").addEventListener("click", run);
  $("download-python").addEventListener("click", async () => {
    try {
      warn("");
      downloadFile("yani_run.py", pythonScript(await currentSetup()), "text/x-python");
    } catch (e) {
      warn(`Cannot write the script: ${e.message || e}`);
    }
  });
  // A scale toggle redraws only the chart it belongs to. The spectrum is drawn
  // from the form, the rest from the last results, so there is nothing to
  // redraw for those until a run has happened.
  wireAxisScales((id) => {
    if (id === "plot-spectrum") {
      refreshSpectrum();
    } else if (state.results) {
      if (id === "plot-photons") drawPhotons(state.results, Number($("photon-step").value));
      else drawAll(state.results);
    }
  });

  // The palettes are separately validated per theme rather than flipped, so a
  // theme change rebuilds the charts. The spectrum is up before any run, which
  // is exactly when someone is most likely to switch.
  window.addEventListener("yani:redraw", () => {
    refreshSpectrum();
    if (state.results) {
      drawAll(state.results);
      drawPhotons(state.results, Number($("photon-step").value));
    }
  });

  $("photon-step").addEventListener("input", (e) => {
    const i = Number(e.target.value);
    $("photon-step-label").value = i + 1;
    if (state.results) drawPhotons(state.results, i);
  });
}

main().catch((e) => {
  warn(`Failed to start: ${e.message || e}`);
});
