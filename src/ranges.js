// Fetching only the bytes a run reads out of a nuclide's published objects.
//
// Two files carry almost all of a nuclide's activation data, and both are
// written one Arrow record batch per unit a reader might want on its own:
//
//   reactions.arrow   one batch per (MT, temperature)
//   energy.arrow      one batch per temperature, holding the union energy grid
//                     every cross section at that temperature is tabulated on
//
// Each nuclide's `version.json` names where every batch sits (`reaction_ranges`
// keyed by MT and then by temperature, `energy_ranges` keyed by temperature;
// both written by core's converter since fusion-neutronics/core#100 and #109).
// An activation run reads the handful of channels its chain names, at the one
// temperature the material is at, and none of the full-grid transport MTs or
// the other five or six temperatures, which together are nearly all of every
// file. Measured over the 462-nuclide closure of an Fe56 material on
// ENDF/B-8.1, the whole objects are 3.9 GB, every temperature of the wanted
// MTs is 640 MB, and one temperature of them is 133 MB.
//
// The index rides in a file the page already fetches, so reading it costs no
// extra request. What it buys is spent as HTTP range requests, which the origin
// answers 206 from the same edge cache as the whole file.
//
// Nothing here touches the DOM or the network. That is deliberate: it is the
// part with arithmetic in it, so it is the part worth testing outside a
// browser, and `verify.mjs` imports it directly.

/// The 8-byte end-of-stream marker: a continuation marker followed by a zero
/// metadata length. Without it a decoder treats the stream as truncated rather
/// than merely finished.
const EOS = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);

/// Merge two wanted ranges into one request when the gap between them is under
/// this.
///
/// The writer lays one MT's temperatures back to back and the MTs in ENDF
/// order, so at every temperature the wanted batches of one MT sit together and
/// the next wanted MT's follow a few batches later. At 16 kB the merge takes
/// touching batches and nothing else: on ENDF/B-8.1 it swallows no unwanted
/// batch on any nuclide checked, so every byte fetched is a byte the run reads,
/// and the drop-the-swallowed-batch path in `spliceStream` exists for a layout
/// that does not hold. Fetching one temperature costs more requests than
/// fetching them all, since the other temperatures of an MT now separate the
/// wanted batches: seven per nuclide rather than three, against six times
/// fewer bytes.
export const COALESCE_GAP = 16 * 1024;

/// `[off, len]` or `[off, len, sha256]` as `version.json` spells a range, or
/// `null` for anything else.
///
/// The third element is the hex sha256 of exactly those bytes, which core's
/// converter writes per batch (fusion-neutronics/core#323) so that a reader
/// fetching a batch by range can check it, since the release manifest's hash
/// covers only the whole object. An index without it is read as before and its
/// ranges go unchecked; one with a third element that is not a sha256 is
/// malformed, and is refused like any other malformed entry.
function range(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return null;
  const [off, len, sha256] = value;
  if (!Number.isInteger(off) || !Number.isInteger(len) || off < 0 || len < 0) return null;
  if (value.length === 2) return { off, len };
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)) return null;
  return { off, len, sha256: sha256.toLowerCase() };
}

/// Read the reaction byte-range index out of a nuclide's parsed `version.json`.
///
/// `mts` maps each MT to a map of temperature label (`"294K"`, as the file
/// spells it) to the range of the record batch carrying that cross section
/// (fusion-neutronics/core#100). A file written one batch per MT lists the same
/// range under each temperature the batch carries.
///
/// `null` when there is no index, which is what a library converted before core
/// grew one looks like, and also what an index in the shape from before the
/// temperature split looks like (`mt -> [off, len]`): core's reader treats that
/// the same way, and the published `version.json` is reindexed rather than read
/// two ways. Callers fall back to fetching the whole file, so this is a normal
/// answer rather than an error.
export function reactionRanges(version) {
  const index = version && version.reaction_ranges;
  if (!index || !index.mts) return null;
  const schema = range(index.schema);
  if (!schema) return null;
  const mts = new Map();
  for (const [mt, byTemperature] of Object.entries(index.mts)) {
    // One entry in the shape from before the split makes the whole index
    // unusable rather than one MT unfetchable: reading it as a half-index would
    // leave that MT looking unpublished, and a stream missing a channel reacts
    // at zero without saying so. Core's `ReactionRanges::from_json` refuses the
    // same input, and both fall back to fetching the whole file.
    if (!byTemperature || typeof byTemperature !== "object" || Array.isArray(byTemperature)) return null;
    const temperatures = new Map();
    for (const [temperature, value] of Object.entries(byTemperature)) {
      const r = range(value);
      if (!r) return null;
      temperatures.set(temperature, r);
    }
    if (temperatures.size) mts.set(Number(mt), temperatures);
  }
  if (!mts.size) return null;
  return { schema, mts };
}

