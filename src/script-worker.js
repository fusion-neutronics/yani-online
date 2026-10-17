// Python and yani, off the main thread, for the Python editor.
//
// Adapted from yamc-online's src/worker.js: the same Pyodide start-up, wheel
// install, data fetcher and script runner, for yani-core rather than
// yamc-core. A module worker, loaded from its own file next to the page:
// Pyodide refuses to start in a classic one. Pyodide is imported from the CDN,
// and yani-core is installed with micropip from its Pyodide wheel on PyPI (or
// from a local wheel beside the page, for a build made with `--wheel`).
// A transmutation is one synchronous call into wasm that returns when it is
// done, so on the main thread it would freeze the page for the whole run; here
// it only blocks this thread, and the page stays responsive and can terminate
// it.
//
// Protocol, page to worker: `{ type: "init", ... }`, `{ type: "run", code }`,
// `{ type: "clearData" }`. Worker to page: `status`, `ready`, `stdout`,
// `stderr`, `plot`, `fetch`, `done`, `cleared` and `fatal` messages. stdout,
// plots and fetches are posted while a run is still going, so the page shows
// them live rather than at the end. The `fetch` messages of a batch come from
// the helper in fetcher.js instead, on the port the page hands over in `init`.

// The origin the wheel has compiled in. Every nuclear-data URL starts with it.
const PUBLISHED_ORIGIN = "https://yamc-data.xsplot.com/";

let pyodide = null;
// Where data requests actually go. The published origin unless the page was
// opened with `?data=`, which verify.mjs uses to serve core's fixtures.
let dataOrigin = PUBLISHED_ORIGIN;

const post = (msg) => self.postMessage(msg);

async function getJson(url, missing = null) {
  const r = await fetch(url);
  if (r.status === 404 && missing) throw new Error(missing);
  if (!r.ok) throw new Error(`could not fetch ${url}: HTTP ${r.status}`);
  return r.json();
}

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/// The yani-core wheel to install, as `{ name, bytes }`: the local wheel the
/// page was built with, or else the PyPI release's wheel for this Pyodide.
///
/// Fetched while Pyodide starts, which is why this does not leave it to
/// micropip: micropip only exists once Pyodide has started, and would then
/// ask PyPI's index and download the wheel one after the other. PyPI names
/// each file with its sha256, which the bytes are checked against. The wheel's
/// platform tag (PEP 783) has to be the one this Pyodide's lock file names, so
/// a release built for another Pyodide fails here, saying so.
async function fetchWheel({ pyodideBase, pyodideVersion, yaniCore, wheelUrl }) {
  let file;
  if (wheelUrl) {
    file = { url: wheelUrl, filename: decodeURIComponent(new URL(wheelUrl).pathname.split("/").pop()) };
  } else {
    const [lock, release] = await Promise.all([
      getJson(`${pyodideBase}pyodide-lock.json`),
      getJson(`https://pypi.org/pypi/yani-core/${yaniCore}/json`, `yani-core ${yaniCore} is not on PyPI`),
    ]);
    const platform = `pyemscripten_${lock.info.abi_version}_${lock.info.arch}`;
    file = release.urls.find((f) => f.filename.endsWith(`-${platform}.whl`));
    if (!file) {
      throw new Error(`yani-core ${yaniCore} on PyPI has no wheel for Pyodide ${pyodideVersion} (${platform})`);
    }
  }
  const r = await fetch(file.url);
  if (!r.ok) throw new Error(`could not fetch ${file.url}: HTTP ${r.status}`);
  const bytes = await r.arrayBuffer();
  const expected = file.digests && file.digests.sha256;
  if (expected && hex(await crypto.subtle.digest("SHA-256", bytes)) !== expected) {
    throw new Error(`${file.filename} from PyPI does not match its sha256`);
  }
  return { name: file.filename, bytes: new Uint8Array(bytes) };
}

// The helper worker that fetches a batch of requests concurrently (see
// fetcher.js), and whether this worker can block on it: Atomics.wait on
// shared memory needs the page to be cross-origin isolated.
let helper = null;
const canBatch = self.crossOriginIsolated && typeof SharedArrayBuffer === "function";
// The most one batch's bodies may take, all told. A body that does not fit is
// fetched again on its own. Reserved, not allocated: the buffer grows as the
// bodies arrive.
const BATCH_BYTES = 1 << 30;

const dataUrl = (url) => (url.startsWith(PUBLISHED_ORIGIN) ? dataOrigin + url.slice(PUBLISHED_ORIGIN.length) : url);

