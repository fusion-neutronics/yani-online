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
/// (`total` for the whole material's Bq or W, `rate` for a dose rate), the
/// units offered, the first being the solver's own, and the units a chart
/// opens in, the first of them the run can give.
///
/// Activity and decay heat open per kg: a specific value does not depend on
/// the volume, which is only there to make a total and is arbitrary for most
/// runs, and per kg is what handbooks and clearance limits quote. Per cm3 is
/// next, then the total, for a solver that cannot convert units.
export const UNITS = {
  "plot-activity": {
    native: "Bq",
    kind: "total",
    offered: ["Bq", "TBq", "Ci", "Bq/cm3", "Bq/m3", "Bq/g", "kBq/g", "Bq/kg"],
    defaults: ["Bq/kg", "Bq/cm3", "Bq"],
  },
  "plot-heat": {
    native: "W",
    kind: "total",
    offered: ["W", "kW", "W/cm3", "W/m3", "MW/m3", "W/g", "W/kg"],
    defaults: ["W/kg", "W/cm3", "W"],
  },
  // Absorbed dose in air only: the browser's run computes no effective dose,
  // so there are no Sv units to offer. Per year as well as per hour, for a
  // dose rate read against an annual limit, with the year written "a", the
  // solver's only spelling of it.
  "plot-dose": {
    native: "Gy/h",
    kind: "rate",
    offered: ["Gy/h", "mGy/h", "uGy/h", "mGy/a", "uGy/a"],
    defaults: ["Gy/h"],
  },
};

/// Whether `unit` is a total of the whole material rather than per volume or
/// per mass, and so needs saying what it is a total of.
export const isTotal = (id, unit) => UNITS[id].kind === "total" && !unit.includes("/");

/// What a total is for, from the run's material as the solver describes it:
/// "1000 cm³ / 7.87 kg of Iron". The mass is the volume times the input mass
/// density, and left out for a material given in atom densities, which has
/// none; the name is left out for a material that has none. Null without a
/// volume.
export function amountLabel(material) {
  if (!material || !(material.volume > 0)) return null;
  const sig = (v) => String(Number(v.toPrecision(3)));
  const density = material.density_units === "g/cm3"
    ? material.density
    : material.density_units === "kg/m3" ? material.density / 1e3 : null;
  const parts = [`${sig(material.volume)} cm³`];
  if (density > 0) parts.push(`${sig((material.volume * density) / 1e3)} kg`);
  return parts.join(" / ") + (material.name ? ` of ${material.name}` : "");
}

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
