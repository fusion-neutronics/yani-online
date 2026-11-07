// Irradiation schedules, as the rows of the schedule table.
//
// Pure data and arithmetic, no DOM: the page builds its default schedule and
// its two scenario buttons from here, and verify.mjs checks the same functions
// without a browser.

/// Seconds per unit, the spellings the schedule table offers and the solver's
/// `durationToSeconds` reads. Here for choosing a unit to *show* a duration
/// in; the conversion the run uses stays the solver's.
export const UNIT_SECONDS = { s: 1, min: 60, h: 3600, d: 86400, a: 365.25 * 86400 };

/// Cooling steps whose cumulative times run log-evenly from `start` to `stop`
/// seconds in `n` steps, as `{ kind, value, unit }` rows of the schedule.
///
/// The same arithmetic as `yani.cooldown_steps((1, "s"), (10, "a"), 10)` in
/// the wheel: the cumulative times are the geometric sequence, and each step's
/// duration is the gap to the one before. Each duration is then shown in the
/// largest unit it fills, to three significant figures, so the table reads as
/// "7.8 s", "1.47 h", "8.86 a" rather than as seconds with nine digits. The
/// rounding moves a cumulative time by under a percent, which is nothing on a
/// log axis and is what makes the row a number someone could have typed.
export function logSpacedCooldowns(start, stop, n) {
  const steps = [];
  let previous = 0;
  for (let k = 0; k < n; k++) {
    const cumulative = start * (stop / start) ** (k / (n - 1));
    const seconds = cumulative - previous;
    previous = cumulative;
    const unit = Object.keys(UNIT_SECONDS).reverse().find((u) => seconds >= UNIT_SECONDS[u]) || "s";
    steps.push({ kind: "cooldown", value: Number((seconds / UNIT_SECONDS[unit]).toPrecision(3)), unit });
  }
  return steps;
}

/// The schedules the scenario buttons put in the table, by name, with the
/// buttons' labels.
export const SCENARIOS = {
  "one-year": "One year, then cooling",
  "five-years-80": "Five years at 80% availability, then cooling",
};

/// The rows of a named scenario, every pulse at `rate` (n/cm2/s).
///
/// `one-year` is the page's default: a year of irradiation, then ten cooling
/// steps at cumulative times spaced log-evenly from a second to ten years. A
/// single cooldown step is a defensible default and a useless plot: two points
/// a day apart on a log axis show nothing, and the whole shape of an activation
/// problem is which nuclide dominates at which decade.
///
/// `five-years-80` is five calendar years at 80% availability: five pulses of
/// 0.8 a at the full-power flux with four 0.2 a maintenance breaks between
/// them, 4.0 full-power years in 4.8 a, then twelve cooling steps from a second
/// to a hundred years, since end-of-life waste is what a lifetime irradiation is
/// for. Against one 4 a pulse, or 5 a at 80% of the flux, the fluence and the
/// long-lived inventory are the same; what differs is that the last step before
/// shutdown runs at full power, so short-lived activity, dose and decay heat at
/// shutdown are those of a running plant, and nuclides with half-lives of
/// weeks to a year see the breaks. Each 0.8 a is burn time at the full-power
/// flux: DEMO's dwells between burns (2 h burns, 0.5 h dwells) are not in it.
/// Counted inside the 80% they would make it 3.2 full-power years, a fifth
/// less fluence; left out, they matter to the inventory only through
/// half-lives of minutes to hours.
export function scenarioSchedule(name, rate) {
  if (name === "one-year") {
    return [
      { kind: "pulse", rate, value: 1, unit: "a" },
      ...logSpacedCooldowns(1, 10 * UNIT_SECONDS.a, 10),
    ];
  }
  if (name === "five-years-80") {
    const steps = [];
    for (let year = 0; year < 5; year++) {
      if (year) steps.push({ kind: "cooldown", value: 0.2, unit: "a" });
      steps.push({ kind: "pulse", rate, value: 0.8, unit: "a" });
    }
    return [...steps, ...logSpacedCooldowns(1, 100 * UNIT_SECONDS.a, 12)];
  }
  throw new Error(`no schedule called '${name}'`);
}
