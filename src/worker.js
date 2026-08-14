// The solver, off the main thread.
//
// This file is never loaded by a <script> tag. The page carries its source as
// text and mints a blob URL for it, because a Worker needs a URL and the built
// page is one file with nothing beside it to point at.
//
// It is a classic script rather than a module for the same reason: on a
// `file://` origin a blob URL is opaque, and a module Worker refuses to load
// one ("cannot be accessed from origin 'null'") while a classic Worker from the
// same blob starts fine. The wasm-bindgen glue is still an ES module -- a
// classic worker reaches it through dynamic `import()` of a second blob URL,
// which is the same instantiation the main thread used before this moved.
//
// Every reference to the worker scope is written `self.`, never bare, so the
// same source can be evaluated on this thread behind a shim when a Worker
// cannot be created at all (see `inPageHost` in app.js).
//
// Protocol: `{ id, method, args }` in, `{ id, value }` or `{ id, error }` out.
// One call at a time is all the page ever issues, and messages are handled in
// order, so a solve blocks everything behind it -- here, where blocking is the
// point, rather than in front of the UI.

"use strict";

// The wasm-bindgen module namespace, and the session it exports. The session
// owns the chain, the cross sections and the material for the page's lifetime,
// which is why the whole of it lives on this side: handing data across per
// call would mean re-parsing gigabytes per run.
let glue = null;
let session = null;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const api = {
  /// Instantiate the solver from bytes the page already holds.
  ///
  /// `wasmB64` is the built page's inlined payload, decoded here so the main
  /// thread never walks 3.4 MB of base64; `wasmBytes` is the dev tree's, which
  /// the page fetches from vendor/ because this scope's base URL is a blob and
  /// resolves nothing.
  async init({ glueSource, wasmB64, wasmBytes }) {
    const url = URL.createObjectURL(new Blob([glueSource], { type: "application/javascript" }));
    try {
      glue = await import(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    // The async init rather than `initSync`: passed raw bytes it lands on
    // `WebAssembly.instantiate`, which has no size ceiling on any thread, so
    // the one code path works here and in the main-thread fallback.
    await glue.default({ module_or_path: wasmB64 ? b64ToBytes(wasmB64) : new Uint8Array(wasmBytes) });
    session = new glue.YaniSession();
  },

  // Everything the wasm answers in JSON is parsed here rather than on the main
  // thread: the result of a run is the largest thing that crosses, and parsing
  // it is the one part of it that need not be paid for in dropped frames.
  pnnlNames: () => JSON.parse(glue.YaniSession.pnnlNames()),
  pnnlSearch: (query) => JSON.parse(glue.YaniSession.pnnlSearch(query)),
  groupStructure: (name) => JSON.parse(session.groupStructure(name)),
  requiredNuclides: () => JSON.parse(session.requiredNuclides()),

  /// Seconds for each `{ value, unit }` step, from the solver's own table.
  ///
  /// One call for the whole schedule rather than one per step: it is a dozen
  /// round trips saved, and it keeps the browser and the wheel agreeing on
  /// what "a" means without this file carrying a second copy of the table.
  durationsToSeconds: (steps) => steps.map((s) => glue.durationToSeconds(s.value, s.unit)),

  pnnlMaterial: (name, volume) => session.pnnlMaterial(name, volume),
  buildMaterial: (composition, density, densityUnits, fractionType, volume) =>
    session.buildMaterial(composition, density, densityUnits, fractionType, volume),

  addChainSections(sections) {
    for (const s of sections) session.addChainSection(s.subsection, s.file, s.bytes);
  },
  loadChain: () => session.loadChain(),

  /// Register fetched cross sections, answering with the bytes taken on.
  ///
  /// The page cannot measure that itself: the buffers are transferred here, so
  /// its own views are detached by the time this returns.
  addNuclideData(items) {
    let held = 0;
    for (const item of items) {
      session.addNuclideData(item.nuclide, item.file, item.bytes);
      held += item.bytes.length;
    }
    return held;
  },

  run: (spectraJson, scheduleJson) => JSON.parse(session.run(spectraJson, scheduleJson)),
};

self.onmessage = async (event) => {
  const { id, method, args } = event.data;
  try {
    if (!Object.hasOwn(api, method)) throw new Error(`unknown solver method '${method}'`);
    if (method !== "init" && !session) throw new Error("the solver has not started");
    self.postMessage({ id, value: await api[method](...args) });
  } catch (e) {
    // The message, not the Error: an Error crosses a structured clone with its
    // stack rewritten to this scope, which points at a blob URL and tells the
    // reader nothing. The page re-throws it as its own.
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
