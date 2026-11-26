// The units the decay charts can be read in, as a pure rescale of what the
// solver returned.
//
// The solver reports activity in Bq and decay heat in W for the whole
// material, and the contact dose in Gy/h. A specific value is the total over
// the material's volume or mass, so changing the unit never re-solves: it
// divides numbers already on the page.
//
// Per mass uses the material's mass density as built, not each step's. That
// moves by parts in 1e8 over an irradiation, as activation shifts mass between
// nuclides, which is far below anything a chart can show. A material given as
// atom/barn-cm has no mass density without atomic masses the page does not
// carry, so its per-mass units are offered disabled rather than guessed.

/// Per chart, the units offered in order, the first being the solver's own.
/// `per` is what the total is divided by: nothing, the volume in cm3 or m3, or
/// the mass in g or kg. `scale` is a plain factor for the dose, which is
/// intensive already and so has no per-volume or per-mass form.
export const UNITS = {
  "plot-activity": [
    { unit: "Bq" },
    { unit: "Bq/cm3", per: "cm3" },
    { unit: "Bq/m3", per: "m3" },
    { unit: "Bq/g", per: "g" },
    { unit: "Bq/kg", per: "kg" },
  ],
  "plot-heat": [
    { unit: "W" },
    { unit: "W/cm3", per: "cm3" },
    { unit: "W/m3", per: "m3" },
    { unit: "W/g", per: "g" },
    { unit: "W/kg", per: "kg" },
  ],
  "plot-dose": [
    { unit: "Gy/h" },
    { unit: "mGy/h", scale: 1e3 },
    { unit: "µGy/h", scale: 1e6 },
  ],
};

/// The volume (cm3) and mass density (g/cm3) a run's totals are divided by,
/// from the material JSON the solver describes. `massDensity` is null when
/// the material was given in atom densities.
export function unitBasis(material) {
  if (!material) return null;
  const massDensity = material.density_units === "g/cm3"
    ? material.density
    : material.density_units === "kg/m3" ? material.density / 1e3 : null;
  return { volume: material.volume ?? null, massDensity };
}

/// What a value in the solver's unit is multiplied by to read in `option`'s,
/// or null when `basis` cannot give it (no volume, or no mass density for a
/// per-mass unit).
export function unitFactor(option, basis) {
  if (option.scale) return option.scale;
  if (!option.per) return 1;
  const volume = basis && basis.volume;
  if (!(volume > 0)) return null;
  if (option.per === "cm3") return 1 / volume;
  if (option.per === "m3") return 1e6 / volume;
  const rho = basis.massDensity;
  if (!(rho > 0)) return null;
  if (option.per === "g") return 1 / (volume * rho);
  if (option.per === "kg") return 1e3 / (volume * rho);
  throw new Error(`no unit per '${option.per}'`);
}
