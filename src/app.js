// Application logic: set up a calculation, fetch exactly the data it needs,
// run it off the main thread, hand the results to the plots.
//
// Loaded as a module from index.html, which supplies WASM_B64, WASM_JS and
// PLOTLY_GZ_B64 as base64 payloads.

import { drawAll, drawPhotons } from "./plots.js";

// --- nuclear data ---------------------------------------------------------

const ORIGIN = "https://yamc-data.xsplot.com";

// Which library publishes which chain subsection. Mirrors
// `keyword_transmutation_subsections` in yamc-nuclide/src/storage/url_cache.rs.
// Offering a library a subsection it does not publish fails at fetch time with
// a 404, so the dropdowns are built from this rather than from a flat list.
const LIBRARIES = {
  "endf-b8.1": { xs: true, decay: true, reactions: true, fission_yields: true, branching: true },
  "jeff-4.0": { xs: true, decay: true, reactions: true, fission_yields: true, branching: true },
  "tendl-2025": { xs: true, decay: false, reactions: true, fission_yields: false, branching: true },
  "tendl-2017": { xs: true, decay: false, reactions: true, fission_yields: false, branching: true },
  "fendl-3.2d": { xs: true, decay: false, reactions: false, fission_yields: false, branching: false },
};

// ENDF/B-8.1 by default for every subsection: it is the one library that
// publishes a complete, self-consistent network. TENDL covers far more parent
// nuclides for `reactions` and is the better choice when it is available, but
// making it the default would silently require a second library for decay.
const DEFAULTS = {
  xs: "endf-b8.1",
  reactions: "endf-b8.1",
  decay: "endf-b8.1",
  fission_yields: "endf-b8.1",
  branching: "endf-b8.1",
};

// The section files each chain subsection publishes, and whether a 404 is
// fatal. Mirrors `transmutation_sections` in url_cache.rs.
const CHAIN_SECTIONS = {
  decay: [["nuclides.arrow", true], ["decay_modes.arrow", false], ["sources.arrow", false]],
  reactions: [["reactions.arrow", true]],
  fission_yields: [["fission_yields.arrow", true], ["aliases.arrow", false]],
  branching: [["branching.arrow", true]],
};

// What an activation run reads from a nuclide: the union energy grid and the
// cross sections, and nothing else. The transport sections are 4/5 of the data
// and are never touched here.
const NUCLIDE_SECTIONS = [["version.json", true], ["nuclide.arrow", true], ["reactions.arrow", true]];

// --- spectra --------------------------------------------------------------

