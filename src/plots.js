// The charts, drawn with plotly-basic.
//
// Palette and mark specs follow the data-viz method. The categorical hues are
// its reference palette, eight slots stepped for each surface, run through its
// validator rather than chosen by eye:
//
//   light  #2a78d6 #eb6834 #1baf7a #eda100 #e87ba4 #008300 #4a3aa7 #e34948  -> ALL CHECKS PASS
//   dark   #3987e5 #d95926 #199e70 #c98500 #d55181 #008300 #9085e9 #e66767  -> ALL CHECKS PASS
//
// Eight entity slots, in fixed order, never cycled. A ninth nuclide does not
// get a generated hue -- it folds into "Other", which is deliberately grey
// because it is an aggregate rather than an identity, and so is not a
// categorical slot at all. A total, when one is drawn, is ink rather than a hue
// for the same reason, and dashed so it cannot be taken for "Other" in print.
//
// Light-mode aqua, yellow and magenta sit below 3:1 on the light surface, which
// the validator flags as needing relief. That is why every series is
// direct-labeled at its last point in addition to the legend: identity never
// rests on colour alone, and the low-contrast hues always carry a visible
// label.

const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};
const OTHER = { light: "#8a8a85", dark: "#7d7d76" };
const INK = {
  light: { primary: "#0b0b0b", secondary: "#52514e", grid: "#e6e6e2", surface: "#fcfcfb" },
  dark: { primary: "#ffffff", secondary: "#c3c2b7", grid: "#2e2e2c", surface: "#1a1a19" },
};

/// How many nuclides a chart names, at most. Eight is the palette's ceiling,
/// not a default to tune: past it the validator cannot clear its floors, and a
/// ninth hue would be invented rather than assigned. Four is where a chart
/// opens, which is about as many lines as read at a glance; the control above
/// each chart goes from one to eight.
const NAMED_MAX = 8;
const NAMED_DEFAULT = 4;

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
  if (max >= 2 * YEAR) return { scale: 1 / YEAR, unit: "years" };
  if (max >= 2 * DAY) return { scale: 1 / DAY, unit: "days" };
  if (max >= 2 * 3600) return { scale: 1 / 3600, unit: "hours" };
  return { scale: SECOND, unit: "s" };
}

/// The marks a log time axis carries: the units a reader thinks in, rather
/// than powers of ten of whichever unit the axis happens to be scaled in. A
/// cooling curve from a second to ten years spans eight and a half decades,
/// and "10^-7 years" is a number nobody has a feel for where "1 min" is.
const TIME_MARKS = [
  [SECOND, "1 s"], [60, "1 min"], [3600, "1 h"], [DAY, "1 d"], [30 * DAY, "30 d"],
  [YEAR, "1 a"], [10 * YEAR, "10 a"], [100 * YEAR, "100 a"], [1000 * YEAR, "1000 a"],
];