/// Read the energy-grid byte-range index out of a nuclide's parsed
/// `version.json`.
///
/// `temperatures` maps each label the section holds to the range of the batch
/// carrying that temperature's union grid (fusion-neutronics/core#109). It can
/// name a grid no reaction is tabulated at: the NJOY route publishes a 0 K grid
/// that way, and core's `EnergyRanges` keeps it for the same reason this does,
/// so that an index describes the whole object.
///
/// `null` when there is no index, which is what data published between the
/// grids moving into their own object and that object being indexed looks
/// like. Callers fetch the whole file then, which carries every grid.
export function energyRanges(version) {
  const index = version && version.energy_ranges;
  if (!index || !index.temperatures || typeof index.temperatures !== "object") return null;
  const schema = range(index.schema);
  if (!schema) return null;
  const temperatures = new Map();
  for (const [temperature, value] of Object.entries(index.temperatures)) {
    const r = range(value);
    if (!r) return null;
    temperatures.set(temperature, r);
  }
  if (!temperatures.size) return null;
  return { schema, temperatures };
}

/// Kelvin from a label as the files spell one, `"294K"` or `"293.6K"`. `NaN`
/// for anything that is not a number with an optional trailing K.
export function kelvin(label) {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*K?\s*$/i.exec(label);
  return m ? Number(m[1]) : NaN;
}

/// The temperature labels at which this nuclide publishes a batch of at least
/// one of `wantedMts`.
///
/// Drawn from the wanted MTs rather than from every MT in the index, because
/// the index lists labels no activation channel is tabulated at: ENDF/B-8.1
/// carries elastic scattering at 0 K and nothing else there. A run fetched at
/// that label would splice a stream with the wanted channels absent, which the
/// solver reads as a nuclide that reacts at zero, without saying so.
export function publishedTemperatures(ranges, wantedMts) {
  const labels = new Set();
  for (const [mt, byTemperature] of ranges.mts) {
    if (!wantedMts.has(mt)) continue;
    for (const temperature of byTemperature.keys()) labels.add(temperature);
  }
  return labels;
}

/// The label among `labels` nearest to `wantedKelvin`, or `null` for none.
///
/// Nearest in Kelvin, with a tie going to the lower temperature: less Doppler
/// broadening is the smaller departure from an unbroadened evaluation. A label
/// that does not read as a temperature is never chosen.
export function nearestTemperature(labels, wantedKelvin) {
  let best = null;
  let bestKelvin = NaN;
  for (const label of labels) {
    const k = kelvin(label);
    if (Number.isNaN(k)) continue;
    const closer = best === null
      || Math.abs(k - wantedKelvin) < Math.abs(bestKelvin - wantedKelvin)
      || (Math.abs(k - wantedKelvin) === Math.abs(bestKelvin - wantedKelvin) && k < bestKelvin);
    if (closer) {
      best = label;
      bestKelvin = k;
    }
  }
  return best;
}

