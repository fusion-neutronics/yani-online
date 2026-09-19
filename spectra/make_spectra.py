#!/usr/bin/env python3
"""Make the neutron spectra the page offers as presets.

Seven spectra on the CCFE-709 group structure, written to ``src/spectra.js``
for the page to inline:

* ``dt-plasma`` and ``dd-plasma``: the unmoderated emission of a D-T and a D-D
  plasma at 20 keV ion temperature, a Gaussian with the mean and width of
  Ballabio et al. (Nucl. Fusion 38, 1998) as ``yamc.sources.fusion_neutron_spectrum``
  gives them, integrated over the groups. No transport.
* ``fw-hcpb``, ``fw-hcll``, ``fw-wcll``, ``fw-wccb`` and ``fw-flibe``: the
  neutron flux in the first wall of a spherical blanket model, tallied with
  yamc. The model is the same three shells around a plasma void in every case,
  and only the breeder zone changes:

      0 to 100 cm     void, with the D-T source at the centre
      100 to 103 cm   first wall, Eurofer
      103 to 163 cm   breeder zone, one of the five homogenised blankets
      163 to 173 cm   rear wall, Eurofer
      beyond          vacuum

  The tally is the track-length flux in the first-wall shell, per source
  neutron, in the 709 groups, and is written normalised to unit sum since the
  page and the wheel take a spectrum as a shape and the magnitude from the
  irradiation's rate. Every material is read at 600 K.

The blanket compositions are homogenised by volume fraction from the constituents
below and are representative rather than any one design's: the fractions are the
first thing to change for a different study, and they are all in ``BLANKETS``.

Usage::

    python spectra/make_spectra.py                # 4e6 particles per model
    python spectra/make_spectra.py --particles 20000 --threads 8

Needs ``pip install yamc``. The nuclear data (ENDF/B-VIII.1) is downloaded into
``~/.cache/yamc`` on the first run, a few hundred MB of transport data for the
nuclides in these materials.
"""

from __future__ import annotations

import argparse
import datetime as dt
import math
import pathlib
import sys
import time

import yamc

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "spectra.js"
STRUCTURE = "CCFE-709"
ION_TEMPERATURE_EV = 20_000.0
# The temperature the cross sections are read at, for every material in the
# model. 600 K is the published temperature nearest a Eurofer first wall's
# operating range, and the transport needs one named: a fast spectrum barely
# notices the Doppler broadening either way.
TEMPERATURE_K = 600.0

# Radii of the shells, cm.
R_VOID = 100.0
R_FIRST_WALL = 103.0
R_BREEDER = 163.0
R_REAR_WALL = 173.0

AVOGADRO = 6.02214076e23

# Standard atomic weights, g/mol, for the constituents' formula masses. Lithium
# is by isotope because it is enriched.
ATOMIC_WEIGHT = {
    "H": 1.008, "He": 4.0026, "Li6": 6.01512, "Li7": 7.01600, "Be": 9.0122,
    "C": 12.011, "O": 15.999, "F": 18.998, "Si": 28.085, "Ti": 47.867,
    "V": 50.942, "Cr": 51.996, "Mn": 54.938, "Fe": 55.845, "Ta181": 180.948,
    "W": 183.84, "Pb": 207.2,
}


def lithium(atoms: float, li6_atom_percent: float) -> dict[str, float]:
    """``atoms`` of lithium split into Li6 and Li7 at the given enrichment."""
    x = li6_atom_percent / 100.0
    return {"Li6": atoms * x, "Li7": atoms * (1.0 - x)}


def formula(density: float, atoms: dict[str, float]) -> dict[str, float]:
    """Atoms per cm3 of each species in a compound of the given density, from
    the atoms per formula unit."""
    molar_mass = sum(n * ATOMIC_WEIGHT[species] for species, n in atoms.items())
    units_per_cm3 = density * AVOGADRO / molar_mass
    return {species: n * units_per_cm3 for species, n in atoms.items()}


def alloy(density: float, mass_fractions: dict[str, float]) -> dict[str, float]:
    """Atoms per cm3 of each species in an alloy given by mass fraction."""
    total = sum(mass_fractions.values())
    return {
        species: density * AVOGADRO * (w / total) / ATOMIC_WEIGHT[species]
        for species, w in mass_fractions.items()
    }