/// When the results stop being irradiated: the cumulative time at the end of
/// the last step that had a flux, or zero for a schedule that never did.
///
/// The charts plot time *after* this rather than time from the start, because
/// a decay curve is read from shutdown. On a log axis, cumulative time puts a
/// year of irradiation ahead of every cooling point, so ten cooling steps from
/// a second to ten years land between 1.00000003 and 11 years and bunch into a
/// vertical stack at "1"; measured from shutdown they spread evenly across the
/// axis, which is what log-spaced steps are for. Steps at or before shutdown
/// (the pulses, and any cooling between two of them) come out at zero or
/// negative and are drawn on a linear axis only, where the irradiation history
/// belongs.
function shutdownTime(results) {
  return results.reduce((t, r) => (r.irradiated ? Math.max(t, r.time) : t), 0);
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
      exponentformat: "power",
      // A schedule spanning under a decade gets Plotly's minor ticks, which
      // label 9,1,2,...,10 -- the leading 9 belonging to the decade below and
      // reading as an error. Majors only.
      minor: { ticks: "" },
      ...extra.xaxis,
    },
    yaxis: {
      title: { text: yLabel, font: { size: 11 } },
      gridcolor: ink.grid,
      zeroline: false,
      linecolor: ink.grid,
      ticks: "outside",
      tickcolor: ink.grid,
      // Powers of ten, not SI suffixes. Plotly's default renders 1e14 Bq as
      // "100T", which is the wrong register for this and ambiguous besides --
      // "B" reads as either billion or becquerel.
      exponentformat: "power",
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

// --- axis scales ----------------------------------------------------------

/// Which axes a scale toggle means anything for, per chart.
///
/// The inventory's y is nuclide names, so it gets an x control only: offering
/// "log" for a categorical axis is a control that does nothing, which is worse
/// than no control.
const AXES = {
  "plot-material": ["x"],
  "plot-spectrum": ["x", "y"],
  "plot-activity": ["x", "y"],
  "plot-heat": ["x", "y"],
  "plot-dose": ["x", "y"],
  "plot-inventory": ["x"],
  "plot-photons": ["x", "y"],
};

/// What each series chart draws, the total, the nuclides that lead, or both,
/// and how it opens.
///
/// Every chart opens with both drawn. The total is the first question each
/// answers -- how much, and for a dose whether the thing can be handled and
/// after how long -- and the nuclides are the second, what is driving it and
/// when; a reader wants both at a glance, and either box takes one away. The
/// total is ink and dashed, so the two readings do not compete for a hue.
/// Every chart has both boxes, and the count of nuclides it names, above it
/// beside the scale toggles.
const VIEWS = {
  "plot-activity": { total: true, byNuclide: true },
  "plot-heat": { total: true, byNuclide: true },
  "plot-dose": { total: true, byNuclide: true },
};

const views = new Map();
const viewOf = (id) => ({ ...VIEWS[id], ...(views.get(id) || {}) });
const named = new Map();
const namedOf = (id) => named.get(id) || NAMED_DEFAULT;

/// Log everywhere by default, which is what these quantities are read on:
/// activity over a decade of cooling, a spectrum across ten decades of energy.
/// The toggle exists because a reader comparing two nearby values, or checking
/// whether something really is flat, wants linear for that one look.
const scales = new Map();
const scaleOf = (id, axis) => scales.get(`${id}.${axis}`) || "log";

/// Plotly positions annotations in the axis's own coordinates, which on a log
/// axis means log10 of the value. Mixing the two puts a label thousands of
/// decades off-plot -- invisible, and silently so.
const at = (type, v) => (type === "log" ? Math.log10(v) : v);

/// The visible range, in the axis's own coordinates. A log axis is floored a
/// fixed number of decades below the peak; a linear one starts at zero, where
/// the decades below are a sliver above the axis line and need no floor.
const span = (type, floor, peak, headroom) =>
  type === "log" ? [Math.log10(floor), Math.log10(peak * headroom)] : [0, peak * 1.05];

/// Put the per-chart controls above each chart and call `onChange(id)` when one
/// moves: a scale toggle per applicable axis, and a breakdown checkbox on the
/// charts that have both readings.
///
/// Built here rather than written into index.html because this file already
/// owns which charts exist and which controls apply to them.
export function wireAxisScales(onChange) {
  for (const [id, axes] of Object.entries(AXES)) {
    const plot = document.getElementById(id);
    if (!plot) continue;
    const bar = document.createElement("div");
    bar.className = "axis-scale";
    for (const axis of axes) {
      const label = document.createElement("label");
      const name = document.createElement("span");
      name.textContent = axis;
      const select = document.createElement("select");
      for (const type of ["log", "linear"]) {
        const option = document.createElement("option");
        option.value = option.textContent = type;
        option.selected = type === scaleOf(id, axis);
        select.append(option);
      }
      select.addEventListener("change", () => {
        scales.set(`${id}.${axis}`, select.value);
        onChange(id);
      });
      label.append(name, select);
      bar.append(label);
    }
    if (id in VIEWS) {
      const count = document.createElement("label");
      const countName = document.createElement("span");
      countName.textContent = "nuclides";
      const select = document.createElement("select");
      select.dataset.control = "named";
      for (let n = 1; n <= NAMED_MAX; n++) {
        const option = document.createElement("option");
        option.value = option.textContent = String(n);
        option.selected = n === namedOf(id);
        select.append(option);
      }
      select.addEventListener("change", () => {
        named.set(id, Number(select.value));
        onChange(id);
      });
      count.append(countName, select);
      bar.append(count);
      for (const [key, text] of [["total", "total"], ["byNuclide", "by nuclide"]]) {
        const label = document.createElement("label");
        const check = document.createElement("input");
        check.type = "checkbox";
        check.dataset.control = key;
        check.checked = viewOf(id)[key];
        const name = document.createElement("span");
        name.textContent = text;
        check.addEventListener("change", () => {
          views.set(id, { ...viewOf(id), [key]: check.checked });
          onChange(id);
        });
        label.append(name, check);
        bar.append(label);
      }
    }
    bar.dataset.for = id;
    (plot.closest(".plot-wrap") || plot).before(bar);
  }
}


/// The nuclides worth naming, and the rest as "Other".
///
/// Named by who *leads*: every nuclide that is the largest at some step is
/// named, in the order they first lead, and if that leaves room the slots are
/// filled by peak. Not the four largest peaks, which is what this did: a
/// cooling curve is a succession, and the peaks all belong to its first hour.
/// On aluminium the four largest peaks are Al28, Mg27, Na24 and its isomer,
/// every one gone within a week, and from then on the whole inventory was the
/// grey "Other" line: the plot exists to say which nuclide dominates at which
/// decade, and it hid exactly that. Leading is the question the plot answers,
/// so leading is what earns a name.
///
/// When more nuclides lead than there are hues, the ones that lead for more
/// of the run stay named, then the earlier ones. The steps are log-spaced, so
/// a step is roughly a decade of time, and leading for more steps is leading
/// for more of the curve. "Other" is the sum of everything unnamed, and can be
/// the largest line at a step where no one nuclide dominates; that is a true
/// reading rather than a failure of the rule.
function topSeries(perStep, count) {
  const keys = new Set();
  for (const step of perStep) for (const k of Object.keys(step)) keys.add(k);
  const peak = new Map();
  for (const k of keys) {
    peak.set(k, Math.max(...perStep.map((s) => s[k] || 0)));
  }

  // Who leads at each step, with the first step they lead at and how many.
  const leads = new Map();
  perStep.forEach((step, i) => {
    let best = null;
    for (const [k, v] of Object.entries(step)) {
      if (v > 0 && (best === null || v > step[best])) best = k;
    }
    if (best === null) return;
    const lead = leads.get(best) || { first: i, steps: 0 };
    lead.steps++;
    leads.set(best, lead);
  });

  const ranked = [...keys].sort((a, b) => {
    const la = leads.get(a);
    const lb = leads.get(b);
    if (la && lb) return lb.steps - la.steps || la.first - lb.first || peak.get(b) - peak.get(a);
    if (la || lb) return la ? -1 : 1;
    return peak.get(b) - peak.get(a);
  });
  // Drawn in the order they first lead, so the legend reads as the run does,
  // with the fill-ins after by peak.
  const top = ranked.slice(0, count).sort((a, b) => {
    const fa = leads.get(a) ? leads.get(a).first : Infinity;
    const fb = leads.get(b) ? leads.get(b).first : Infinity;
    return fa - fb || peak.get(b) - peak.get(a);
  });

  const series = top.map((name) => ({
    name,
    values: perStep.map((s) => s[name] || 0),
  }));
  const rest = perStep.map((s) =>
    Object.entries(s).reduce((acc, [k, v]) => (top.includes(k) ? acc : acc + v), 0));
  if (rest.some((v) => v > 0)) series.push({ name: "Other", values: rest, other: true });
  return { series, peak: Math.max(0, ...peak.values()) };
}

/// A decayed-away nuclide is numerical dust; letting it set the scale squashes
/// everything that matters. Six decades below the largest value is the floor.
const DECADES = 6;

/// `total` names the per-step scalar the chart's total line is drawn from.
/// What is drawn is the chart's view: the nuclides that lead, the total, or
/// both, and how many nuclides are named, from the controls above it.
function decaySeriesChart(el, results, key, title, yLabel, total) {
  const m = mode();
  const xType = scaleOf(el.id, "x");
  const yType = scaleOf(el.id, "y");
  const view = viewOf(el.id);
  const shutdown = shutdownTime(results);
  const times = results.map((r) => r.time - shutdown);
  const { scale, unit } = timeAxis(times);
  const x = times.map((t) => t * scale);
  // The marks that fall inside the drawn span, in the axis's own unit. Only on
  // a log axis: a linear one is read off its numeric ticks in that unit.
  const after = times.filter((t) => t > 0);
  const marks = xType === "log" && after.length
    ? TIME_MARKS.filter(([t]) => t >= Math.min(...after) / 1.5 && t <= Math.max(...after) * 1.5)
    : [];
  const label = xType === "log" && marks.length ? "time after shutdown" : `time after shutdown [${unit}]`;
  const series = [];
  if (view.byNuclide) {
    series.push(...topSeries(results.map((r) => r[key] || {}), namedOf(el.id)).series);
  }
  if (view.total) {
    series.push({ name: total.name, values: results.map((r) => r[total.key] || 0), total: true });
  }
  const peak = Math.max(0, ...series.flatMap((s) => s.values));
  if (peak <= 0) {
    // Nothing to draw: no view chosen, or nothing in the results. An empty
    // frame rather than the previous view left standing under the new
    // controls.
    Plotly.purge(el);
    return;
  }
  const floor = peak / 10 ** DECADES;

  // Hues go to entities, in slot order; the aggregates take ink. Counted
  // rather than indexed, so "Other" and the total between or before named
  // nuclides do not shift the slots.
  let slot = 0;
  const colourOf = (s) => (s.other ? OTHER[m] : s.total ? INK[m].primary : SERIES[m][slot++]);
  const traces = series.map((s) => {
    const colour = colourOf(s);
    return {
      type: "scatter",
      mode: "lines+markers",
      name: s.name,
      x,
      // The floor is a log-axis concern: it stops decayed-away dust from
      // setting the scale. On linear the dust sits on the axis line and costs
      // nothing, so the series is drawn whole rather than cut off.
      y: s.values.map((v) => (yType === "log" && v <= floor ? null : v)),
      line: { width: 2, color: colour, ...(s.total ? { dash: "dash" } : {}) },
      marker: { size: 8, color: colour },
      connectgaps: false,
      hovertemplate: "%{y:.3e}<extra>" + s.name + "</extra>",
    };
  });

  // Direct labels at the last point, in ink rather than the series colour --
  // the marker beside the text carries identity. This is also the relief the
  // validator requires for the two light-mode hues under 3:1.
  const annotations = series.map((s, i) => {
    const last = s.values.map((v, j) => [v, j]).filter(([v]) => v > floor).pop();
    if (!last) return null;
    return {
      // In each axis's own coordinates, which is log10 of the value on a log
      // axis and the value itself on a linear one. Mixing them puts the label
      // thousands of decades off-plot -- invisible, and silently so.
      x: at(xType, x[last[1]]),
      y: at(yType, last[0]),
      text: s.name,
      showarrow: false,
      xanchor: "left",
      xshift: 8,
      yshift: 0,
      font: { size: 11, color: INK[m].secondary },
    };
  }).filter(Boolean);

  // Short-lived nuclides all fall through the floor at the same step, so their
  // labels land on the same x and overlap into an unreadable stack -- and a
  // label that cannot be read is not the relief the low-contrast hues are
  // relying on. Separate them vertically, in pixels, since the gap that matters
  // is a line of text rather than a distance in decades.
  //
  // Pushed apart within a column rather than nudged globally: a label must stay
  // next to the line it names, or the direct labelling stops meaning anything.
  const LINE = 14;
  const columns = new Map();
  for (const a of annotations) {
    const column = columns.get(a.x) || [];
    column.push(a);
    columns.set(a.x, column);
  }
  for (const column of columns.values()) {
    if (column.length < 2) continue;
    // Highest value first, then step down, so the order on screen matches the
    // order of the lines arriving at that point.
    column.sort((p, q) => q.y - p.y);
    column.forEach((a, k) => {
      a.yshift = ((column.length - 1) / 2 - k) * LINE;
    });
  }

  Plotly.react(el, traces, baseLayout(title, label, yLabel, {
    xaxis: {
      type: xType,
      ...(marks.length
        ? { tickvals: marks.map(([t]) => t * scale), ticktext: marks.map(([, text]) => text) }
        : {}),
    },
    yaxis: { type: yType, range: span(yType, floor, peak, 4) },
    layout: { annotations },
  }), CONFIG);
}

/// How many nuclides the inventory names. Fifteen bars is what the chart's
/// height reads comfortably; the rest of a closure is trace.
const INVENTORY_SHOWN = 15;

/// The x range showing the inventory at every step, in the axis's own
/// coordinates: from the smallest density any step's fifteen reach down to,
/// to the largest any step has, with a tenth of the extent to spare each side.
/// `null` when no step has a nuclide.
///
/// Fixed across the steps for the same reason the photon axes are: the slider
/// walks the steps, and an axis that followed each step's own fifteen would
/// slide under the reader as the trace products decay away and the floor of
/// the chart moved with them. Held still, a bar's length means the same thing
/// at every step, which is what makes two steps comparable at a glance.
function inventoryRange(results, xType) {
  let lo = Infinity;
  let hi = 0;
  for (const step of results) {
    const shown = Object.values(step.atoms_per_barn_cm || {})
      .filter((v) => v > 0)
      .sort((a, b) => b - a)
      .slice(0, INVENTORY_SHOWN);
    if (!shown.length) continue;
    hi = Math.max(hi, shown[0]);
    lo = Math.min(lo, shown[shown.length - 1]);
  }
  if (!(hi > 0)) return null;
  const a = at(xType, lo);
  const b = at(xType, hi);
  const pad = (b - a) / 10 || 0.5;
  return [xType === "log" ? a - pad : Math.max(0, a - pad), b + pad];
}

/// The inventory at one step, as a magnitude comparison.
///
/// A bar chart, not a line: this answers "how much of what is left", which is
/// one instant and a ranking, not a trend. One hue, because the bars are one
/// measure -- colouring each nuclide differently would encode identity twice
/// and imply a categorical relationship the ranking already carries. The step
/// is the slider's, as for the photon lines, and the x axis is the whole run's,
/// see `inventoryRange`; `uirevision` keeps a zoom across the slider.
export function drawInventory(results, stepIndex) {
  const el = document.getElementById("plot-inventory");
  const m = mode();
  const xType = scaleOf(el.id, "x");
  const xRange = inventoryRange(results, xType);
  const step = results[stepIndex] || {};
  const ranked = Object.entries(step.atoms_per_barn_cm || {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, INVENTORY_SHOWN)
    .reverse();
  if (xRange === null) {
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
    `Inventory at step ${stepIndex + 1}`,
    "atom density [atom/barn-cm]",
    "",
    {
      xaxis: { type: xType, range: xRange, uirevision: photonRevision(results, xType) },
      yaxis: { automargin: true, gridcolor: "rgba(0,0,0,0)" },
      layout: { showlegend: false, margin: { l: 80, r: 24, t: 40, b: 48 } },
    },
  ), CONFIG);
}

/// A token that changes when the photon plot's x axis should be drawn afresh.
///
/// Plotly keeps a reader's zoom across `Plotly.react` calls whose `uirevision`
/// has not changed, so the slider through the steps redraws the lines and
/// leaves the axis where the reader put it. A new set of results is a new plot,
/// and a scale toggle is a new axis, since a log range is in decades and a
/// linear one in MeV; either changes the token, and the axis is drawn again at
/// its full extent.
const photonRevisions = new WeakMap();
let nextPhotonRevision = 1;
function photonRevision(results, xType) {
  if (!photonRevisions.has(results)) photonRevisions.set(results, nextPhotonRevision++);
  return `${photonRevisions.get(results)}:${xType}`;
}

/// The x range showing every photon line of every step, in the axis's own
/// coordinates (MeV on a linear axis, decades on a log one), with a twentieth
/// of the extent to spare each side so an outermost line is not on the frame.
/// `null` when no step has a line.
///
/// Every step rather than the one drawn, because the slider walks the steps and
/// an axis that followed each step's own lines would jump under the reader: the
/// lines of the first step after an irradiation are gone by the last, and a
/// plot autoranged per step zooms in on the remnant as they scroll. Set once
/// from the whole run, the axis says where the spectrum lives and holds still.
function photonEnergyRange(results, xType) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const step of results) {
    for (const e of step.photon_energy || []) {
      // A line at no energy is not a line, and has no logarithm.
      if (!(e > 0)) continue;
      if (e < lo) lo = e;
      if (e > hi) hi = e;
    }
  }
  if (!(lo <= hi)) return null;
  const a = at(xType, lo / 1e6);
  const b = at(xType, hi / 1e6);
  // A single line has no extent to pad by: half a decade, or half its energy.
  const pad = a === b ? (xType === "log" ? 0.5 : a / 2) : (b - a) / 20;
  return [xType === "log" ? a - pad : Math.max(0, a - pad), b + pad];
}