/// One blocking GET, as a synchronous XMLHttpRequest.
///
/// `range` is the `Range` header value to send, or null for the whole object.
/// Answers `[status, body]`. A synchronous XMLHttpRequest is what makes this
/// possible at all: the Rust downloader is blocking, and a worker is the one
/// place a browser still allows a synchronous request with an ArrayBuffer
/// response. A network failure (offline, or a CORS refusal) is status 0,
/// which the downloader retries and then reports with the URL.
function fetchSync(url, range) {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", dataUrl(url), false);
  xhr.responseType = "arraybuffer";
  if (range != null) xhr.setRequestHeader("Range", range);
  const started = performance.now();
  let status = 0;
  try {
    xhr.send();
    status = xhr.status;
  } catch {
    status = 0;
  }
  // Only a success carries a body worth handing over: an error page is not
  // nuclear data, and the downloader only reads the status of a 404.
  const ok = status >= 200 && status < 300;
  const body = ok ? new Uint8Array(xhr.response) : new Uint8Array(0);
  post({ type: "fetch", url, range, status, bytes: body.length, ms: performance.now() - started });
  return [status, body];
}

/// Every GET of a batch, concurrently, blocking until all are answered.
///
/// The helper worker fetches them with async fetch() and writes each body into
/// a growable SharedArrayBuffer, and this worker sleeps in Atomics.wait until
/// the count of answers reaches the batch size. Answers `[status, body]` per
/// request, in order.
function fetchBatch(requests) {
  const n = requests.length;
  const ctl = new Int32Array(new SharedArrayBuffer(4 * (1 + 3 * n)));
  const arena = new SharedArrayBuffer(0, { maxByteLength: BATCH_BYTES });
  helper.postMessage({ requests, ctl, arena, dataOrigin });
  for (let done = Atomics.load(ctl, 0); done < n; done = Atomics.load(ctl, 0)) {
    Atomics.wait(ctl, 0, done);
  }
  return requests.map((_, i) => {
    const [status, offset, length] = [ctl[1 + 3 * i], ctl[2 + 3 * i], ctl[3 + 3 * i]];
    return [status, new Uint8Array(arena, offset, length)];
  });
}

/// The wheel's data fetcher: a list of `[url, range]` requests in, one
/// `[status, body]` per request out. A batch goes to the helper; a single
/// request, or any request on a page that is not cross-origin isolated, is a
/// synchronous XMLHttpRequest, which costs no shared memory and no hop.
function fetchMany(pyRequests) {
  const requests = pyRequests.toJs().map(([url, range]) => [url, range ?? null]);
  if (requests.length > 1 && canBatch && helper) return fetchBatch(requests);
  return requests.map(([url, range]) => fetchSync(url, range));
}
self.yaniFetch = fetchMany;
self.yaniShow = (html, title) => post({ type: "plot", html, title });