# Constituents: (density in g/cm3, atoms per cm3 by species).
#
# Eurofer97 at its nominal composition by weight. Tantalum is written as Ta181
# rather than the element: the natural element carries a trace of the Ta180
# isomer, which the transport libraries do not evaluate. The ceramic breeders
# and the eutectic are at their solid or liquid densities, and the pebble beds'
# packing is in the volume fractions below rather than in the density here.
EUROFER = (7.80, alloy(7.80, {
    "Fe": 0.8877, "Cr": 0.090, "W": 0.011, "Mn": 0.004, "V": 0.002,
    "Ta181": 0.0012, "C": 0.0011,
}))
LI4SIO4_60 = (2.40, formula(2.40, {**lithium(4, 60), "Si": 1, "O": 4}))
LI2TIO3_90 = (3.43, formula(3.43, {**lithium(2, 90), "Ti": 1, "O": 3}))
BERYLLIUM = (1.85, formula(1.85, {"Be": 1}))
BE12TI = (2.26, formula(2.26, {"Be": 12, "Ti": 1}))
# The eutectic Pb-17Li, 17 atom percent lithium, at its density near 500 C.
PBLI_90 = (9.40, formula(9.40, {**lithium(17, 90), "Pb": 83}))
FLIBE_90 = (1.94, formula(1.94, {**lithium(2, 90), "Be": 1, "F": 4}))
# Water at pressurised-water conditions, 15.5 MPa and about 300 C.
WATER = (0.72, formula(0.72, {"H": 2, "O": 1}))
# Helium at 8 MPa and about 450 C.
HELIUM = (0.005, formula(0.005, {"He": 1}))

# The breeder zones, as volume fractions of the constituents. Each sums to one;
# any remainder is void.
BLANKETS = {
    "fw-hcpb": ("HCPB", "helium-cooled pebble beds: Be and Li4SiO4 (60% Li-6) pebbles in Eurofer",
                [(BERYLLIUM, 0.40), (LI4SIO4_60, 0.12), (EUROFER, 0.10), (HELIUM, 0.38)]),
    "fw-hcll": ("HCLL", "helium-cooled lithium lead: Pb-17Li (90% Li-6) in Eurofer",
                [(PBLI_90, 0.80), (EUROFER, 0.13), (HELIUM, 0.07)]),
    "fw-wcll": ("WCLL", "water-cooled lithium lead: Pb-17Li (90% Li-6) in Eurofer, water coolant",
                [(PBLI_90, 0.83), (EUROFER, 0.10), (WATER, 0.07)]),
    "fw-wccb": ("WCCB", "water-cooled ceramic breeder: Li2TiO3 (90% Li-6) and Be12Ti pebbles in Eurofer, water coolant",
                [(LI2TIO3_90, 0.14), (BE12TI, 0.40), (EUROFER, 0.11), (WATER, 0.15)]),
    "fw-flibe": ("FLiBe", "molten salt: Li2BeF4 (90% Li-6) in Eurofer",
                 [(FLIBE_90, 0.90), (EUROFER, 0.10)]),
}


def homogenise(parts: list[tuple[tuple[float, dict[str, float]], float]], name: str) -> yamc.Material:
    """One material for a zone made of ``parts`` by volume fraction."""
    density = 0.0
    atoms: dict[str, float] = {}
    for (rho, per_cm3), fraction in parts:
        density += rho * fraction
        for species, n in per_cm3.items():
            atoms[species] = atoms.get(species, 0.0) + n * fraction
    # The composition is relative, so the atoms per cm3 serve as atom fractions
    # and the density carries the magnitude.
    return yamc.Material(atoms, density, fraction_type="atom", name=name, temperature=TEMPERATURE_K)


def eurofer(name: str) -> yamc.Material:
    rho, per_cm3 = EUROFER
    return yamc.Material(per_cm3, rho, fraction_type="atom", name=name, temperature=TEMPERATURE_K)


def first_wall_spectrum(key: str, particles: int, threads: int | None, seed: int) -> tuple[list[float], float, float]:
    """Run one blanket model. Returns the normalised flux per group, the share
    of the spectrum held by groups whose relative error is under 5%, and the
    transport time in seconds."""
    short, _description, parts = BLANKETS[key]
    breeder = homogenise(parts, f"{short} breeder zone")

    void_edge = yamc.Sphere(radius=R_VOID)
    fw_edge = yamc.Sphere(radius=R_FIRST_WALL)
    breeder_edge = yamc.Sphere(radius=R_BREEDER)
    outer = yamc.Sphere(radius=R_REAR_WALL, boundary="vacuum")
    plasma = yamc.Cell(region=void_edge.below, name="plasma")
    first_wall = yamc.Cell(region=void_edge.above & fw_edge.below, material=eurofer("first wall"), name="first_wall")
    breeder_zone = yamc.Cell(region=fw_edge.above & breeder_edge.below, material=breeder, name="breeder_zone")
    rear_wall = yamc.Cell(region=breeder_edge.above & outer.below, material=eurofer("rear wall"), name="rear_wall")
    geometry = yamc.Geometry([plasma, first_wall, breeder_zone, rear_wall])

    source = yamc.NeutronSource(
        energy=yamc.sources.fusion_neutron_spectrum(ION_TEMPERATURE_EV),
        position=(0.0, 0.0, 0.0),
    )
    tally = yamc.Tally(cells=first_wall, scores=["flux"], energy_group_structure=STRUCTURE, name="first_wall_flux")
    model = yamc.Model(geometry=geometry, tallies=[tally], source=source)

    started = time.time()
    results = model.simulate_transport(total_particles=particles, seed=seed, threads=threads)
    elapsed = time.time() - started

    result = results[tally]
    mean = list(result.mean)
    error = list(result.relative_error)
    groups = len(yamc.group_structure(STRUCTURE)) - 1
    if len(mean) != groups:
        raise SystemExit(f"{key}: the tally has {len(mean)} bins, not {groups}")
    total = sum(mean)
    # The worst group is always a lone count in a tail; what says whether the
    # shape is converged is how much of it sits in groups that are.
    converged = sum(m for m, e in zip(mean, error) if m > 0 and e < 0.05) / total
    return [m / total for m in mean], converged, results.transport_time or elapsed