/// The y range showing every photon line of every step that would be drawn,
/// in the axis's own coordinates. `null` when no step has a line.
///
/// Each step draws the lines within five decades of its own strongest, so the
/// envelope runs from the lowest of those floors to the highest peak: the
/// intensities fall by decades over a cooling schedule, and an axis fixed at
/// the first step's five decades would leave the late steps empty, while one
/// that followed each step would rescale under the reader with every move of
/// the slider. Fixed once from the run, it holds still, and a late step reads
/// low on it, which is what a late step is.
function photonIntensityRange(results, yType) {
  let lo = Infinity;
  let hi = 0;
  for (const step of results) {
    const intensities = step.photon_intensity || [];
    if (!intensities.length) continue;
    const peak = Math.max(...intensities);
    if (!(peak > 0)) continue;
    hi = Math.max(hi, peak);
    lo = Math.min(lo, peak / 1e5);
  }
  return hi > 0 ? span(yType, lo, hi, 8) : null;
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
  const xType = scaleOf(el.id, "x");
  const yType = scaleOf(el.id, "y");
  const xRange = photonEnergyRange(results, xType);
  const yRange = photonIntensityRange(results, yType);
  if (xRange === null || yRange === null) {
    // No step has a line, so there is nothing to draw and no axis to hold.
    Plotly.purge(el);
    return;
  }
  // A step with no lines keeps its axes rather than being purged: the reader
  // scrolling through it should see an empty frame where the spectrum lives,
  // not a plot that vanishes and comes back somewhere else.
  const peak = energies.length ? Math.max(...intensities) : 1;
  // Five decades down from this step's strongest; below that a line is not
  // physics. The step's own floor decides what is drawn; the axis is the run's.
  const floor = peak / 1e5;
  // Where a stem starts. The bottom of the visible range, which is the run's
  // floor on a log axis and zero on a linear one -- starting at the floor on
  // linear would hang every line above the axis.
  const base = yType === "log" ? 10 ** yRange[0] : 0;

  const x = [];
  const y = [];
  for (let i = 0; i < energies.length; i++) {
    if (yType === "log" && intensities[i] < floor) continue;
    // MeV reads better than eV across a gamma spectrum.
    const e = energies[i] / 1e6;
    x.push(e, e, null);
    y.push(base, intensities[i], null);
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
      // Log energy by default. A gamma spectrum is dense below 100 keV and
      // sparse above 1 MeV, so linear stacks most of the lines on top of each
      // other at the origin -- which is occasionally the view someone wants of
      // the high-energy end, hence the toggle.
      //
      // Both ranges are the whole run's, not this step's, and `uirevision`
      // keeps a zoom across the slider on each: see `photonEnergyRange`,
      // `photonIntensityRange` and `photonRevision`. The reader moving through
      // the steps sees the lines fall and shift on a frame that holds still,
      // rather than a frame that rescales itself to make every step look the
      // same.
      xaxis: { type: xType, range: xRange, uirevision: photonRevision(results, xType) },
      yaxis: { type: yType, range: yRange, uirevision: photonRevision(results, yType) },
      layout: { showlegend: false, hovermode: "closest" },
    },
  ), CONFIG);
}

