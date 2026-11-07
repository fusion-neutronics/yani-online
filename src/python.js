// The current setup, written out as a yani script.
//
// The page is a front end for a Python API, and everything it can express --
// a material, five data sources, a spectrum, a schedule -- maps onto that API
// one to one. So the setup someone builds by clicking can be handed back as
// the code that reproduces it, which is the difference between a demo and a
// starting point: no download budget, no browser tab, and the plots are the
// same plots.
//
// Generated rather than templated from a fixed example, because a script that
// does not match what is on screen is worse than no script at all.

/// Python literals. Numbers go out in exponential form past the range where a
/// decimal expansion stops being readable -- `1e+14` rather than fourteen
/// zeros -- which Python parses identically.
const num = (v) => {
  if (!Number.isFinite(v)) throw new Error(`cannot write ${v} as a Python number`);
  if (v !== 0 && (Math.abs(v) >= 1e5 || Math.abs(v) < 1e-4)) return v.toExponential();
  return String(v);
};
const str = (s) => JSON.stringify(String(s));

/// A sentence as Python comment lines, wrapped at a readable width.
function commentLines(text, width = 79) {
  const lines = [];
  let line = "#";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line.length + 1 + word.length > width && line !== "#") {
      lines.push(line);
      line = "#";
    }
    line += ` ${word}`;
  }
  if (line !== "#") lines.push(line);
  return lines;
}

/// A list, wrapped at a readable width. A 709-group flux is one of these, and
/// on one line it would be a kilometre wide.
function list(values, indent = 4) {
  const items = values.map(num);
  const oneLine = `[${items.join(", ")}]`;
  if (oneLine.length <= 76) return oneLine;
  const pad = " ".repeat(indent);
  const lines = [];
  let line = pad;
  for (const item of items) {
    if (line.length + item.length + 2 > 76) {
      lines.push(line.trimEnd());
      line = pad;
    }
    line += `${item}, `;
  }
  lines.push(line.trimEnd());
  return `[\n${lines.join("\n")}\n${" ".repeat(indent - 4)}]`;
}

/// The material, as the two ways the form can express one.
///
/// The temperature goes with it, because that is where the wheel keeps it: a
/// material's temperature is what its cross sections are read at. Written out
/// even at the default, since the page fetched one temperature and the script
/// should read the same one rather than the library's lowest, which is what
/// the wheel settles on when a material names none.
function materialSource(material, temperature) {
  if (material.kind === "pnnl") {
    return [
      `# ${material.name}, from the compendium compiled into yani.`,
      `material = yani.materials.pnnl[${str(material.name)}]`,
      `material.volume = ${num(material.volume)}  # cm^3, required for activity and decay heat`,
      `material.temperature = ${num(temperature)}  # K, what the cross sections are read at`,
    ].join("\n");
  }
  const composition = Object.entries(material.composition)
    .map(([name, fraction]) => `        ${str(name)}: ${num(fraction)},`)
    .join("\n");
  return [
    "material = yani.Material(",
    "    {",
    composition,
    "    },",
    `    ${num(material.density)},`,
    `    density_units=${str(material.units)},`,
    `    fraction_type=${str(material.fractionType)},`,
    `    volume=${num(material.volume)},  # cm^3, required for activity and decay heat`,
    `    temperature=${num(temperature)},  # K, what the cross sections are read at`,
    ")",
  ].join("\n");
}

/// The spectrum. A named group structure goes out by name rather than as its
/// boundaries: `Histogram` resolves "CCFE-709" itself, and 710 numbers inlined
/// would bury the rest of the script.
function spectrumSource(spectrum) {
  if (spectrum.structure) {
    // A tokamak preset's magnitude goes in as a comment, with its uncertainty
    // and, for one short of its statistics gate, why: the shape is what the
    // source takes, and the rate is each pulse's, which may or may not be it.
    const magnitude = Number.isFinite(spectrum.flux)
      ? [
        `# Its total flux at the model's full power is ${num(spectrum.flux)} n/cm2/s`
          + `${Number.isFinite(spectrum.fluxRelErr) ? ` +/- ${Number((100 * spectrum.fluxRelErr).toPrecision(2))}%` : ""}`
          + ` (${num(spectrum.fusionPowerMW)} MW fusion).`,
        ...(spectrum.shortOfGate ? commentLines(spectrum.shortOfGate) : []),
      ]
      : [];
    return [
      spectrum.label
        ? `# ${spectrum.label}, one of the page's presets, on ${spectrum.structure}, resolved by name inside yani.`
        : `# ${spectrum.structure}, resolved by name inside yani.`,
      ...magnitude,
      `flux = ${list(spectrum.values)}`,
      `spectrum = yani.NeutronSource(`,
      `    energy=yani.sources.Histogram(${str(spectrum.structure)}, flux)`,
      `)`,
    ].join("\n");
  }
  return [
    `# ${spectrum.label}. The shape is normalised, so the magnitude comes from`,
    "# each pulse's rate below.",
    `boundaries = ${list(spectrum.boundaries)}  # eV`,
    `values = ${list(spectrum.values)}`,
    "spectrum = yani.NeutronSource(energy=yani.sources.Histogram(boundaries, values))",
  ].join("\n");
}

