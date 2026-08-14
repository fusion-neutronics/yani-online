// The four charts, drawn with plotly-basic.
//
// Palette and mark specs follow the data-viz method. The categorical hues were
// run through its validator rather than chosen by eye:
//
//   light  #2a78d6 #eb6834 #1baf7a #eda100  -> ALL CHECKS PASS
//   dark   #3987e5 #d95926 #199e70 #c98500  -> ALL CHECKS PASS
//
// Four entity slots, in fixed order, never cycled. A fifth nuclide does not get
// a generated hue -- it folds into "Other", which is deliberately grey because
// it is an aggregate rather than an identity, and so is not a categorical slot
// at all.
//
// Light-mode aqua and yellow sit below 3:1 on the light surface, which the
// validator flags as needing relief. That is why every series is direct-labeled
// at its last point in addition to the legend: identity never rests on colour
// alone, and the low-contrast pair always carries a visible label.

const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500"],
};
const OTHER = { light: "#8a8a85", dark: "#7d7d76" };
const INK = {
  light: { primary: "#0b0b0b", secondary: "#52514e", grid: "#e6e6e2", surface: "#fcfcfb" },
  dark: { primary: "#ffffff", secondary: "#c3c2b7", grid: "#2e2e2c", surface: "#1a1a19" },
};

/// Four entities plus "Other" is the ceiling, not a default to tune. Past four
/// the validator cannot clear its floors, and a fifth hue would be invented
/// rather than assigned.
const TOP_N = 4;

const mode = () =>
  document.documentElement.dataset.theme === "dark" ||
  (!document.documentElement.dataset.theme &&
    matchMedia("(prefers-color-scheme: dark)").matches)
    ? "dark"
    : "light";

const SECOND = 1;
const DAY = 86400;
const YEAR = 365.25 * DAY;

/// Cooling times read in whatever unit keeps the numbers legible.
function timeAxis(times) {
  const max = Math.max(...times);
  if (max >= 2 * YEAR) return { scale: 1 / YEAR, label: "time [years]" };
  if (max >= 2 * DAY) return { scale: 1 / DAY, label: "time [days]" };
  if (max >= 2 * 3600) return { scale: 1 / 3600, label: "time [hours]" };
  return { scale: SECOND, label: "time [s]" };
}

/// The layout every chart shares: recessive axes, no chart junk, hover on.
function baseLayout(title, xLabel, yLabel, extra = {}) {
  const m = mode();
  const ink = INK[m];
  return {
    title: { text: title, font: { size: 14, color: ink.primary }, x: 0, xanchor: "left" },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: ink.secondary, size: 12 },
    margin: { l: 64, r: 96, t: 40, b: 48 },
    xaxis: {
      title: { text: xLabel, font: { size: 11 } },
      gridcolor: ink.grid,
      zeroline: false,
      linecolor: ink.grid,
      ticks: "outside",
      tickcolor: ink.grid,
      ...extra.xaxis,
    },
    yaxis: {
      title: { text: yLabel, font: { size: 11 } },
      gridcolor: ink.grid,
      zeroline: false,
      linecolor: ink.grid,
      ticks: "outside",
      tickcolor: ink.grid,
      ...extra.yaxis,
    },
    // Crosshair + shared tooltip: an HTML chart is interactive by default, and
    // on log-log decay curves the reading someone wants is "what is everything
    // at this time", not one point.
    hovermode: "x unified",
    hoverlabel: { bgcolor: ink.surface, bordercolor: ink.grid, font: { color: ink.primary } },
    showlegend: true,
    legend: {
      orientation: "h",
      y: -0.18,
      x: 0,
      font: { size: 11, color: ink.secondary },
      bgcolor: "rgba(0,0,0,0)",
    },
    ...extra.layout,
  };
}

const CONFIG = { displayModeBar: false, responsive: true };

/// Split a per-step list of {nuclide: value} into the largest few by peak, with
/// everything else summed into "Other".
///
/// Ranked on peak rather than final value because which nuclide dominates
/// changes completely with cooling time -- ranking on the last step would drop
/// whatever mattered for the first hundred days.
function topSeries(perStep) {
  const keys = new Set();
  for (const step of perStep) for (const k of Object.keys(step)) keys.add(k);
  const peak = new Map();
  for (const k of keys) {
    peak.set(k, Math.max(...perStep.map((s) => s[k] || 0)));
  }
  const ranked = [...peak.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, TOP_N).map(([k]) => k);
  const series = top.map((name) => ({
    name,
    values: perStep.map((s) => s[name] || 0),
  }));
  const rest = perStep.map((s) =>
    Object.entries(s).reduce((acc, [k, v]) => (top.includes(k) ? acc : acc + v), 0));
  if (rest.some((v) => v > 0)) series.push({ name: "Other", values: rest, other: true });
  return { series, peak: ranked.length ? ranked[0][1] : 0 };
}

/// A decayed-away nuclide is numerical dust; letting it set the scale squashes
/// everything that matters. Six decades below the largest value is the floor.
const DECADES = 6;

