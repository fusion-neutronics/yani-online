// The nuclear data this page has downloaded, shared between the form and the
// Python tab.
//
// The two run separate solvers in separate workers, and each used to download
// what it needed whatever the other already had. Both now ask through
// `sharedFetch`, which answers what this store holds and goes to the network
// only for the rest, so whichever runs second reuses what the first fetched.
//
// They do not ask for the same requests: the form reads narrow slices of a
// file and the wheel wider blocks around them, several at once. So the store
// keeps bytes by file and offset rather than by request, and an answer is
// assembled from whatever spans cover it, fetching only the gaps.
//
// Pure data and arithmetic around `fetch`, no DOM, so verify.mjs checks it
// without a browser.

/// Parse a `Range` header value, `bytes=0-99,200-299`, into inclusive
/// `[first, last]` pairs. `null` for no header (the whole object) or for a form
/// this does not read, such as a suffix range, which is then fetched as asked.
export function parseRange(header) {
  if (header == null) return null;
  const m = /^bytes=(.+)$/.exec(header.trim());
  if (!m) return undefined;
  const ranges = [];
  for (const part of m[1].split(",")) {
    const r = /^\s*(\d+)-(\d+)\s*$/.exec(part);
    if (!r) return undefined;
    const [first, last] = [Number(r[1]), Number(r[2])];
    if (last < first) return undefined;
    ranges.push([first, last]);
  }
  return ranges;
}

/// The `Range` header value for inclusive `[first, last]` pairs.
export const rangeValue = (ranges) => `bytes=${ranges.map(([a, b]) => `${a}-${b}`).join(",")}`;

const CRLF = [13, 10];
const ascii = (s) => new TextEncoder().encode(s);

/// Read a `multipart/byteranges` body into `[first, bytes]` parts, as the
/// wheel's `parse_byteranges` does: the boundary from the body's first line and
/// each part's length from its `Content-Range`, never by searching for the next
/// boundary, which binary data could contain. `null` if it is not one.
export function parseByteranges(body) {
  const lineEnd = (from) => {
    for (let i = from; i + 1 < body.length; i++) if (body[i] === 13 && body[i + 1] === 10) return i;
    return -1;
  };
  const text = (a, b) => new TextDecoder().decode(body.subarray(a, b));
  let pos = 0;
  while (body[pos] === 13 && body[pos + 1] === 10) pos += 2;
  let end = lineEnd(pos);
  if (end < 0) return null;
  const first = text(pos, end);
  if (!first.startsWith("--") || first.length < 3) return null;
  pos = end + 2;
  const parts = [];
  for (;;) {
    let range = null;
    for (;;) {
      end = lineEnd(pos);
      if (end < 0) return null;
      const line = text(pos, end);
      pos = end + 2;
      if (line === "") break;
      const m = /^content-range:\s*bytes\s+(\d+)-(\d+)\//i.exec(line);
      if (m) range = [Number(m[1]), Number(m[2])];
    }
    if (!range) return null;
    const length = range[1] - range[0] + 1;
    if (pos + length > body.length) return null;
    parts.push([range[0], body.slice(pos, pos + length)]);
    pos += length;
    // The CRLF that ends the part, then the next delimiter line.
    while (body[pos] === 13 && body[pos + 1] === 10) pos += 2;
    end = lineEnd(pos);
    const delimiter = end < 0 ? text(pos, body.length) : text(pos, end);
    if (!delimiter.startsWith("--")) return null;
    if (delimiter.endsWith("--")) return parts;
    pos = end + 2;
  }
}