/// The messages a run needs: the schema, then the record batch of every wanted
/// MT this nuclide actually publishes, at every temperature, or at the
/// temperatures `wantedTemperatures` names when it is given.
///
/// In file order rather than MT order, and MT order is not file order. A
/// decoder does not care -- record batch messages are self-contained -- but the
/// loader fuses the batches it reads with `concat_batches`, so the order they
/// arrive in is the row order of the fused batch. Keeping file order keeps that
/// identical to what reading the whole file produces, which is one fewer way
/// for the two paths to disagree.
///
/// A batch listed under several temperatures is wanted once however many of
/// them are asked for. An MT the chain names that this nuclide does not publish
/// is simply absent: the nuclide does not have that channel, which is not the
/// same as a fetch having failed.
export function wantedParts(ranges, wantedMts, wantedTemperatures = null) {
  const batches = [];
  const seen = new Set();
  for (const [mt, byTemperature] of ranges.mts) {
    if (!wantedMts.has(mt)) continue;
    for (const [temperature, range] of byTemperature) {
      if (wantedTemperatures && !wantedTemperatures.has(temperature)) continue;
      const key = `${range.off}+${range.len}`;
      if (seen.has(key)) continue;
      seen.add(key);
      batches.push(range);
    }
  }
  batches.sort((a, b) => a.off - b.off);
  // The schema is the first message in the file, before every batch, so it
  // leads on offset alone. Put it there explicitly anyway: a stream whose
  // schema is not first does not decode, and that is too quiet a way to fail
  // to leave to a sort.
  return [ranges.schema, ...batches];
}

/// Merge parts into the spans to actually request.
///
/// Sorted by offset, so a span is always a forward read. Overlapping parts
/// would merge correctly too, though the index does not produce any.
export function coalesce(parts, gap = COALESCE_GAP) {
  const spans = [];
  for (const { off, len } of [...parts].sort((a, b) => a.off - b.off)) {
    const last = spans[spans.length - 1];
    if (last && off - (last.off + last.len) <= gap) {
      last.len = Math.max(last.off + last.len, off + len) - last.off;
    } else {
      spans.push({ off, len });
    }
  }
  return spans;
}

/// A plan out of its parts: what to request, and what it costs against the
/// whole object.
///
/// `bytes` is the transfer, which is the coalesced total and so is at or above
/// the sum of the parts. `full` is the whole file for comparison, taken as the
/// end of the last batch the index describes: the index covers every message in
/// the object, so the only thing past its end is the Arrow footer.
function plan(parts, spans, full) {
  return { parts, spans, bytes: spans.reduce((n, s) => n + s.len, 0), full };
}

/// What to request from `reactions.arrow` for one nuclide, and what it will
/// cost.
export function planFetch(ranges, wantedMts, gap = COALESCE_GAP, wantedTemperatures = null) {
  const parts = wantedParts(ranges, wantedMts, wantedTemperatures);
  let full = 0;
  for (const byTemperature of ranges.mts.values()) {
    for (const { off, len } of byTemperature.values()) full = Math.max(full, off + len);
  }
  return plan(parts, coalesce(parts, gap), full);
}

/// What to request from `energy.arrow` for one nuclide: the schema and the
/// grid of every label in `wantedTemperatures` this nuclide publishes.
///
/// A label the nuclide has no grid for is simply absent, as with an MT. Two
/// requests is the usual answer: the schema is a few hundred bytes at the front
/// of the file, and the one grid wanted is generally not the first one behind
/// it.
export function planEnergyFetch(ranges, wantedTemperatures, gap = COALESCE_GAP) {
  const batches = [];
  let full = 0;
  for (const [temperature, range] of ranges.temperatures) {
    full = Math.max(full, range.off + range.len);
    if (wantedTemperatures.has(temperature)) batches.push(range);
  }
  batches.sort((a, b) => a.off - b.off);
  const parts = [ranges.schema, ...batches];
  return plan(parts, coalesce(parts, gap), full);
}