def gaussian_groups(mean: float, std_dev: float) -> list[float]:
    """A normal distribution integrated over the groups, normalised to one."""
    edges = yamc.group_structure(STRUCTURE)
    cdf = [0.5 * (1.0 + math.erf((e - mean) / (std_dev * math.sqrt(2.0)))) for e in edges]
    values = [max(0.0, hi - lo) for lo, hi in zip(cdf, cdf[1:])]
    total = sum(values)
    return [v / total for v in values]


def js_number(v: float) -> str:
    """Compact and exact enough: five significant figures of a shape whose
    statistical error is far larger than that."""
    if v == 0.0:
        return "0"
    return f"{v:.4e}".replace("e-0", "e-").replace("e+0", "e").replace("e+", "e")


def js_list(values: list[float], indent: str) -> str:
    lines = []
    line = indent
    for item in map(js_number, values):
        if len(line) + len(item) + 2 > 100:
            lines.append(line.rstrip())
            line = indent
        line += item + ", "
    lines.append(line.rstrip())
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--particles", type=int, default=4_000_000, help="source neutrons per blanket model")
    parser.add_argument("--threads", type=int, default=None, help="threads for the transport (default: all)")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--out", type=pathlib.Path, default=OUT)
    args = parser.parse_args()

    yamc.cross_section_data = "endf-b8.1"

    presets: list[tuple[str, str, str, list[float]]] = []
    for key in BLANKETS:
        short, description, parts = BLANKETS[key]
        breeder = homogenise(parts, short)
        print(f"{key}: breeder zone {breeder.density:.3f} g/cm3, {description}", flush=True)
        values, worst, elapsed = first_wall_spectrum(key, args.particles, args.threads, args.seed)
        print(f"  {args.particles:,} particles, {elapsed:.0f} s of transport, "
              f"{100 * worst:.1f}% of the spectrum in groups with relative error under 5%", flush=True)
        presets.append((key, f"First wall, {short} blanket", f"Neutron flux in the Eurofer first wall of a spherical {short} blanket model ({description}), from a D-T plasma source at 20 keV, tallied with yamc.", values))

    for key, reactants, label in [("dt-plasma", "DT", "D-T plasma, unmoderated"), ("dd-plasma", "DD", "D-D plasma, unmoderated")]:
        dist = yamc.sources.fusion_neutron_spectrum(ION_TEMPERATURE_EV, reactants=reactants)
        print(f"{key}: Gaussian, mean {dist.mean / 1e6:.4f} MeV, standard deviation {dist.std_dev / 1e3:.1f} keV")
        presets.append((key, label, f"The {reactants[0]}-{reactants[1]} fusion neutron emission of a plasma at 20 keV ion temperature, a Gaussian of {dist.mean / 1e6:.3f} MeV mean and {dist.std_dev / 1e3:.0f} keV standard deviation (Ballabio et al., 1998), with no material between it and the point of use.", values := gaussian_groups(dist.mean, dist.std_dev)))

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    out = [
        "// The spectrum presets, generated by spectra/make_spectra.py. Do not edit by",
        "// hand: rerun the script, which documents the models and the assumptions.",
        f"// Generated {stamp} with yamc {getattr(yamc, '__version__', '?')}, {args.particles:,} source neutrons per blanket model.",
        "//",
        f'// Every preset is on the {STRUCTURE} group structure, one value per group, summing',
        "// to one. The boundaries come from the solver by name, so none are kept here.",
        "",
        "export const SPECTRA = {",
    ]
    for key, label, description, values in presets:
        out.append(f'  "{key}": {{')
        out.append(f'    label: "{label}",')
        out.append(f'    description: "{description}",')
        out.append(f'    structure: "{STRUCTURE}",')
        out.append("    values: [")
        out.append(js_list(values, "      "))
        out.append("    ],")
        out.append("  },")
    out.append("};")
    args.out.write_text("\n".join(out) + "\n")
    print(f"wrote {args.out} with {len(presets)} presets")


if __name__ == "__main__":
    main()