/// The neutron spectrum, drawn from the boundaries and per-group values that
/// would be handed to the solver.
///
/// Per unit lethargy, not per group. The groups here span decades of unequal
/// width -- a preset's first group runs from 1e-5 eV to 100 eV, its last from
/// 12 to 15 MeV -- so raw per-group values on a log axis say more about the
/// binning than about the physics, and two group structures describing the same
/// spectrum would draw as different shapes. Dividing by ln(E_hi/E_lo) is what
/// makes the area under the curve proportional to flux, which is the reading
/// anyone comparing a thermal peak against a 14 MeV one is after.
///
/// Drawn before any run, and redrawn on every edit: the spectrum is an input,
/// and this is the only one whose consequences are hard to read off the form.
export function drawSpectrum(boundaries, values) {
  const el = document.getElementById("plot-spectrum");
  if (!el) return;
  const m = mode();
  const xType = scaleOf(el.id, "x");
  const yType = scaleOf(el.id, "y");

  // A step per group, at the height its lethargy width gives it.
  const x = [];
  const y = [];
  let peak = 0;
  for (let i = 0; i < values.length; i++) {
    const lo = boundaries[i];
    const hi = boundaries[i + 1];
    const lethargy = Math.log(hi / lo);
    const height = lethargy > 0 ? values[i] / lethargy : 0;
    peak = Math.max(peak, height);
    x.push(lo, hi);
    y.push(height, height);
  }
  if (!(peak > 0)) {
    Plotly.purge(el);
    return;
  }
  // Four decades below the peak. A group carrying a millionth of the flux is
  // not part of the shape being chosen, and letting it set the floor flattens
  // everything that is.
  const floor = peak / 1e4;

  Plotly.react(el, [{
    type: "scatter",
    mode: "lines",
    x,
    // Clamped to the floor only on a log axis, where a zero-flux group would
    // otherwise drop the trace to negative infinity and break the fill.
    y: yType === "log" ? y.map((v) => Math.max(v, floor)) : y,
    line: { width: 2, color: SERIES[m][0], shape: "linear" },
    fill: "tozeroy",
    fillcolor: m === "dark" ? "rgba(57,135,229,0.16)" : "rgba(42,120,214,0.12)",
    hovertemplate: "%{x:.3e} eV<br>%{y:.3e} per lethargy<extra></extra>",
  }], baseLayout(
    "Neutron spectrum",
    "energy [eV]",
    "flux per unit lethargy [normalised]",
    {
      xaxis: { type: xType },
      yaxis: { type: yType, range: span(yType, floor, peak, 2) },
      layout: { showlegend: false, hovermode: "closest" },
    },
  ), CONFIG);
}