/// Everything the fetch of one nuclide is decided by, from its `version.json`.
///
/// Returns the temperature label chosen and a plan per ranged file, or `null`
/// in place of a plan for a file to fetch whole:
///
///   - No reaction index: both files whole. The energy index alone is not
///     enough to narrow on, because the solver then reads every temperature's
///     reactions and settles on the lowest of them, and a grid fetched for a
///     different label would leave that temperature interpolating against
///     nothing. Whole files carry every grid and every temperature, and the
///     solver's own default applies, as it did before the index existed.
///   - A reaction index: the wanted MTs at the one published temperature
///     nearest `wantedKelvin`, chosen among the labels that carry a wanted MT
///     and, when there is an energy index, a grid. The grid at that label is
///     fetched from `energy.arrow`, or the whole file when it has no index.
///   - A nuclide publishing none of the wanted MTs (He4 is the real case,
///     carrying elastic and the transport lookups and no activation channel)
///     plans the reaction schema and nothing after it, which the solver reads
///     as the empty subset it is, and one grid, nearest `wantedKelvin` among
///     those published, because the loader requires the section to be there
///     for a nuclide whose `nuclide.arrow` lists temperatures.
///
/// A plan that would fetch no less than the whole file is returned as `null`:
/// the whole file asked for plainly is one request rather than one plus a
/// splice.
export function planNuclide(version, wantedMts, wantedKelvin, gap = COALESCE_GAP) {
  const reactions = reactionRanges(version);
  const energy = energyRanges(version);
  if (!reactions) return { temperature: null, reactions: null, energy: null };

  let labels = publishedTemperatures(reactions, wantedMts);
  if (energy) {
    if (labels.size) {
      labels = new Set([...labels].filter((label) => energy.temperatures.has(label)));
    } else {
      labels = new Set(energy.temperatures.keys());
    }
  }
  const temperature = nearestTemperature(labels, wantedKelvin);
  const wanted = new Set(temperature === null ? [] : [temperature]);

  const narrow = (p) => (p.bytes < p.full ? p : null);
  return {
    temperature,
    reactions: narrow(planFetch(reactions, wantedMts, gap, wanted)),
    energy: energy ? narrow(planEnergyFetch(energy, wanted, gap)) : null,
  };
}

/// Splice fetched spans into a readable Arrow IPC stream.
///
/// `bodies[i]` is the bytes of `spans[i]`. Each part is cut back out of
/// whichever span covers it -- coalescing means a span can carry parts the run
/// did not ask for, and those are dropped here rather than handed to the
/// decoder -- and the result is
///
///     schema ++ batches ++ EOS
///
/// which is the shape core's `splice_stream` produces and its round-trip test
/// asserts decodes to the same batches as the whole file.
///
/// Note this is a *stream*, not a file: no `ARROW1` magic, no footer. A reader
/// built on `FileReader` rejects it, which is why the caller only takes this
/// path against a solver that advertises it can read one.
export function spliceStream(parts, spans, bodies) {
  const total = parts.reduce((n, p) => n + p.len, 0) + EOS.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    // Both lists are offset-sorted and short (a handful of spans and a dozen
    // parts is typical), so a scan is cheaper than an index and there is
    // nothing to keep in step.
    const i = spans.findIndex((s) => part.off >= s.off && part.off + part.len <= s.off + s.len);
    if (i < 0) {
      throw new Error(`no fetched span covers ${part.off}+${part.len}`);
    }
    const body = bodies[i];
    if (!body) {
      throw new Error(`span ${spans[i].off}+${spans[i].len} was not fetched`);
    }
    if (body.length !== spans[i].len) {
      // A short span silently produces a stream that decodes into the wrong
      // numbers, because the framing still walks: the message header at the cut
      // is read as whatever the next bytes happen to be.
      throw new Error(
        `span ${spans[i].off}+${spans[i].len} came back ${body.length} bytes`);
    }
    const from = part.off - spans[i].off;
    out.set(body.subarray(from, from + part.len), at);
    at += part.len;
  }
  out.set(EOS, at);
  return out;
}