/// A `multipart/byteranges` body for `[first, bytes]` parts, in the shape
/// `parseByteranges` (and the wheel) reads.
export function buildByteranges(parts, boundary = "yani-online-shared-bytes") {
  const chunks = [];
  for (const [first, bytes] of parts) {
    chunks.push(ascii(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n`
      + `Content-Range: bytes ${first}-${first + bytes.length - 1}/*\r\n\r\n`), bytes);
  }
  chunks.push(ascii(`\r\n--${boundary}--\r\n`));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/// The bytes held per URL: the whole object when it was fetched whole, else
/// non-overlapping spans, merged as they touch. Bounded: past `limit` bytes the
/// files held longest are dropped, which costs only a download again later.
export class ByteStore {
  constructor(limit = 768 * 2 ** 20) {
    this.limit = limit;
    this.files = new Map();
    this.size = 0;
  }

  /// Whether `url` is something to keep: the release's files are immutable,
  /// but a URL with a query (latest.json's release-check) names an answer that
  /// changes, and is never held.
  static keeps(url) {
    return !url.includes("?");
  }

  file(url) {
    let f = this.files.get(url);
    if (!f) {
      f = { whole: null, spans: [] };
      this.files.set(url, f);
    }
    return f;
  }

  putWhole(url, bytes) {
    if (!ByteStore.keeps(url)) return;
    const f = this.file(url);
    this.size -= f.whole ? f.whole.length : f.spans.reduce((n, s) => n + s.bytes.length, 0);
    f.whole = bytes;
    f.spans = [];
    this.size += bytes.length;
    this.evict(url);
  }

  /// Hold `bytes` at offset `first` of `url`, merged with any span it touches.
  putSpan(url, first, bytes) {
    if (!ByteStore.keeps(url) || !bytes.length) return;
    const f = this.file(url);
    if (f.whole) return;
    let start = first;
    let end = first + bytes.length;
    const keep = [];
    const merge = [];
    for (const s of f.spans) {
      const sEnd = s.first + s.bytes.length;
      if (sEnd < start || s.first > end) keep.push(s);
      else {
        merge.push(s);
        start = Math.min(start, s.first);
        end = Math.max(end, sEnd);
      }
    }
    let span;
    if (!merge.length) {
      span = { first, bytes };
    } else {
      const out = new Uint8Array(end - start);
      for (const s of merge) out.set(s.bytes, s.first - start);
      out.set(bytes, first - start);
      span = { first: start, bytes: out };
    }
    const before = f.spans.reduce((n, s) => n + s.bytes.length, 0);
    f.spans = [...keep, span].sort((a, b) => a.first - b.first);
    this.size += f.spans.reduce((n, s) => n + s.bytes.length, 0) - before;
    this.evict(url);
  }

  /// Drop the files held longest until the store fits, never `current`.
  evict(current) {
    for (const [url, f] of this.files) {
      if (this.size <= this.limit) break;
      if (url === current) continue;
      this.size -= f.whole ? f.whole.length : f.spans.reduce((n, s) => n + s.bytes.length, 0);
      this.files.delete(url);
    }
    // Held longest = inserted first: refresh the one just used.
    const f = this.files.get(current);
    if (f) {
      this.files.delete(current);
      this.files.set(current, f);
    }
  }

  /// The whole object, if it was fetched whole.
  whole(url) {
    const f = this.files.get(url);
    return f && f.whole;
  }

  /// Bytes `first..=last` of `url`, or null if they are not all held.
  read(url, first, last) {
    const f = this.files.get(url);
    if (!f) return null;
    if (f.whole) return last < f.whole.length ? f.whole.subarray(first, last + 1) : null;
    for (const s of f.spans) {
      if (s.first <= first && last < s.first + s.bytes.length) {
        return s.bytes.subarray(first - s.first, last - s.first + 1);
      }
    }
    return null;
  }

  /// The parts of `ranges` not held, as inclusive `[first, last]` pairs.
  missing(url, ranges) {
    const f = this.files.get(url);
    if (f && f.whole) return ranges.filter(([, last]) => last >= f.whole.length);
    const spans = f ? f.spans : [];
    const out = [];
    for (const [a, b] of ranges) {
      let at = a;
      for (const s of spans) {
        const sLast = s.first + s.bytes.length - 1;
        if (sLast < at || s.first > b) continue;
        if (s.first > at) out.push([at, s.first - 1]);
        at = Math.max(at, sLast + 1);
        if (at > b) break;
      }
      if (at <= b) out.push([at, b]);
    }
    return out;
  }
}

/// Whether a failed answer is worth asking again: the origin, or something on
/// the way to it, was busy or broken for a moment. A 404 is an answer.
export const retryable = (status) => status === 0 || status === 408 || status === 429 || status >= 500;

/// The waits before each retry, scaled by a random 0.5 to 1.5 so that requests
/// which failed together do not all come back at once.
const BACKOFF_MS = [250, 1000, 3000];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// Fetch `target` and read its body, asking again when the request fails, when
/// the body stops part way (a dropped connection rejects `arrayBuffer()`), or
/// when the status is `retryable`. A run of a few thousand requests on the
/// live origin lost a handful this way, in bursts. `{status, ok, body}`, with
/// the last answer's status when every try failed, and the last error thrown
/// when none arrived at all.
export async function fetchBytes(fetchImpl, target, init, { sleep = pause } = {}) {
  for (let attempt = 0; ; attempt++) {
    const last = attempt === BACKOFF_MS.length;
    try {
      const response = await fetchImpl(target, init);
      if (response.ok) {
        return { status: response.status, ok: true, body: new Uint8Array(await response.arrayBuffer()) };
      }
      if (last || !retryable(response.status)) return { status: response.status, ok: false, body: null };
    } catch (e) {
      if (last) throw e;
    }
    await sleep(BACKOFF_MS[attempt] * (0.5 + Math.random()));
  }
}

/// The most ranges in one request, as the wheel sends (`MAX_RANGES_PER_REQUEST`
/// in url_cache.rs): servers cap the header's length.
const MAX_RANGES = 200;

/// Fetch `url`, or the `range` of it (a `Range` header value), through
/// `store`: what it holds is answered from it, and only the rest is fetched,
/// from `target` (the URL to ask the network, which a local data origin
/// rewrites). The answer has the shape a direct fetch would: `status` 200 and
/// the whole object for no range; 206 and the bytes for one range; 206 and a
/// `multipart/byteranges` body for several. A failure is its status and no
/// body, as the network gave it.
///
/// `reused` and `fetched` count the bytes the store answered and the bytes
/// that came over the network, for the page to report. Every request goes
/// through `fetchBytes`, so a failure here is one that retrying did not fix.
export async function sharedFetch(store, url, range, { target = url, fetchImpl = fetch, sleep } = {}) {
  const ranges = parseRange(range);
  const get = (headers) => fetchBytes(fetchImpl, target, { headers }, { sleep });
  const direct = async () => {
    const response = await get(range == null ? {} : { Range: range });
    return { status: response.status, body: response.body, reused: 0, fetched: response.body ? response.body.length : 0 };
  };
  if (!ByteStore.keeps(url) || ranges === undefined) return direct();

  if (ranges === null) {
    const held = store.whole(url);
    if (held) return { status: 200, body: held.slice(), reused: held.length, fetched: 0 };
    const answer = await direct();
    if (answer.status === 200 && answer.body) store.putWhole(url, answer.body.slice());
    return answer;
  }

  let fetched = 0;
  const gaps = store.missing(url, ranges);
  for (let i = 0; i < gaps.length; i += MAX_RANGES) {
    const chunk = gaps.slice(i, i + MAX_RANGES);
    const response = await get({ Range: rangeValue(chunk) });
    if (!response.ok) return { status: response.status, body: null, reused: 0, fetched };
    const body = response.body;
    if (response.status === 200) {
      // The Range header was dropped on the way: this is the whole object.
      fetched += body.length;
      store.putWhole(url, body.slice());
      break;
    }
    const parts = chunk.length > 1 ? parseByteranges(body) : [[chunk[0][0], body]];
    // The data, not the multipart framing around it.
    if (parts) fetched += parts.reduce((n, [, bytes]) => n + bytes.length, 0);
    if (!parts) {
      // A multi-range request answered some other way: ask a gap at a time.
      for (const gap of chunk) {
        const one = await get({ Range: rangeValue([gap]) });
        if (!one.ok) return { status: one.status, body: null, reused: 0, fetched };
        const bytes = one.body;
        fetched += bytes.length;
        if (one.status === 200) {
          store.putWhole(url, bytes.slice());
          break;
        }
        store.putSpan(url, gap[0], bytes.slice());
      }
      continue;
    }
    for (const [first, bytes] of parts) store.putSpan(url, first, bytes.slice());
  }

  const pieces = ranges.map(([a, b]) => [a, store.read(url, a, b)]);
  if (pieces.some(([, bytes]) => !bytes)) {
    // Not held after all (evicted under pressure, or a short answer): ask the
    // network exactly as the caller did.
    return direct();
  }
  const total = pieces.reduce((n, [, bytes]) => n + bytes.length, 0);
  const reused = Math.max(0, total - fetched);
  const body = pieces.length === 1 ? pieces[0][1].slice() : buildByteranges(pieces);
  return { status: 206, body, reused, fetched };
}
