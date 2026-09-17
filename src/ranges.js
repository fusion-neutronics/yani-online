// Fetching only the MTs a run reads, out of a `reactions.arrow` that holds
// every MT.
//
// The published file is written one Arrow record batch per (MT, temperature),
// so every cross section is already a contiguous byte range in the object, and
// each nuclide's `version.json` names those ranges (`reaction_ranges`, added by
// core's `index_reactions`, keyed by MT and then by temperature). An activation
// run reads the handful of channels its chain names and none of the full-grid
// transport MTs, which are most of the file: measured over 68 ENDF/B-8.1
// nuclides, the MTs `REACTION_MT_MAP` can name are 109 MB of 948 MB, so this is
// 8.7x less to download for the same answer. A plotter can go further and read
// one channel at the one temperature it draws.
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
/// The wanted MTs come out in runs -- (n,p), (n,d), (n,t), (n,3He), (n,a) sit
/// together in the file, since the writer follows ENDF order -- so most of the
/// merging is of ranges that are already touching. At 16 kB the sample above
/// coalesces 10.4 requests per nuclide down to 3.0 while downloading no
/// measurably extra bytes, which is the whole reason for a threshold rather
/// than exact ranges: 1400 nuclides at ten requests each is 14000 requests.
export const COALESCE_GAP = 16 * 1024;

/// Read the byte-range index out of a nuclide's parsed `version.json`.
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
  if (!index || !Array.isArray(index.schema) || !index.mts) return null;
  const mts = new Map();
  for (const [mt, byTemperature] of Object.entries(index.mts)) {
    // One entry in the shape from before the split makes the whole index
    // unusable rather than one MT unfetchable: reading it as a half-index would
    // leave that MT looking unpublished, and a stream missing a channel reacts
    // at zero without saying so. Core's `ReactionRanges::from_json` refuses the
    // same input, and both fall back to fetching the whole file.
    if (!byTemperature || typeof byTemperature !== "object" || Array.isArray(byTemperature)) return null;
    const temperatures = new Map();
    for (const [temperature, range] of Object.entries(byTemperature)) {
      if (!Array.isArray(range)) return null;
      temperatures.set(temperature, { off: range[0], len: range[1] });
    }
    if (temperatures.size) mts.set(Number(mt), temperatures);
  }
  if (!mts.size) return null;
  return { schema: { off: index.schema[0], len: index.schema[1] }, mts };
}

/// The messages a run needs: the schema, then the record batch of every wanted
/// MT this nuclide actually publishes, at every temperature, or at the
/// temperatures `wantedTemperatures` names when it is given (the plotter draws
/// one).
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

/// What to request for one nuclide, and what it will cost.
///
/// `bytes` is the transfer, which is the coalesced total and so is at or above
/// the sum of the parts. `full` is the whole file for comparison, taken as the
/// end of the last batch: the index describes every message in the object, so
/// the only thing past its end is the Arrow footer.
export function planFetch(ranges, wantedMts, gap = COALESCE_GAP, wantedTemperatures = null) {
  const parts = wantedParts(ranges, wantedMts, wantedTemperatures);
  const spans = coalesce(parts, gap);
  let full = 0;
  for (const byTemperature of ranges.mts.values()) {
    for (const { off, len } of byTemperature.values()) full = Math.max(full, off + len);
  }
  return {
    parts,
    spans,
    bytes: spans.reduce((n, s) => n + s.len, 0),
    full,
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
    // Both lists are offset-sorted and short (three spans and ten parts is
    // typical), so a scan is cheaper than an index and there is nothing to keep
    // in step.
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

/// Assemble the files to hand the solver out of what came back.
///
/// Here rather than in the fetch loop because this is the step whose mistakes
/// are quiet ones: a span filed under the wrong index splices a stream from the
/// right bytes in the wrong order, and the loader reads it without complaint.
/// Nothing in it fetches or touches the page, so it can be checked directly.
///
/// `jobs` and `bytes` are positionally aligned, the way `fetchAll` returns them,
/// and `jobs[i].status` is what the origin answered. Arrival order does not
/// matter: spans are filed by the `spanIndex` their plan gave them, not by when
/// they landed.
///
/// Returns the items to hand over, the nuclides something was missing for, the
/// bytes the index saved, and whether any ranged request came back as a whole
/// object, which is the caller's cue to stop asking for ranges.
export function assembleNuclideData(jobs, bytes, plans) {
  const items = [];
  const missing = new Set();
  const bodies = new Map();
  const unranged = new Map();
  let stripped = false;

  for (const [i, job] of jobs.entries()) {
    if (!bytes[i]) {
      missing.add(job.nuclide);
    } else if (!job.range) {
      items.push({ nuclide: job.nuclide, file: job.file, bytes: bytes[i] });
    } else if (job.status !== 206) {
      // Something between the page and the bucket dropped the Range header and
      // answered with the whole object, so what is in hand *is* reactions.arrow.
      // Take it as the file: more bytes than were wanted, and still the right
      // answer.
      unranged.set(job.nuclide, bytes[i]);
      stripped = true;
    } else {
      if (!bodies.has(job.nuclide)) {
        // Filled, not just sized. A bare `new Array(n)` is sparse, and `every`
        // skips holes rather than reporting them, so a span that never arrived
        // read as a complete set and reached the splice, which threw and took
        // the whole run with it instead of reporting one nuclide.
        bodies.set(job.nuclide, new Array(plans.get(job.nuclide).spans.length).fill(null));
      }
      bodies.get(job.nuclide)[job.spanIndex] = bytes[i];
    }
  }

  let saved = 0;
  for (const [nuclide, plan] of plans) {
    const got = bodies.get(nuclide);
    if (unranged.has(nuclide)) {
      items.push({ nuclide, file: "reactions.arrow", bytes: unranged.get(nuclide) });
    } else if (got && got.every(Boolean)) {
      items.push({
        nuclide, file: "reactions.arrow",
        bytes: spliceStream(plan.parts, plan.spans, got),
      });
      saved += plan.full - plan.bytes;
    } else {
      // A stream short a batch is a nuclide short a reaction channel, which
      // reacts at zero without saying so.
      missing.add(nuclide);
    }
  }

  return { items, missing, saved, stripped };
}

/// The `Range` header for a span.
export const rangeHeader = ({ off, len }) => `bytes=${off}-${off + len - 1}`;