function decaySeriesChart(el, results, key, title, yLabel) {
  const m = mode();
  const times = results.map((r) => r.time);
  const { scale, label } = timeAxis(times);
  const x = times.map((t) => t * scale);
  const { series, peak } = topSeries(results.map((r) => r[key]));
  if (peak <= 0) {
    Plotly.purge(el);
    return;
  }
  const floor = peak / 10 ** DECADES;

  const traces = series.map((s, i) => ({
    type: "scatter",
    mode: "lines+markers",
    name: s.name,
    x,
    y: s.values.map((v) => (v > floor ? v : null)),
    line: { width: 2, color: s.other ? OTHER[m] : SERIES[m][i] },
    marker: { size: 8, color: s.other ? OTHER[m] : SERIES[m][i] },
    connectgaps: false,
    hovertemplate: "%{y:.3e}<extra>" + s.name + "</extra>",
  }));

  // Direct labels at the last point, in ink rather than the series colour --
  // the marker beside the text carries identity. This is also the relief the
  // validator requires for the two light-mode hues under 3:1.
  const annotations = series.map((s, i) => {
    const last = s.values.map((v, j) => [v, j]).filter(([v]) => v > floor).pop();
    if (!last) return null;
    return {
      // Both coordinates are log10 here, not just y. Annotations on a log axis
      // are positioned in log space, so a linear x puts the label thousands of
      // decades off-plot -- invisible, and silently so.
      x: Math.log10(x[last[1]]),
      y: Math.log10(last[0]),
      text: s.name,
      showarrow: false,
      xanchor: "left",
      xshift: 8,
      font: { size: 11, color: INK[m].secondary },
    };
  }).filter(Boolean);

  Plotly.react(el, traces, baseLayout(title, label, yLabel, {
    xaxis: { type: "log" },
    yaxis: { type: "log", range: [Math.log10(floor), Math.log10(peak * 4)] },
    layout: { annotations },
  }), CONFIG);
}

/// The inventory at the final step, as a magnitude comparison.
///
/// A bar chart, not a line: this answers "how much of what is left", which is
/// one instant and a ranking, not a trend. One hue, because the bars are one
/// measure -- colouring each nuclide differently would encode identity twice
/// and imply a categorical relationship the ranking already carries.
function inventoryChart(el, results) {
  const m = mode();
  const final = results[results.length - 1].atoms_per_barn_cm || {};
  const ranked = Object.entries(final)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .reverse();
  if (!ranked.length) {
    Plotly.purge(el);
    return;
  }
  Plotly.react(el, [{
    type: "bar",
    orientation: "h",
    x: ranked.map(([, v]) => v),
    y: ranked.map(([k]) => k),
    marker: { color: SERIES[m][0] },
    hovertemplate: "%{y}: %{x:.3e} atom/barn-cm<extra></extra>",
  }], baseLayout(
    "Inventory at the final step",
    "atom density [atom/barn-cm]",
    "",
    {
      xaxis: { type: "log" },
      yaxis: { automargin: true, gridcolor: "rgba(0,0,0,0)" },
      layout: { showlegend: false, margin: { l: 80, r: 24, t: 40, b: 48 } },
    },
  ), CONFIG);
}

/// The decay photon spectrum is a set of discrete lines, not a curve, so it
/// wants stems rather than a join between neighbours -- a line through them
/// would draw continuum that is not there.
///
/// One series, so no legend: the title names it.
export function drawPhotons(results, stepIndex) {
  const el = document.getElementById("plot-photons");
  const m = mode();
  const step = results[stepIndex];
  const energies = step.photon_energy || [];
  const intensities = step.photon_intensity || [];
  if (!energies.length) {
    Plotly.purge(el);
    return;
  }
  const peak = Math.max(...intensities);
  // Five decades down from the strongest; below that a line is not physics.
  const floor = peak / 1e5;

  const x = [];
  const y = [];
  for (let i = 0; i < energies.length; i++) {
    if (intensities[i] < floor) continue;
    // MeV reads better than eV across a gamma spectrum.
    const e = energies[i] / 1e6;
    x.push(e, e, null);
    y.push(floor, intensities[i], null);
  }

  Plotly.react(el, [{
    type: "scatter",
    mode: "lines",
    x,
    y,
    line: { width: 2, color: SERIES[m][0] },
    hoverinfo: "skip",
  }, {
    // A separate point trace so hover has something bigger than a 2px stem to
    // catch, and so each line can report its own energy.
    type: "scatter",
    mode: "markers",
    x: x.filter((_, i) => i % 3 === 1),
    y: y.filter((_, i) => i % 3 === 1),
    marker: { size: 8, color: SERIES[m][0] },
    hovertemplate: "%{x:.4f} MeV<br>%{y:.3e} photon/s<extra></extra>",
  }], baseLayout(
    `Decay photon lines, step ${stepIndex + 1}`,
    "photon energy [MeV]",
    "emission rate [photon/s]",
    {
      yaxis: { type: "log", range: [Math.log10(floor), Math.log10(peak * 8)] },
      layout: { showlegend: false, hovermode: "closest" },
    },
  ), CONFIG);
}

export function drawAll(results) {
  decaySeriesChart(
    document.getElementById("plot-activity"),
    results, "activity_by_nuclide",
    "Activity", "activity [Bq]",
  );
  decaySeriesChart(
    document.getElementById("plot-heat"),
    results, "decay_heat_by_nuclide",
    "Decay heat", "decay heat [W]",
  );
  inventoryChart(document.getElementById("plot-inventory"), results);
}

// Re-draw on a theme change: the dark steps are a selected palette validated
// against the dark surface, not an automatic flip of the light one, so the
// charts have to be rebuilt rather than filtered.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  window.dispatchEvent(new CustomEvent("yani:redraw"));
});
