// The decay charts as tables, laid out the way activation handbooks print
// them: a column per cooling time after shutdown, the total in the first row,
// and below it each nuclide that matters as a percentage of that column's
// total.

import { UNIT_SECONDS } from "./schedules.js";

/// The smallest share, in percent, a cell shows. Below it the cell is blank:
/// a table of every nuclide to three decimals is a closure dump, and the
/// question it answers is which few nuclides carry the total at each time.
export const SHARE_FLOOR = 1;

/// A time after shutdown, compactly: two significant figures in the largest
/// of the page's units it fills, so "5.3 min" or "3.7 d" rather than seconds.
export function coolingLabel(seconds) {
  if (seconds <= 0) return "0 s";
  const unit = Object.keys(UNIT_SECONDS).reverse().find((u) => seconds >= UNIT_SECONDS[u]) || "s";
  return `${Number((seconds / UNIT_SECONDS[unit]).toPrecision(2))} ${unit}`;
}

/// The table for one quantity.
///
/// `perStep` is each step's by-nuclide dict and `totals` each step's total,
/// both in the solver's unit; `factor` puts the totals into the chart's chosen
/// unit (the shares do not depend on it). `after` is each step's time after
/// shutdown, and only the steps at or after shutdown are columns: the steps
/// before are the irradiation, which a cooling table is not about.
///
/// A nuclide gets a row if it reaches `SHARE_FLOOR` in some column, and the
/// rows are ordered by the column each first reaches it in, then by its share
/// there, so the table reads down as the run does: the short-lived carriers at
/// shutdown first, the long-lived ones that take over last.
export function shareTable(perStep, totals, after, factor) {
  const columns = [];
  after.forEach((time, i) => {
    if (time >= 0) columns.push({ label: coolingLabel(time), total: totals[i] * factor, step: i });
  });
  const shareOf = (name, column) => {
    const total = totals[column.step];
    return total > 0 ? (100 * ((perStep[column.step] || {})[name] || 0)) / total : 0;
  };

  const first = new Map();
  columns.forEach((column, c) => {
    for (const name of Object.keys(perStep[column.step] || {})) {
      if (!first.has(name) && shareOf(name, column) >= SHARE_FLOOR) first.set(name, c);
    }
  });
  const names = [...first.keys()].sort((a, b) =>
    first.get(a) - first.get(b)
    || shareOf(b, columns[first.get(b)]) - shareOf(a, columns[first.get(a)])
    || a.localeCompare(b));

  const rows = names.map((name) => ({
    name,
    shares: columns.map((column) => {
      const share = shareOf(name, column);
      return share >= SHARE_FLOOR ? share : null;
    }),
  }));
  return { columns: columns.map(({ label, total }) => ({ label, total })), rows };
}
