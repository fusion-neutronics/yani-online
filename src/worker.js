// The solver, off the main thread.
//
// This file is never loaded by a <script> tag. The page carries its source as
// text, appends it to the wasm-bindgen glue, and mints one blob URL for the
// pair, because a Worker needs a URL and the built page is one file with
// nothing beside it to point at. So `YaniSession` and `initSync` below are not
// imported from anywhere: they are declared immediately above this, in the same
// script. See `glueToClassic` and `bootSolver` in app.js for why it is one
// script and not two.
//
// Protocol: `{ id, method, args }` in, `{ id, value }` or `{ id, error }` out.
// One call at a time is all the page ever issues, and messages are handled in
// order, so a solve blocks everything behind it -- here, where blocking is the
// point, rather than in front of the UI.

// The session owns the chain, the cross sections and the material for the
// page's lifetime, which is why the whole of it lives on this side: handing the
// data across per call would mean re-parsing gigabytes per run.
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
  /// thread never walks 5.7 MB of base64; `wasmBytes` is the dev tree's, which
  /// the page fetches from vendor/ because this scope's base URL is a blob and
  /// resolves nothing.
  ///
  /// `initSync` compiles 4.3 MB of wasm synchronously, which is refused on the
  /// main thread and allowed here. Blocking this thread at boot costs nothing:
  /// there is nothing else on it, and the page is waiting on the reply anyway.
  init({ wasmB64, wasmBytes }) {
    initSync({ module: wasmB64 ? b64ToBytes(wasmB64) : new Uint8Array(wasmBytes) });
    session = new YaniSession();
  },

  // Everything the wasm answers in JSON is parsed here rather than on the main
  // thread: the result of a run is the largest thing that crosses, and parsing
  // it is the one part of it that need not be paid for in dropped frames.
  pnnlNames: () => JSON.parse(YaniSession.pnnlNames()),
  pnnlSearch: (query) => JSON.parse(YaniSession.pnnlSearch(query)),
  groupStructure: (name) => JSON.parse(session.groupStructure(name)),
  requiredNuclides: () => JSON.parse(session.requiredNuclides()),

  /// Which of the optional session methods this vendored solver carries.
  ///
  /// Feature-detected on the session rather than inferred from
  /// vendor/CORE_COMMIT: a commit says which build this is, not what it can do,
  /// and the page has to choose how to fetch before it has fetched anything.
  ///
  /// `requiredMts` is the probe the byte-range fetch needs. A solver that
  /// answers it also reads a spliced Arrow stream, because neither of those is
  /// any use without the other and they land together (core#527).
  capabilities: () => ({
    requiredMts: typeof session.requiredMts === "function",
  }),

  /// The MT numbers the loaded chain names, which is every reaction a run will
  /// ask a cross section for. Comes from the solver so the page needs no second
  /// copy of the chain-kind-to-MT table: an MT a copy of it missed would not
  /// 404, it would be a reaction rate quietly collapsing to zero.
  requiredMts: () => JSON.parse(session.requiredMts()),

  /// Seconds for each `{ value, unit }` step, from the solver's own table.
  ///
  /// One call for the whole schedule rather than one per step: it is a dozen
  /// round trips saved, and it keeps the browser and the wheel agreeing on
  /// what "a" means without this file carrying a second copy of the table.
  durationsToSeconds: (steps) => steps.map((s) => durationToSeconds(s.value, s.unit)),

  pnnlMaterial: (name, volume) => session.pnnlMaterial(name, volume),
  /// The material as the solver built it: every nuclide the composition
  /// expanded to, with its atom density, and the density and volume it was
  /// given. What the page draws as the material's make-up.
  materialJson: () => JSON.parse(session.materialJson()),
  buildMaterial: (composition, density, densityUnits, fractionType, volume) =>
    session.buildMaterial(composition, density, densityUnits, fractionType, volume),

  addChainSections(sections) {
    for (const s of sections) session.addChainSection(s.subsection, s.file, s.bytes);
  },
  loadChain: () => session.loadChain(),

  /// Start the session over: no chain, no cross sections, no material.
  ///
  /// The page needs this when a chain library changes after a run. A chain
  /// section can be added again, but not taken away, and a library that does
  /// not publish one of the optional files would leave the previous library's
  /// copy in place under the new one's name. A fresh session is the only clean
  /// slate the wasm offers, and it is cheap: the data is refetched anyway,
  /// since which reactions the chain names decides which byte ranges were
  /// worth having. The old session is freed rather than left for the garbage
  /// collector, which does not see wasm memory.
  reset() {
    session.free();
    session = new YaniSession();
  },

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