// Coarse shapes, deliberately. These are starting points for someone without a
// tallied spectrum; anyone with one should paste it against a named group
// structure instead, where the boundaries are exact.
const PRESETS = {
  "fusion-fw": {
    label: "Fusion first wall",
    boundaries: [1e-5, 1e2, 1e4, 1e5, 1e6, 5e6, 1.2e7, 1.5e7],
    values: [0.06, 0.05, 0.06, 0.10, 0.18, 0.15, 0.35, 0.05],
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

// --- state ----------------------------------------------------------------

const state = {
  session: null,
  required: [],       // nuclides needing cross sections
  loadedData: false,
  results: null,
  schedule: [
    { kind: "pulse", rate: 1e14, value: 1, unit: "a" },
    { kind: "cooldown", value: 1, unit: "d" },
  ],
  composition: [{ name: "Fe", fraction: 1.0 }],
};

const $ = (id) => document.getElementById(id);
const setStatus = (text) => { $("status").textContent = text; };
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

async function bootWasm() {
  // The glue is a module, so it is imported from a blob URL rather than
  // written to disk. `init` takes a synthetic Response so instantiateStreaming
  // works without a network round-trip for a payload we already hold.
  const glue = WASM_JS.startsWith("__") ? await (await fetch("./yani_wasm.js")).text() : WASM_JS;
  const mod = await import(URL.createObjectURL(new Blob([glue], { type: "application/javascript" })));
  const bytes = WASM_B64.startsWith("__")
    ? new Uint8Array(await (await fetch("./yani_wasm_bg.wasm")).arrayBuffer())
    : b64ToBytes(WASM_B64);
  await mod.default(new Response(bytes, { headers: { "Content-Type": "application/wasm" } }));
  return new mod.YaniSession();
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
async function fetchAll(jobs, onProgress, limit = 12) {
  let done = 0;
  let next = 0;
  const results = new Array(jobs.length);
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      const { url, optional } = jobs[i];
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          results[i] = new Uint8Array(await resp.arrayBuffer());
        } else if (!optional) {
          throw new Error(`${resp.status} ${url}`);
        }
      } catch (e) {
        if (!optional) throw e;
      }
      onProgress(++done / jobs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

async function loadChain(session) {
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
  jobs.forEach((job, i) => {
    if (bytes[i]) session.addChainSection(job.subsection, job.file, bytes[i]);
  });
  const n = session.loadChain();
  setStatus(`Chain loaded: ${n.toLocaleString()} nuclides.`);
  return n;
}

const shortKey = (subsection) =>
  ({ decay: "decay", reactions: "reactions", fission_yields: "fpy", branching: "branching" }[subsection]);

async function loadCrossSections(session, nuclides) {
  const library = $("data-xs").value;
  const jobs = [];
  for (const nuclide of nuclides) {
    for (const [file, required] of NUCLIDE_SECTIONS) {
      jobs.push({
        url: `${ORIGIN}/${library}/neutron/${nuclide}.arrow/${file}`,
        optional: !required,
        nuclide,
        file,
      });
    }
  }
  setStatus(`Fetching cross sections for ${nuclides.length} nuclides…`);
  const bytes = await fetchAll(jobs, (f) => { $("progress").value = f; });
  let held = 0;
  jobs.forEach((job, i) => {
    if (bytes[i]) {
      session.addNuclideData(job.nuclide, job.file, bytes[i]);
      held += bytes[i].length;
    }
  });
  return held;
}

// --- building the calculation --------------------------------------------

function activeTab(panel) {
  return panel.querySelector('[role="tab"][aria-selected="true"]').dataset.tab;
}

function applyMaterial(session) {
  const volume = Number($("volume").value);
  const materialPanel = document.querySelector(".panel");
  if (activeTab(materialPanel) === "pnnl") {
    const name = $("pnnl-select").value;
    if (!name) throw new Error("choose a material");
    session.pnnlMaterial(name, volume);
  } else {
    const composition = {};
    for (const { name, fraction } of state.composition) {
      if (name.trim()) composition[name.trim()] = fraction;
    }
    if (!Object.keys(composition).length) throw new Error("the composition is empty");
    session.buildMaterial(
      JSON.stringify(composition),
      Number($("density").value),
      $("density-units").value,
      $("fraction-type").value,
      volume,
    );
  }
}

function currentSpectrum() {
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
  const boundaries = JSON.parse(state.session.groupStructure($("group-structure").value));
  if (values.length !== boundaries.length - 1) {
    throw new Error(
      `${$("group-structure").value} has ${boundaries.length - 1} groups, ` +
      `but ${values.length} values were given`);
  }
  return { boundaries, values };
}

function currentSchedule(session) {
  return state.schedule.map((step) => {
    const dt = session.constructor.durationToSeconds
      ? session.constructor.durationToSeconds(step.value, step.unit)
      : durationToSeconds(step.value, step.unit);
    return step.kind === "pulse"
      ? { dt, rate: step.rate, spectrum: 0 }
      : { dt };
  });
}

// Mirror of yani_transmute::duration_to_seconds, used only if the wasm export
// is unavailable. Kept in sync by the unit table in the docs.
function durationToSeconds(value, unit) {
  const table = { s: 1, min: 60, h: 3600, d: 86400, a: 365.25 * 86400 };
  if (!(unit in table)) throw new Error(`unknown duration unit '${unit}'`);
  return value * table[unit];
}

// --- run ------------------------------------------------------------------

async function refreshBudget() {
  if (!state.session) return;
  try {
    applyMaterial(state.session);
  } catch {
    $("budget").textContent = "Choose a material to see what needs downloading.";
    return;
  }
  if (!state.chainLoaded) {
    $("budget").textContent = "Download the data to see the nuclide count.";
    return;
  }
  state.required = JSON.parse(state.session.requiredNuclides());
  $("budget").textContent =
    `${state.required.length} nuclides need cross sections. ` +
    `Fetched once, then cached by the browser.`;
}

async function run() {
  const btn = $("run");
  btn.disabled = true;
  warn("");
  setStatus("Solving…");
  // Yield so the status paints before the solve blocks this thread. The solve
  // is synchronous inside wasm; moving it to a Worker is the next step, and is
  // what will keep the UI alive on a full closure.
  await new Promise((r) => setTimeout(r, 0));
  try {
    applyMaterial(state.session);
    const spectrum = currentSpectrum();
    const schedule = currentSchedule(state.session);
    const out = state.session.run(
      JSON.stringify([{ boundaries: spectrum.boundaries, values: spectrum.values }]),
      JSON.stringify(schedule),
    );
    state.results = JSON.parse(out);
    $("results-empty").hidden = true;
    $("results").hidden = false;
    const slider = $("photon-step");
    slider.max = String(state.results.length - 1);
    slider.value = String(state.results.length - 1);
    $("photon-step-label").value = state.results.length;
    drawAll(state.results);
    drawPhotons(state.results, state.results.length - 1);
    setStatus(`Done. ${state.results.length} steps.`);
  } catch (e) {
    warn(String(e.message || e));
    setStatus("");
  } finally {
    btn.disabled = false;
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
          : "&mdash;"
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
  state.session = await bootWasm();
  setStatus("Ready. Choose a material, then download the data it needs.");

  // The compendium is compiled into the wasm, so the picker works before a
  // single byte is fetched.
  const names = JSON.parse(state.session.constructor.pnnlNames());
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
  $("pnnl-search").addEventListener("input", (e) => {
    const q = e.target.value.trim();
    fill(q ? JSON.parse(state.session.constructor.pnnlSearch(q)) : names);
  });
  $("pnnl-select").addEventListener("change", refreshBudget);
  $("volume").addEventListener("change", refreshBudget);

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

  $("load-data").addEventListener("click", async () => {
    const btn = $("load-data");
    btn.disabled = true;
    warn("");
    $("progress").hidden = false;
    try {
      applyMaterial(state.session);
      await loadChain(state.session);
      state.chainLoaded = true;
      state.required = JSON.parse(state.session.requiredNuclides());
      $("budget").textContent = `${state.required.length} nuclides need cross sections.`;
      const held = await loadCrossSections(state.session, state.required);
      state.loadedData = true;
      setStatus(`Loaded ${(held / 1048576).toFixed(0)} MB across ` +
                `${state.session.fileCount()} files.`);
      $("run").disabled = false;
    } catch (e) {
      warn(String(e.message || e));
      setStatus("");
    } finally {
      btn.disabled = false;
      $("progress").hidden = true;
    }
  });

  $("run").addEventListener("click", run);
  $("photon-step").addEventListener("input", (e) => {
    const i = Number(e.target.value);
    $("photon-step-label").value = i + 1;
    if (state.results) drawPhotons(state.results, i);
  });
}

main().catch((e) => {
  warn(`Failed to start: ${e.message || e}`);
});
