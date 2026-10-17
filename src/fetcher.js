// The Python worker's network, for the requests it makes in batches.
//
// Copied from yamc-online's src/fetcher.js, which the yani-core wheel's data
// fetcher hook shares with yamc-core's: a fix to one belongs in both.
//
// The Python worker cannot await anything during a run: the wheel's downloader
// is blocking Rust, so its requests used to be synchronous XMLHttpRequests made
// one after another, a round trip each. When the downloader has a batch of
// independent requests it hands all of them to this worker and blocks on
// `Atomics.wait`; this worker fetches them concurrently with ordinary async
// fetch(), writes each answer into shared memory, and wakes it.
//
// Message, Python worker to this worker:
//   { requests: [[url, range], ...], ctl, arena, dataOrigin }
// `ctl` is an Int32Array on a SharedArrayBuffer: ctl[0] counts the requests
// answered, and request i's status, offset and length are at 1 + 3i. `arena`
// is a growable SharedArrayBuffer the bodies are appended to. Status 0 means
// the request did not complete. Each answer is also reported to the page, on
// the port it handed over at start, as a `fetch` message.

const PUBLISHED_ORIGIN = "https://yamc-data.xsplot.com/";
// Requests in flight at once. The data origin speaks HTTP/2, so they share
// one connection, and a ranged request costs its round trip rather than its
// bytes: the form's own fetch measured the same closure at 38 s with 12 in
// flight and 21 s with 48 (dev-readme.md).
const CONCURRENCY = 32;

let page = null;

async function answer(i, [url, range], ctl, arena, dataOrigin, alloc) {
  const target = url.startsWith(PUBLISHED_ORIGIN) ? dataOrigin + url.slice(PUBLISHED_ORIGIN.length) : url;
  const started = performance.now();
  let status = 0;
  let body = null;
  try {
    const response = await fetch(target, { headers: range == null ? {} : { Range: range }, cache: "no-store" });
    status = response.status;
    // Only a success carries a body worth handing over, as in the
    // synchronous path.
    if (response.ok) body = new Uint8Array(await response.arrayBuffer());
  } catch {
    status = 0;
  }
  let offset = 0;
  const length = body ? body.length : 0;
  if (body) {
    try {
      offset = alloc(length);
      new Uint8Array(arena, offset, length).set(body);
    } catch {
      // Bigger than a batch may hold, or memory ran out. Status 0 makes the
      // downloader ask for it again on its own, which goes the synchronous
      // way. Every request is answered whatever happens: the Python worker
      // is waiting for all of them.
      status = 0;
    }
  }
  ctl[1 + 3 * i] = status;
  ctl[2 + 3 * i] = offset;
  ctl[3 + 3 * i] = status === 0 ? 0 : length;
  Atomics.add(ctl, 0, 1);
  Atomics.notify(ctl, 0);
  if (page) page.postMessage({ type: "fetch", url, range, status, bytes: status === 0 ? 0 : length, ms: performance.now() - started, batched: true });
}

async function batch({ requests, ctl, arena, dataOrigin }) {
  // The bodies are appended to the arena, which grows as they arrive. This
  // worker is one thread, so the allocation needs no lock.
  let used = 0;
  const alloc = (length) => {
    const need = used + length;
    if (need > arena.maxByteLength) throw new RangeError("the batch is full");
    if (need > arena.byteLength) arena.grow(Math.min(arena.maxByteLength, Math.max(need, 2 * arena.byteLength)));
    const offset = used;
    used = need;
    return offset;
  };
  let next = 0;
  const lane = async () => {
    while (next < requests.length) {
      const i = next++;
      await answer(i, requests[i], ctl, arena, dataOrigin, alloc);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, requests.length) }, lane));
}

self.onmessage = (event) => {
  if (event.data.port) {
    page = event.data.port;
    return;
  }
  batch(event.data);
};