/// The material as the solver built it: one bar per nuclide, by atom fraction.
///
/// A bar chart for the same reason the inventory is one: this is a ranking at
/// an instant, not a trend, and one hue because the bars are one measure. Log
/// by default, because a material's make-up spans decades, Fe56 at 92% of the
/// atoms and Fe58 at a quarter of a percent, and steel's trace elements four
/// decades below its iron; on linear the small ones vanish, which is
/// occasionally the view someone wants of the big ones, hence the toggle.
/// Every nuclide is drawn, since the point is to see what the form expanded
/// to, and the chart grows with the count rather than folding the tail into
/// "Other": a trace isotope is exactly what a reader checking an activation
/// wants to know is there.
export function drawMaterial(material) {
  const el = document.getElementById("plot-material");
  if (!el) return;
  const entries = material ? Object.entries(material.atoms_per_barn_cm).filter(([, v]) => v > 0) : [];
  if (!entries.length) {
    Plotly.purge(el);
    return;
  }
  const m = mode();
  const xType = scaleOf(el.id, "x");
  const total = entries.reduce((n, [, v]) => n + v, 0);
  const ranked = entries.sort((a, b) => a[1] - b[1]);
  // Room for the bars: a line and a bit each, within a floor a short list
  // still reads at and a ceiling past which the bars thin instead.
  el.style.height = `${Math.min(48, Math.max(14, 1.4 * ranked.length + 5))}rem`;
  Plotly.react(el, [{
    type: "bar",
    orientation: "h",
    x: ranked.map(([, v]) => 100 * v / total),
    y: ranked.map(([k]) => k),
    customdata: ranked.map(([, v]) => v),
    marker: { color: SERIES[m][0] },
    hovertemplate: "%{y}: %{x:.4g}% of atoms, %{customdata:.3e} atom/barn-cm<extra></extra>",
  }], baseLayout(
    `Material as built: ${ranked.length} nuclide${ranked.length === 1 ? "" : "s"}`,
    "atom fraction [%]",
    "",
    {
      xaxis: { type: xType },
      yaxis: { automargin: true, gridcolor: "rgba(0,0,0,0)" },
      layout: { showlegend: false, margin: { l: 80, r: 24, t: 40, b: 48 } },
    },
  ), CONFIG);
}

