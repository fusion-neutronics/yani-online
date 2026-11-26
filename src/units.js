// The units the decay charts can be read in.
//
// The page only says which units it offers. The factors come from the solver
// (`totalToUnits` for a total of the run's material, `convertUnits` for the
// dose rate, which is intensive already), with the same unit parser as the
// Python API's `units=`, so the browser and the wheel cannot disagree on what
// "Bq/kg" or "Ci" means. They are asked for once per run, for every unit
// offered, so changing the unit is a rescale of numbers already on the page
// and never a re-solve.

/// Per chart: the solver's own unit, how a factor out of it is asked for
/// (`total` for the whole material's Bq or W, `rate` for a dose rate), and the
/// units offered, the first being the solver's own.
export const UNITS = {
  "plot-activity": {
    native: "Bq",
    kind: "total",
    offered: ["Bq", "TBq", "Ci", "Bq/cm3", "Bq/m3", "Bq/g", "kBq/g", "Bq/kg"],
  },
  "plot-heat": {
    native: "W",
    kind: "total",
    offered: ["W", "kW", "W/cm3", "W/m3", "MW/m3", "W/g", "W/kg"],
  },
  "plot-dose": {
    native: "Gy/h",
    kind: "rate",
    offered: ["Gy/h", "mGy/h", "uGy/h"],
  },
};

/// How a unit is shown: the solver takes "u" for micro, a reader expects "µ".
export const unitLabel = (unit) => unit.replace(/^u/, "µ");

/// Every factor the unit selects can need, as the `unitFactors` solver call
/// takes them.
export const wantedFactors = () => Object.entries(UNITS).flatMap(([id, { native, kind, offered }]) =>
  offered.map((units) => ({ id, native, kind, units })));

/// The solver's answers, `null` where it refused a unit, as `{ id: { unit:
/// factor } }`.
export function factorTable(wanted, factors) {
  const table = {};
  wanted.forEach(({ id, units }, i) => {
    table[id] ??= {};
    table[id][units] = factors[i];
  });
  return table;
}