/// The whole script.
///
/// `setup` is the page's own state, already resolved: no DOM, no solver, and
/// no async, so this is testable and cannot half-write a file. With `browser`
/// it is the script the Python tab opens: the same, except that it draws its
/// figures in the page rather than writing them to files.
export function pythonScript(setup, { browser = false } = {}) {
  const { libraries, temperature, material, spectrum, schedule } = setup;
  const steps = schedule
    .map((s) =>
      s.kind === "pulse"
        ? `    ("pulse", ${num(s.rate)}, (${num(s.value)}, ${str(s.unit)})),`
        : `    ("cooldown", None, (${num(s.value)}, ${str(s.unit)})),`)
    .join("\n");

  const header = browser
    ? `"""A transmutation, as set up in the form of YANI online.

Run here, in the browser, by the yani Python package itself. Edit it: this is a
starting point, not an export format. Download .py saves it to run locally,
where it is the same script:

    pip install yani plotly
    python yani_run.py

The first run fetches the nuclear data the transmutation reaches, and later
runs in this tab read it from memory.
"""`
    : `"""A transmutation, as set up in YANI online.

Generated by ${location.href.startsWith("file:") ? "a local copy of" : ""} the browser front end at
https://fusion-neutronics.github.io/yani-online/ -- the same solver, run
locally instead. Edit it: this is a starting point, not an export format.

    pip install yani plotly
    python ${"yani_run.py"}

The data is fetched on demand and cached, so the first run is slower than the
ones after it. Unlike the browser, nothing here is bounded by what a tab will
hold: swap the material for something with fifty elements, or the schedule for
a full operating history, and it is the same three calls.
"""`;
  // Files locally; in the Python tab, figure.show() draws each in the page.
  const output = browser
    ? `for figure in figures.values():
    figure.show()
`
    : `for name, figure in figures.items():
    figure.write_html(f"yani_{name}.html")
    print(f"wrote yani_{name}.html")

# figure.show() instead, for an interactive window rather than files.
`;

  return `${header}

import yani
import plotly.graph_objects as go

# --- nuclear data ---------------------------------------------------------
#
# Each subsection is sourced independently, so a network can mix libraries.
# These are the five the page had selected.
yani.cross_section_data = ${str(libraries.xs)}
yani.transmutation_decay_data = ${str(libraries.decay)}
yani.transmutation_reactions = ${str(libraries.reactions)}
yani.transmutation_fission_yields = ${str(libraries.fission_yields)}
yani.transmutation_branch_ratios = ${str(libraries.branching)}

# --- material -------------------------------------------------------------

${materialSource(material, temperature)}

# --- neutron spectrum -----------------------------------------------------

${spectrumSource(spectrum)}

# --- irradiation schedule -------------------------------------------------
#
# One entry per step, and the single source of truth for both the schedule and
# the time axis below. A cooldown's duration is the length of *that step*, not
# a cumulative time.
SCHEDULE = [
${steps}
]

schedule = yani.PulseSchedule([
    yani.Pulse(rate=rate, duration=duration, source=spectrum)
    if kind == "pulse"
    else yani.Cooldown(duration=duration)
    for kind, rate, duration in SCHEDULE
])

# --- run ------------------------------------------------------------------

# transmute answers with a TransmutationResults, which holds every material it
# stepped and whose index 0 is the composition before the first step. The page
# plots the end of each step, which is what step_materials is.
results = material.transmute(schedule=schedule)
steps = results.step_materials(material.id)

SECONDS = {"s": 1.0, "min": 60.0, "h": 3600.0, "d": 86400.0, "a": 365.25 * 86400.0}
# Time after shutdown, in years, to match the page's axis: a decay curve is
# read from the end of the last pulse, and on a log axis the irradiation ahead
# of it would push every cooling point up against one value. Steps at or before
# shutdown come out at zero or negative and plotly leaves them off a log axis.
ends = []
elapsed = 0.0
for _kind, _rate, (value, unit) in SCHEDULE:
    elapsed += value * SECONDS[unit]
    ends.append(elapsed)
shutdown = max((end for (kind, _rate, _d), end in zip(SCHEDULE, ends) if kind == "pulse"), default=0.0)
times = [(end - shutdown) / SECONDS["a"] for end in ends]

activity = [m.activity(by_nuclide=True) for m in steps]
heat = [m.decay_heat(by_nuclide=True) for m in steps]
# Left at its defaults deliberately: absorbed dose in air with a build-up factor
# of 2.0 is exactly what the page reports, so these numbers and the browser's
# are the same numbers. Pass dose_quantity="effective" for Sv/h instead.
dose = [m.contact_dose(by_nuclide=True) for m in steps]

print(f"{len(steps)} steps, {sum(activity[0].values()):.3e} Bq at the end of the first")

# --- plots ----------------------------------------------------------------
#
# The same ones the page draws, plus the spectrum that produced them.


def top_nuclides(per_step, count=6):
    """The nuclides worth naming: those that lead at some step, in the order
    they first lead, then the largest peaks to fill the count.

    A full closure is hundreds of nuclides and almost all of them are noise at
    every step. Ranking by peak alone keeps the first hour's nuclides and hides
    the ones that carry the years; leading at a step is what the plot is read
    for, so leading is what earns a name. This is the page's rule.
    """
    peaks = {}
    first_lead = {}
    steps_led = {}
    for i, step in enumerate(per_step):
        for name, value in step.items():
            peaks[name] = max(peaks.get(name, 0.0), value)
        leader = max(step, key=step.get, default=None)
        if leader is not None and step[leader] > 0:
            first_lead.setdefault(leader, i)
            steps_led[leader] = steps_led.get(leader, 0) + 1
    ranked = sorted(peaks, key=lambda n: (-steps_led.get(n, 0), first_lead.get(n, len(per_step)), -peaks[n]))
    return sorted(ranked[:count], key=lambda n: (first_lead.get(n, len(per_step)), -peaks[n]))


def series_figure(per_step, title, y_label):
    figure = go.Figure()
    for name in top_nuclides(per_step):
        figure.add_scatter(
            x=times,
            y=[step.get(name, 0.0) or None for step in per_step],
            mode="lines+markers",
            name=name,
        )
    figure.update_layout(title=title, xaxis_title="time after shutdown [years]", yaxis_title=y_label)
    # Log on both: activity spans decades over a cooling curve, and time is
    # sampled log-spaced for the same reason.
    figure.update_xaxes(type="log")
    figure.update_yaxes(type="log")
    return figure


final = steps[-1]

inventory = sorted(dict(final.nuclides).items(), key=lambda kv: kv[1])[-15:]
inventory_figure = go.Figure(
    go.Bar(x=[v for _, v in inventory], y=[k for k, _ in inventory], orientation="h")
)
inventory_figure.update_layout(
    title="Inventory at the final step", xaxis_title="atom density [atom/barn-cm]"
)
inventory_figure.update_xaxes(type="log")

# Decay photon lines are discrete, so they want stems rather than a join
# between neighbours -- a line through them would draw continuum that is not
# there.
line_energies, line_rates = final.decay_photon_spectrum()
photon_figure = go.Figure()
for energy, rate in zip(line_energies, line_rates):
    photon_figure.add_scatter(
        x=[energy / 1e6, energy / 1e6],
        y=[0.0, rate],
        mode="lines",
        line={"color": "#2a78d6"},
        showlegend=False,
    )
photon_figure.update_layout(
    title="Decay photon lines, final step",
    xaxis_title="photon energy [MeV]",
    yaxis_title="emission rate [photons/s]",
)
photon_figure.update_xaxes(type="log")

figures = {
    "activity": series_figure(activity, "Activity", "activity [Bq]"),
    "decay_heat": series_figure(heat, "Decay heat", "decay heat [W]"),
    "contact_dose": series_figure(
        dose, "Contact dose rate, at the surface", "absorbed dose in air [Gy/h]"
    ),
    "inventory": inventory_figure,
    "photons": photon_figure,
}
${output}`;
}