// Installed once at boot. `show` is in builtins so a user script and anything
// it imports can call it without an import, as in a notebook.
const PRELUDE = `
import ast, builtins, importlib.util, io, os, shutil, sys, traceback

# Before anything imports matplotlib: a worker has no document to draw into.
os.environ["MPLBACKEND"] = "Agg"

import js
import yani
from yani import _core


def _fetch(requests):
    return [(int(status), body.to_bytes()) for status, body in js.yaniFetch(requests)]


_core._set_data_fetcher(_fetch)


def _figure_html(obj):
    """The page a figure is drawn in, or None for an object with no display.

    A plotly figure carries plotly.js inside the page, from the plotly package
    itself, so the frame needs no network and a saved plot opens anywhere. A
    matplotlib figure is drawn as SVG. Anything else with a rich display uses
    it.
    """
    module = type(obj).__module__ or ""
    if module.startswith("plotly.") and hasattr(obj, "to_html"):
        return obj.to_html(include_plotlyjs=True, full_html=True)
    if module.startswith("matplotlib.") and hasattr(obj, "savefig"):
        buffer = io.StringIO()
        obj.savefig(buffer, format="svg", bbox_inches="tight")
        return buffer.getvalue()
    render = getattr(obj, "_repr_html_", None)
    return None if render is None else render()


def show(obj, title=None):
    """Draw an object in the Plots tab.

    A plotly or matplotlib figure, or anything with a rich HTML display, such
    as a \`Material\`. A line of a script that is just such an object, such as
    \`figure\` on its own, is shown the same way wherever it stands, so it needs
    no call to this. \`figure.show()\` and \`plt.show()\` draw here too.

    Args:
        obj: The object to draw.
        title: Caption above the plot. Defaults to the figure's title, or the
            object's type name.
    """
    html = _figure_html(obj)
    if html is None:
        raise TypeError(f"show() needs a figure or an object with a rich display, not {type(obj).__name__}")
    if title is None:
        layout = getattr(obj, "layout", None)
        text = getattr(getattr(layout, "title", None), "text", None)
        title = text or type(obj).__name__
    js.yaniShow(html, title)


builtins.show = show


def _plotly_renderer():
    # \`figure.show()\` draws in the Plots tab, as it would open a browser tab
    # locally. Registered when a script imports plotly, not at start-up: plotly
    # is installed only once a script asks for it.
    import plotly.io as pio
    from plotly.io.base_renderers import ExternalRenderer

    class _Page(ExternalRenderer):
        def render(self, fig_dict):
            import plotly.graph_objects as go

            show(go.Figure(fig_dict))

    pio.renderers["yani_online"] = _Page()
    pio.renderers.default = "yani_online"


def _mpl_show(*args, **kwargs):
    # \`plt.show()\`: every open figure, in order, then closed, as an inline
    # backend would.
    import matplotlib.pyplot as plt

    for number in plt.get_fignums():
        show(plt.figure(number))
    plt.close("all")


def _prepare(imports):
    imports = _top_level(imports)
    if "plotly" in imports:
        _plotly_renderer()
    if "matplotlib" in imports:
        import matplotlib.pyplot as plt

        plt.show = _mpl_show


def _top_level(imports):
    # \`import plotly.graph_objects\` is the plotly package.
    return sorted({name.split(".")[0] for name in imports})


def _missing(imports):
    # The top-level modules a script imports that are not installed. micropip
    # is asked for them before the run, from Pyodide's own packages first and
    # then PyPI, as pip would be locally.
    return [name for name in _top_level(imports) if importlib.util.find_spec(name) is None]


_SCRIPT = "yani_run.py"


def _print_exception(error):
    # Drop the frames above the user's script: they are this prelude and
    # Pyodide's own machinery, which say nothing about the script.
    tb = error.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename != _SCRIPT:
        tb = tb.tb_next
    lines = traceback.format_exception(type(error), error, tb)
    sys.stderr.write("".join(lines))


def _displayable(value):
    module = type(value).__module__ or ""
    return (
        hasattr(value, "_repr_html_")
        or (module.startswith("plotly.") and hasattr(value, "to_html"))
        or (module.startswith("matplotlib.") and hasattr(value, "savefig"))
    )


def _show_rich(value, receiver=None):
    # What a top-level expression before the last is wrapped in: drawn if it
    # has a display, and otherwise left alone, as a script would. A method
    # that answers the object it was called on, as plotly's add_scatter and
    # update_layout do, is building a figure rather than asking to see it,
    # so that is not drawn: the figure is, where the script names it.
    if receiver is not None and value is receiver():
        return
    if _displayable(value):
        show(value)


def _compile(source):
    """Compile a script so every top-level expression with a display is drawn,
    and the last expression's value comes back.

    A script with \`figure\` partway down then draws it where it stands, as a
    notebook cell would, rather than only when it is the last line. Every node
    keeps its line number, so tracebacks point at the script as written.
    """
    tree = ast.parse(source, filename=_SCRIPT)
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body.pop().value)
    for i, node in enumerate(tree.body):
        if isinstance(node, ast.Expr):
            args = [node.value]
            func = node.value.func if isinstance(node.value, ast.Call) else None
            if isinstance(func, ast.Attribute):
                # The object the method was called on, read after the call.
                args.append(ast.Lambda(ast.arguments([], [], None, [], [], None, []), func.value))
            call = ast.Call(ast.Name("_show_rich", ast.Load()), args, [])
            tree.body[i] = ast.copy_location(ast.Expr(ast.copy_location(call, node.value)), node)
    ast.fix_missing_locations(tree)
    body = compile(tree, _SCRIPT, "exec")
    return body, None if last is None else compile(last, _SCRIPT, "eval")


def _run(source, imports):
    """Run a script in a fresh namespace, as \`python yani_run.py\` would.

    Synchronously, not with eval_code_async: under the async runner a blocking
    call such as time.sleep can suspend to the event loop, and an interrupt
    then lands in the loop's machinery rather than in the script.
    """
    namespace = {"__name__": "__main__", "__file__": _SCRIPT, "show": show, "_show_rich": _show_rich}
    try:
        _prepare(imports)
        body, last = _compile(source)
        exec(body, namespace)
        value = None if last is None else eval(last, namespace)
    except BaseException as error:  # noqa: BLE001  (KeyboardInterrupt too)
        _print_exception(error)
        return False
    if value is not None:
        if _displayable(value):
            show(value)
        else:
            print(repr(value))
    if "matplotlib.pyplot" in sys.modules:
        _mpl_show()
    return True


def _names():
    # What the editor completes after \`yani.\` and \`yani.<submodule>.\`.
    def kind(value):
        if isinstance(value, type):
            return "class"
        if callable(value):
            return "function"
        if type(value).__name__ == "module":
            return "namespace"
        return "variable"

    out = {}
    for prefix, module in (("yani", yani), *((f"yani.{m}", getattr(yani, m)) for m in ("sources", "materials", "data", "shapes"))):
        out[prefix] = [[name, kind(getattr(module, name))] for name in dir(module) if not name.startswith("_")]
    return out


def _cache_root():
    return _core.cache_dir()


def _held_bytes():
    total = 0
    for root, _dirs, files in os.walk(_cache_root()):
        for name in files:
            total += os.path.getsize(os.path.join(root, name))
    return total


def _clear_data():
    shutil.rmtree(_cache_root(), ignore_errors=True)
`;