/// Hex sha256 of `bytes`, through WebCrypto, which browsers and Node both carry.
///
/// `crypto.subtle` exists only in a secure context. The page is one: GitHub
/// Pages serves it over https, and `file://` and `localhost` count as secure. A
/// page served over plain http from elsewhere has none, and is refused here
/// rather than reading data it cannot check.
export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    throw new Error("this page cannot check the nuclear data it downloads (no crypto.subtle): open it over https or from a file");
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/// Check every part of a plan that carries a sha256 against the bytes fetched
/// for it, and throw naming `what` and the part on the first that differs.
///
/// Per part rather than per span, because the hashes are per record batch: a
/// coalesced span can carry several batches, and a batch nobody asked for
/// that it swallowed is dropped by the splice unchecked. An index without
/// hashes checks nothing, and says so by returning 0, the parts checked.
export async function checkParts(plan, bodies, what) {
  let checked = 0;
  for (const part of plan.parts) {
    if (!part.sha256) continue;
    const i = plan.spans.findIndex((s) => part.off >= s.off && part.off + part.len <= s.off + s.len);
    const body = i >= 0 ? bodies[i] : null;
    if (!body) continue;
    const from = part.off - plan.spans[i].off;
    const got = await sha256Hex(body.subarray(from, from + part.len));
    if (got !== part.sha256) {
      throw new Error(`${what}: bytes ${part.off}+${part.len} do not match the sha256 its index gives`);
    }
    checked++;
  }
  return checked;
}

/// Assemble the files to hand the solver out of what came back.
///
/// Here rather than in the fetch loop because this is the step whose mistakes
/// are quiet ones: a span filed under the wrong index splices a stream from the
/// right bytes in the wrong order, and the loader reads it without complaint.
/// Nothing in it fetches or touches the page, so it can be checked directly.
///
/// `jobs` and `bytes` are positionally aligned, the way `fetchAll` returns them,
/// and `jobs[i].status` is what the origin answered. `plans` maps a nuclide to
/// a map of file name to the plan its ranged jobs were issued from, so one
/// nuclide can have both its grid and its reactions arriving in pieces. Arrival
/// order does not matter: spans are filed by the `spanIndex` their plan gave
/// them, not by when they landed.
///
/// Every batch whose index entry carries a sha256 is checked before it is
/// spliced (`checkParts`), and a mismatch throws: a release is immutable, so
/// bytes that differ from its index are damaged in transit or by something on
/// the way, and a run on them would be a wrong answer rather than a gap.
///
/// Returns the items to hand over, the nuclides something was missing for, the
/// bytes the indexes saved, the batches checked against their sha256, and
/// whether any ranged request came back as a whole object, which is the
/// caller's cue to stop asking for ranges.
export async function assembleNuclideData(jobs, bytes, plans) {
  const items = [];
  const missing = new Set();
  const bodies = new Map();
  const unranged = new Map();
  let stripped = false;
  const key = (nuclide, file) => `${nuclide}/${file}`;

  for (const [i, job] of jobs.entries()) {
    if (!bytes[i]) {
      missing.add(job.nuclide);
    } else if (!job.range) {
      items.push({ nuclide: job.nuclide, file: job.file, bytes: bytes[i] });
    } else if (job.status !== 206) {
      // Something between the page and the bucket dropped the Range header and
      // answered with the whole object, so what is in hand *is* the file. Take
      // it as such: more bytes than were wanted, and still the right answer.
      unranged.set(key(job.nuclide, job.file), bytes[i]);
      stripped = true;
    } else {
      const k = key(job.nuclide, job.file);
      if (!bodies.has(k)) {
        // Filled, not just sized. A bare `new Array(n)` is sparse, and `every`
        // skips holes rather than reporting them, so a span that never arrived
        // read as a complete set and reached the splice, which threw and took
        // the whole run with it instead of reporting one nuclide.
        const n = plans.get(job.nuclide).get(job.file).spans.length;
        bodies.set(k, new Array(n).fill(null));
      }
      bodies.get(k)[job.spanIndex] = bytes[i];
    }
  }

  let saved = 0;
  let checked = 0;
  for (const [nuclide, byFile] of plans) {
    for (const [file, plan] of byFile) {
      const k = key(nuclide, file);
      const got = bodies.get(k);
      if (unranged.has(k)) {
        items.push({ nuclide, file, bytes: unranged.get(k) });
      } else if (got && got.every(Boolean)) {
        checked += await checkParts(plan, got, `${nuclide} ${file}`);
        items.push({ nuclide, file, bytes: spliceStream(plan.parts, plan.spans, got) });
        saved += plan.full - plan.bytes;
      } else {
        // A stream short a batch is a nuclide short a reaction channel, or
        // short the grid its channels are tabulated on, and either reacts at
        // zero without saying so.
        missing.add(nuclide);
      }
    }
  }

  return { items, missing, saved, checked, stripped };
}