export function drawAll(results) {
  decaySeriesChart(
    document.getElementById("plot-activity"),
    results, "activity_by_nuclide",
    "Activity", "activity [Bq]",
    { key: "activity", name: "total" },
  );
  decaySeriesChart(
    document.getElementById("plot-heat"),
    results, "decay_heat_by_nuclide",
    "Decay heat", "decay heat [W]",
    { key: "decay_heat", name: "total" },
  );
  // Gy/h, absorbed dose in air, at a build-up factor of 2. A slab estimate
  // rather than a transport result, so it carries no distance: it is the dose
  // with a hand on the material, and a bigger piece of the same material reads
  // the same.
  //
  // Hidden rather than drawn empty when the vendored solver predates the field
  // (see vendor/CORE_COMMIT): an axis pair with nothing in it reads as a
  // material that gives no dose, which is a different and alarming claim.
  const dose = document.getElementById("plot-dose");
  const wrap = dose.closest(".plot-wrap") || dose;
  const bar = wrap.previousElementSibling;
  if (results.some((r) => r.contact_dose !== undefined)) {
    wrap.hidden = false;
    if (bar && bar.classList.contains("axis-scale")) bar.hidden = false;
    decaySeriesChart(
      dose, results, "contact_dose_by_nuclide",
      "Contact dose rate", "contact dose [Gy/h]",
      { key: "contact_dose", name: "total" },
    );
  } else {
    wrap.hidden = true;
    if (bar && bar.classList.contains("axis-scale")) bar.hidden = true;
  }
}

// Re-draw on a theme change: the dark steps are a selected palette validated
// against the dark surface, not an automatic flip of the light one, so the
// charts have to be rebuilt rather than filtered.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  window.dispatchEvent(new CustomEvent("yani:redraw"));
});