/// Bytes the page is holding for Python: the wasm heap, and the downloaded
/// nuclear data in Emscripten's in-memory filesystem, which lives outside it.
function memory() {
  return {
    heap: pyodide._module.HEAP8.length,
    held: pyodide.globals.get("_held_bytes")(),
  };
}

/// Install what a script imports and Pyodide does not carry, such as plotly,
/// before it runs. micropip takes Pyodide's own packages from the CDN and the
/// rest from PyPI.
async function installImports(code) {
  let imports;
  try {
    imports = pyodide.pyimport("pyodide.code").find_imports(code).toJs();
  } catch {
    // A syntax error: the run reports it.
    return [];
  }
  const missing = pyodide.globals.get("_missing")(imports).toJs();
  if (missing.length) {
    post({ type: "status", text: `Installing ${missing.join(", ")}` });
    try {
      await pyodide.pyimport("micropip").install(missing);
    } catch (e) {
      // Left for the import to fail in the script, with the line it is on.
      post({ type: "stderr", text: `Could not install ${missing.join(", ")}: ${String((e && e.message) || e).split("\n").pop()}` });
    }
  }
  return imports;
}

const handlers = {
  async init({ pyodideBase, pyodideVersion, yaniCore, wheelUrl, data, interruptBuffer, fetchPort }) {
    if (data) dataOrigin = data.endsWith("/") ? data : `${data}/`;
    if (canBatch) {
      helper = new Worker(new URL("fetcher.js", import.meta.url));
      // The helper reports each request to the page directly: this worker is
      // asleep in Atomics.wait while it works, and could not pass them on.
      helper.postMessage({ port: fetchPort }, [fetchPort]);
    }
    // The wheel downloads while Pyodide does, rather than after it: the two
    // are the bulk of the start-up time and neither needs the other.
    const wheel = fetchWheel({ pyodideBase, pyodideVersion, yaniCore, wheelUrl });
    wheel.catch(() => {}); // Reported where it is awaited, not as unhandled.
    post({ type: "status", text: "Loading Python" });
    const { loadPyodide } = await import(`${pyodideBase}pyodide.mjs`);
    pyodide = await loadPyodide({ indexURL: pyodideBase, packages: ["micropip"] });
    pyodide.setStdout({ batched: (text) => post({ type: "stdout", text }) });
    pyodide.setStderr({ batched: (text) => post({ type: "stderr", text }) });
    if (interruptBuffer) pyodide.setInterruptBuffer(interruptBuffer);
    post({ type: "status", text: "Installing yani" });
    // micropip installs from the bytes already fetched: it checks the wheel's
    // tags against this Pyodide and puts it in site-packages. yani-core has no
    // dependencies, so it asks nothing of the network.
    const { name, bytes } = await wheel;
    pyodide.FS.writeFile(`/tmp/${name}`, bytes);
    await pyodide.pyimport("micropip").install(`emfs:/tmp/${name}`);
    await pyodide.runPythonAsync(PRELUDE);
    post({
      type: "ready",
      yani: pyodide.runPython("yani.__version__"),
      python: pyodide.runPython("sys.version.split()[0]"),
      pyodide: pyodide.version,
      names: pyodide.globals.get("_names")().toJs({ dict_converter: Object.fromEntries }),
      dataOrigin,
      memory: memory(),
    });
  },

  async run({ code }) {
    const started = performance.now();
    const imports = await installImports(code);
    const ok = pyodide.globals.get("_run")(code, imports);
    post({ type: "done", ok, seconds: (performance.now() - started) / 1000, memory: memory() });
  },

  clearData() {
    pyodide.globals.get("_clear_data")();
    post({ type: "cleared", memory: memory() });
  },
};

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    await handlers[msg.type](msg);
  } catch (e) {
    // Anything reaching here was not caught by the Python wrapper, which
    // catches every Python exception. So it is Pyodide itself failing: a Rust
    // panic aborts the wasm instance, and after that the interpreter is gone.
    // The page starts a new worker.
    post({ type: "fatal", message: String((e && e.message) || e) });
  }
};