/// The `Range` header for a span.
export const rangeHeader = ({ off, len }) => `bytes=${off}-${off + len - 1}`;

// --- the release layout -----------------------------------------------------
//
// Every library on the origin is published as immutable release folders and
// one mutable pointer (core's yamc-nuclide/src/storage/release.rs):
//
//   <origin>/<keyword>/latest.json                 which release is current
//   <origin>/<keyword>/<release>/manifest.json     every file, bytes and sha256
//   <origin>/<keyword>/<release>/neutron/<Name>.arrow/...
//   <origin>/<keyword>/<release>/transmutation/<subsection>.arrow/...
//
// What follows reads the two index objects and checks a file against them. The
// fetching is app.js's.

/// The `format_version`s of published data the vendored solver reads. Core's
/// `SUPPORTED_FORMAT_VERSIONS`; widened when a re-vendor brings a reader for a
/// new format.
export const SUPPORTED_FORMAT_VERSIONS = [2];

/// The URL to ask for a library's `latest.json`: the pointer's path with a
/// `release-check` query of 16 random hex digits, new on every call.
///
/// The pointer is the one object on the origin that changes, and the CDN edge
/// can go on serving an old copy of it for days, whatever the pointer's own
/// Cache-Control says: on 2026-10-17 it named a release that had been deleted,
/// so every file under it was a 404. The edge keys its cache on the query
/// string, so a value it has not seen is answered by the origin. Core's
/// clients ask the same way (`yamc_nuclide::storage::release::pointer_url`).
/// The manifest and the release's files are immutable, and are asked for
/// plainly so the edge goes on caching them.
export function latestUrl(origin, keyword) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${origin}/${keyword}/latest.json?release-check=${nonce}`;
}

/// Parse a library's `latest.json` and check what the page relies on, throwing
/// a message that names the library. A release in a format this solver does
/// not read is refused here, before any of its files are fetched.
export function parseLatest(text, keyword) {
  let latest;
  try {
    latest = JSON.parse(text);
  } catch {
    throw new Error(`${keyword}/latest.json is not JSON`);
  }
  const fields = { release: "string", format_version: "number", manifest: "string", manifest_sha256: "string", manifest_bytes: "number" };
  for (const [field, type] of Object.entries(fields)) {
    if (typeof latest[field] !== type) throw new Error(`${keyword}/latest.json has no ${field}`);
  }
  if (!SUPPORTED_FORMAT_VERSIONS.includes(latest.format_version)) {
    throw new Error(
      `${keyword} release ${latest.release} is format_version ${latest.format_version}, ` +
      `which this page's solver does not read (it reads ${SUPPORTED_FORMAT_VERSIONS.join(", ")}): ` +
      "the page needs a re-vendor");
  }
  return latest;
}

/// Check a manifest's bytes against the pointer that named it and index its
/// files by path, `neutron/Fe56.arrow/version.json` to `{ bytes, sha256 }`.
export async function parseManifest(bytes, latest, keyword) {
  if (bytes.length !== latest.manifest_bytes || await sha256Hex(bytes) !== latest.manifest_sha256.toLowerCase()) {
    throw new Error(`${keyword} release ${latest.release}: manifest.json is not the one latest.json names`);
  }
  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  if (manifest.release !== latest.release || !Array.isArray(manifest.files)) {
    throw new Error(`${keyword} release ${latest.release}: manifest.json does not describe that release`);
  }
  return new Map(manifest.files.map((f) => [f.path, { bytes: f.bytes, sha256: String(f.sha256).toLowerCase() }]));
}

/// Check a whole file against its manifest entry, throwing naming `what` when
/// it differs. A file the manifest does not list (`entry` undefined) is not
/// checked: the caller only asks for listed files when it has a manifest.
export async function checkFile(bytes, entry, what) {
  if (!entry) return false;
  if (bytes.length !== entry.bytes || await sha256Hex(bytes) !== entry.sha256) {
    throw new Error(`${what} is not the file its release manifest lists (size or sha256 differs)`);
  }
  return true;
}
