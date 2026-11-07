#!/usr/bin/env python3
"""Make the neutron spectra the page offers as presets.

Transports the typical EU DEMO of ``tokamak_model.py`` with each of four
blankets (HCPB, HCLL, WCLL, WCCB) and tallies the neutron flux in five places:

    fw   the 2.5 cm first wall, averaged over the whole poloidal circumference
    bz   the breeder zone, averaged over the whole shell
    vv   the 57 cm vacuum vessel, averaged over the whole shell
    tf   the TF coil winding pack's vertical inboard leg, averaged over its
         60 cm and its height beside the vessel (|z| under 6.8 m); the arms
         above and below it, inside R0, are a cell of their own
    bio  the inner 20 cm of the concrete bioshield wall (R 20.0 to 20.2 m)

Averages rather than peaks: the inboard midplane, where the shield is thinnest,
runs several times higher in the vessel and the coil, and the generator prints
the midplane rings the papers' values compare with. The bioshield value is an
estimate, not a bound either way: the model has no ports or other penetrations,
which would raise it, and no cryostat, outboard TF legs, PF coils or thermal
shields, which would lower it.

It writes:

* ``src/spectra.js``, the page's presets: the 20 tokamak spectra on CCFE-709
  as unit-sum shapes with each one's total flux at full power and its
  uncertainty, and the unmoderated D-T and D-D emission of a 20 keV plasma
  (Ballabio et al. 1998, as ``yamc.sources.fusion_neutron_spectrum`` gives it),
  which need no transport and have no magnitude.
* ``spectra/data/<STRUCTURE>.csv`` for all ten neutron group structures yamc
  and yani name: per group, every tokamak spectrum's flux in n/cm2/s at full
  power with its relative statistical error, and the two emissions as shapes.
  Each structure is its own tally in the same runs, so every group's error is
  exact; no structure's boundaries are a subset of another's, so none could
  be collapsed from another exactly.

Normalisation. Each history is one source neutron. The source rate is the
fusion power over 17.589 MeV per D-T reaction, 7.228e20 n/s at 2037 MW (Noce
et al. quote 7.2e20); the 0.48% of D-D neutrons are counted as D-T ones, a 0.3%
effect. A group's flux is the tallied track length per source neutron over the
cell's analytic volume, times that rate, so it is the flux at full power and
scales linearly with fusion power.

Variance reduction. The first wall and the breeder zone converge analog; the
vessel, the coil and the bioshield do not (analog transport puts nothing in
the coil or the bioshield). So the deep places are reached with weight
windows, on a Cartesian mesh of 10 cm cubes over the tokamak, one energy
group, the lower bound 0.25 exp(-D) where D is the flux's e-foldings from the
plasma-facing surface; the upper bound five times the lower, survivors at
three times it, at most ten copies per split. yamc applies windows at
collisions, so the voids (the gaps, the hall) hold none, and outside the mesh,
in the bioshield, a particle keeps the weight it left the tokamak with. D
comes from three runs per blanket:

1. Analog, with a cylindrical mesh tally along the midplane (5 cm rings from
   the axis to R 22 m, |z| < 1 m). The slope of ln(flux) through each layer, on
   each side, gives its e-folding length lambda. It resolves the first wall,
   the breeder zone and the back end, and fades out in the vessel.
2. The same tally with windows from those lambdas, and a provisional 10 cm
   where the analog run saw nothing. Its slopes reach through the vessel and
   the coil, and it measures the two voids that layers cannot describe, each
   pooled over all its rings: the hall, and the hole inside the coil, which the
   hall feeds.
3. Production, with windows from the second run's lambdas and void levels.
   D adds thickness / lambda through each layer; voids hold the value they
   are entered with; the coil is reached from the hole, the hall and the
   void where its outboard legs would be as well as from the vessel, and the
   easiest of those sets D. Without that the windows roulette the particles
   crossing the coil up to weights their neighbours do not have, and the coil
   and the bioshield come out heavy-tailed.

DeGVR's generated windows were tried on this model and populated neither the
coil nor the bioshield; a pilot with hand-set lambdas and 30 cm windows over
the whole model did, but noisily.

Each production is two or more independent runs of the same size, seeds 3, 4
and on (PRODUCTION), pooled with ``yamc.combine_results``. Every run's total
has to lie within three combined standard errors of the others' pooled total
at every place, and the uncertainty a preset quotes is the larger of the
pooled error and the error the runs' scatter alone gives (for two runs,
|a - b| / (a + b)), so a heavy-tailed place whose error estimate is itself
off shows it. Every run has a fixed seed and history count and no time limit.
A run's tallies are the same to the last few bits however its threads finish,
and the fitted lambdas and levels are rounded to three figures before they set
a window, so a rerun builds the same windows and reproduces the results to
those last bits. The generator prints, per place, every run's total, the share
of the spectrum in groups whose relative error is under 5, 10 and 20%, the
flux-weighted mean error, the worst group among those holding 0.1% of the flux
or more, yamc's reliability verdict on each run's total, and the midplane rings
at the front of the layers, with their shares above 0.1 and 1 MeV; and it
refuses to write when a spectrum is short of its gate: 99% of the flux in
groups under 5% error for fw, bz and vv; 80% under 10% for tf; 50% under 10%
for bio; and the runs agreeing.

Usage::

    python spectra/make_spectra.py --skip-gates          # 2 to 4 h on 16 threads
    python spectra/make_spectra.py --skip-gates --cache ~/.cache/yani-spectra
    python spectra/make_spectra.py --blankets wcll --scale 0.05 --skip-gates \\
        --out /tmp/spectra.js --data /tmp/data           # a quick look

The committed files were written with ``--skip-gates``: the HCPB, WCCB and
WCLL coils and the WCLL bioshield are short of their gates (see the
dev-readme's Statistics), which their presets' descriptions, the page and the
files' headers say. Without the flag the generator refuses to write, as it
should.

``--cache`` keeps each production run's results (Arrow) and reuses them when
nothing that decides the transport has changed (the materials, the build and
its cells, the source, the tallies, the histories, the seed and the windows),
so the output can be rewritten without transporting again. A subset of the
blankets is refused unless ``--out`` and ``--data`` both point away from the
committed files. Needs ``pip install yamc numpy``. The nuclear data,
ENDF/B-VIII.1, is downloaded into ``~/.cache/yamc`` on the first run.

References (V, D and A in tokamak_model.py say what is taken from them):

* S. Noce, F. Moro, F. Romanelli, R. Villari, Nuclear analysis of the Single
  Module Segment WCLL DEMO, Fusion Eng. Des. 147 (2019),
  doi:10.1016/j.fusengdes.2019.05.026 (EUROfusion preprint WPBB-PR(18) 21090,
  which the numbers here are read from). Table 1 (BL2015: R0 9.072 m, a
  2.927 m, elongation 1.59, triangularity 0.33, 18 TF coils, 2037 MW,
  1.05 MW/m2), Table 2 (WCLL radial build: 76.0 cm inboard, 129.7 cm
  outboard), 7.2e20 n/s; first-wall flux 4.1e14 (inboard) and 4.8e14 n/cm2/s
  (outboard), 67% of it above 0.1 MeV; 3.4e8 n/cm2/s, 1.3e8 of it fast, on the
  TF coil at the inboard midplane; the water manifold's 93% water; the LiPb
  volumes of section 4.
* E. Martelli et al., Advancements in DEMO WCLL breeding blanket design and
  integration, EUROfusion WPBB-PR(17) 17326, Int. J. Energy Res. 42 (2018) 27.
  Table 6 (7 mm channels on a 16 mm pitch in the 25 mm first wall), the
  450 / 800 mm breeder zone, water at 15.5 MPa and 285 / 325 C, first-wall flux
  5e14 n/cm2/s.
* F.A. Hernandez et al., Overview of the HCPB Research Activities in EUROfusion,
  EUROfusion WPBB-CPR(17) 17877, IEEE Trans. Plasma Sci. 46 (2018). BL2015
  (2037 MW, 2 h burn and 0.5 h dwell), Fig. 2e (520 / 230 mm breeder zone, the
  bed, plate and first-wall dimensions, 2 mm of W; Fig. 2 labels Eurofer
  shielding packs in the BSS), 60% Li6, helium at 8 MPa and 300 / 500 C.
* P. Pereslavtsev et al., Neutronic analyses for the optimization of the
  advanced HCPB breeder blanket design for DEMO, EUROfusion WPBB-CP(16) 15579
  (SOFT 2016). The Li4SiO4 packing factor of 0.64, and the "additional ~20 cm
  massive steel block behind the feeding pipes" that shortening the breeder
  zone to 22 / 51 cm made room for, to shield the vessel and the TF coil.
* J. Aubert et al., Status of the EU DEMO HCLL breeding blanket design
  development, EUROfusion WPBB-CPR(17) 17516, Fusion Eng. Des. 136 (2018).
  Pb-15.7Li with 90% Li6, helium at 8 MPa and 300 / 500 C, 2 mm of W, 5 mm
  stiffening plates between 35.4 mm layers of PbLi.
* J.-C. Jaboulay et al., Nuclear analysis of the HCLL blanket for the European
  DEMO, EUROfusion WPBB-CP(16) 15569 (SOFT 2016). Table 4, "main quantity in
  the first 5 cm" of each layer at the inboard midplane, in the row headed
  Phi(E>1MeV): 5.8e14 (first wall, in the tungsten armour), 5.3e14 (breeder
  zone), 7.2e13 (manifold), 3.1e13 (vessel), 3.6e8 n/cm2/s (TF coil).
* U. Fischer et al., Neutronic performance issues of the breeding blanket
  options for the European DEMO fusion power plant, EUROfusion CP(15)06/32,
  Fusion Eng. Des. 109-111 (2016) 1458, and its ISFNT-12 slides (2015), for
  DEMO 2014 (1572 MW). The 80 / 130 cm envelope, PbLi zones of 70 to 80 cm,
  the 57 cm vessel (5 + 47 + 5 cm, 80% steel and 20% water in the 47), the coil
  limits (1e9 n/cm2/s fast, 50 W/m3); the fast (> 0.1 MeV) flux at the TF coil
  case front at the inboard midplane, HCPB 1.7e9, HCLL 2.4e9 and WCLL 5.3e8
  n/cm2/s; and that only the WCLL meets the limits without WC or borated water
  in the vessel.
* M.R. Gilbert et al., Activation, decay heat, and waste classification
  studies of the European DEMO concept, Nucl. Fusion 57 (2017) 046015
  (EUROfusion WPPMI-CP(16) 14994): the same approach, one geometry with four
  homogenised blankets, and its 80/20 vessel.
* R. Lindau et al., Present development status of EUROFER and ODS-EUROFER for
  application in blanket concepts, Fusion Eng. Des. 75-79 (2005) 989.
  Eurofer97's nominal composition.
* E. Mas de les Valls et al., Lead-lithium eutectic material database for
  nuclear fusion technology, J. Nucl. Mater. 376 (2008) 353, and D. Martelli
  et al., Literature review of lead-lithium thermophysical properties,
  EUROfusion WPEDU-PR(18) 21061, which gives the same density correlation for
  17 at.% Li over 508 to 880 K and attributes it to Stankus et al.
* The CFETR and Japanese WCCB concepts: IAEA Technical Meeting on Tritium
  Breeding Blankets and Associated Neutronics (2025), the CFETR WCCB
  contribution (a mixed Li2TiO3 and Be12Ti bed, 15.5 MPa water) and the
  Japanese WCCB-TBM one (15.5 MPa and 280 C, F82H),
  https://conferences.iaea.org/event/406/contributions/contributions.pdf;
  S. Liu et al., Conceptual design of the water cooled ceramic breeder blanket
  for CFETR, Fusion Eng. Des. 89 (2014) 1380; and the DEM study of the packing
  of CFETR WCCB pebble beds, J. Nucl. Sci. Technol.,
  doi:10.1080/00223131.2015.1074877. The WCCB's fractions are assumed from
  these and are the least certain of the four, and its back end is a
  placeholder.
* PNNL-15870 Rev. 2, Compendium of Material Composition Data for Radiation
  Transport Modeling (2021), via yamc.materials.pnnl: SS316L and ordinary
  concrete.
* C. Fausser et al., Tokamak D-T neutron source models for different plasma
  physics confinement modes, Fusion Eng. Des. 87 (2012) 787. The plasma
  profiles.
* L. Ballabio, J. Kallne, G. Gorini, Relativistic calculation of fusion product
  spectra for thermonuclear plasmas, Nucl. Fusion 38 (1998) 1723. The
  emission spectra.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import pathlib
import sys
import time

import numpy as np
import yamc

import tokamak_model as tm

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "spectra.js"
DATA = ROOT / "spectra" / "data"
LIBRARY = "endf-b8.1"

# The page's one structure, and every neutron structure yamc and yani name.
PAGE_STRUCTURE = "CCFE-709"
STRUCTURES = ["XMAS-172", "VITAMIN-J-175", "SCALE-252", "TRIPOLI-315", "SHEM-361", "LLNL-616",
              "CCFE-709", "SCALE-999", "UKAEA-1102", "ECCO-1968"]

# Each blanket's production: independent runs of a fixed size, seeds 3, 4 and
# on, whose totals have to agree (see main), sized from trial runs. The coil is
# the binding gate for all four, and WCLL's bioshield is the noisy place (see
# the dev-readme). More runs of the same size add to a cache rather than
# replacing it.
CALIBRATION_ANALOG = 2_000_000
CALIBRATION_WINDOWED = 200_000
PRODUCTION = {"hcpb": (2_000_000, 6), "hcll": (4_000_000, 2), "wcll": (4_000_000, 4), "wccb": (3_000_000, 2)}
CALIBRATION_SEEDS = (1, 2)
FIRST_PRODUCTION_SEED = 3
# A run's total disagrees with the others' when it is more than this many
# combined standard errors from their pooled total.
SEED_AGREEMENT = 3.0
# The production's midplane rings are tallied in these groups, eV, for the
# peaks the papers quote: the total, the flux above 0.1 MeV and above 1 MeV.
PEAK_ENERGIES = [0.0, 1e5, 1e6, 1e9]

# The calibration mesh, cm: 5 cm rings from the axis to the bioshield's back.
CALIBRATION_R = (0.0, tm.HALL_RADIUS + tm.BIOSHIELD)
CALIBRATION_Z = 100.0
CALIBRATION_BIN = 5.0
# The rings a slope is fitted over: under this relative error, and at least three.
FIT_ERROR = 0.20
# A fitted lambda outside this range, cm, is not trusted.
LAMBDA_RANGE = (3.0, 200.0)
# For the second calibration run only, where the analog one saw nothing: about
# the e-folding length of a steel and water shield.
PROVISIONAL_LAMBDA = 10.0

# The weight windows.
WW_VOXEL = 10.0   # cm
WW_RATIO = 5.0
WW_SURVIVAL = 3.0
WW_MAX_SPLIT = 10
WW_SOURCE_LOWER = 0.25

# (error, share): the share of a spectrum's flux that has to sit in groups whose
# relative error is under the error.
GATES = {"fw": (0.05, 0.99), "bz": (0.05, 0.99), "vv": (0.05, 0.99), "tf": (0.10, 0.80), "bio": (0.10, 0.50)}

ION_TEMPERATURE_EV = 20_000.0
LOCATION_TEXT = {
    "fw": ("first wall", "the 2.5 cm first wall, averaged over the whole poloidal circumference"),
    "bz": ("breeder zone", "the breeder zone, averaged over the whole shell"),
    "vv": ("vacuum vessel", "the 57 cm vacuum vessel, averaged over the whole shell"),
    "tf": ("TF coil winding pack (inboard leg)",
           "the TF coil winding pack's inboard leg, averaged over its 60 cm and its height beside the vessel"),
    "bio": ("bioshield (no ex-vessel structures)",
            "the inner 20 cm of the concrete bioshield wall at R 20 m (an estimate, not a bound: the model has "
            "no ports or penetrations to stream through, and no cryostat, outboard TF legs or PF coils to "
            "shield the hall)"),
}
# The places behind the manifolds and BSS, whose presets carry a blanket's back_note.
BEHIND_THE_BACK = ("vv", "tf", "bio")


# --- calibration -----------------------------------------------------------------

def reproducible(value: float) -> float:
    """A fitted number at three significant figures. A run's tallies come out
    the same to the last few bits however its threads finish, but only to the
    last few bits, and a window set from a fit that differs there can flip a
    split or a roulette and send a history down another path. Rounded, the
    windows are the same every time, and so is everything after them."""
    return float(f"{value:.3g}")


def midplane_tally(energy_bins=None) -> yamc.Tally:
    """Flux in 5 cm rings along the midplane, |z| under CALIBRATION_Z."""
    nbins = round((CALIBRATION_R[1] - CALIBRATION_R[0]) / CALIBRATION_BIN)
    mesh = yamc.RegularCylindricalMesh(r_bounds=CALIBRATION_R, z_bounds=(-CALIBRATION_Z, CALIBRATION_Z),
                                       shape=(nbins, 1, 1))
    name = "midplane" if energy_bins is None else "midplane by energy"
    return yamc.Tally(mesh=mesh, scores=["flux"], particle="neutron", name=name, energy_bins=energy_bins)


def profile_of(tally: yamc.Tally, result, grouped=None) -> dict:
    """A midplane tally's flux per cm3 per source neutron, ring by ring, and,
    from ``grouped`` (the same rings in PEAK_ENERGIES' groups), each ring's
    share in every group."""
    # A mesh tally's mean is the track length in each bin, so the bin volume
    # comes off here.
    volumes = np.array(tally.mesh_element_volumes())
    nbins = len(volumes)
    profile = {"phi": np.array(result.mean) / volumes, "err": np.array(result.relative_error),
               "edges": np.linspace(CALIBRATION_R[0], CALIBRATION_R[1], nbins + 1)}
    if grouped is not None:
        # Energy-major: every ring of the first group, then of the next.
        by_group = np.array(grouped.mean).reshape(-1, nbins) / volumes
        profile["shares"] = by_group / np.where(by_group.sum(axis=0) > 0, by_group.sum(axis=0), 1.0)
    return profile


def midplane_profile(tok: tm.Tokamak, sources, threads: int, histories: int, seed: int, ww=None) -> dict:
    """The flux per cm3 per source neutron in 5 cm rings along the midplane."""
    tally = midplane_tally()
    model = yamc.Model(geometry=tok.geometry, tallies=[tally], source=sources, verbose=[],
                       variance_reduction=[ww] if ww else [])
    started = time.time()
    results = model.simulate_transport(total_particles=histories, seed=seed, threads=threads)
    return dict(profile_of(tally, results[tally]), histories=histories, seed=seed, wall_s=time.time() - started)


def fit_lambdas(tok: tm.Tokamak, profile: dict) -> dict:
    """Each layer's e-folding length on each side, from the slope of ln(flux)
    over the rings wholly inside it whose error is under FIT_ERROR, each
    weighted by its error: ``{layer:
    ((lambda, rings), (lambda, rings))}``, lambda None where fewer than three
    rings qualify."""
    phi, err, edges = profile["phi"], profile["err"], profile["edges"]

    def fit(lo: float, hi: float, inboard: bool) -> tuple[float | None, int]:
        inside = (edges[:-1] >= lo) & (edges[1:] <= hi) & (phi > 0) & (err > 0) & (err < FIT_ERROR)
        if inside.sum() < 3:
            return None, int(inside.sum())
        r = 0.5 * (edges[:-1] + edges[1:])[inside]
        slope = np.polyfit(r, np.log(phi[inside]), 1, w=1.0 / err[inside])[0]
        # Inboard the flux falls as R falls, outboard as it rises.
        falling = slope if inboard else -slope
        if falling <= 1.0 / LAMBDA_RANGE[1]:
            return LAMBDA_RANGE[1], int(inside.sum())
        return reproducible(float(np.clip(1.0 / falling, *LAMBDA_RANGE))), int(inside.sum())

    fitted = {}
    for k, layer in enumerate(tok.layers):
        (ri, ro, _), (ri2, ro2, _) = tok.boxes[k], tok.boxes[k + 1]
        if layer.material is not None:
            fitted[layer.name] = (fit(ri2, ri, True), (None, 0) if layer.inboard_only else fit(ro, ro2, False))
    return fitted


def void_levels(tok: tm.Tokamak, profile: dict) -> dict:
    """D in the two voids the windows cannot derive from the layers, read off a
    profile: the central hole inside the coil, and the hall. ln of the flux at
    the plasma-facing surface over the flux in each void, the rings inside it
    pooled (a void's flux is flat, and one ring of it is noisy), or None where
    the pooled flux's error is over FIT_ERROR."""
    phi, err, edges = profile["phi"], profile["err"], profile["edges"]
    lo, hi = edges[:-1], edges[1:]
    volume = hi ** 2 - lo ** 2
    r_in, r_out, _ = tok.boxes[0]
    surface = (phi > 0) & (((lo >= r_in) & (hi <= r_in + 30.0)) | ((lo >= r_out - 30.0) & (hi <= r_out)))
    reference = (phi * volume)[surface].sum() / volume[surface].sum()

    def level(inside):
        track = (phi * volume)[inside]
        if track.sum() <= 0 or np.sqrt(((err[inside] * track) ** 2).sum()) / track.sum() > FIT_ERROR:
            return None
        return reproducible(float(np.log(reference / (track.sum() / volume[inside].sum()))))

    return {"hole": level(hi <= tok.boxes[-1][0]),
            "hall": level((lo >= tok.boxes[-1][1] + 5.0) & (hi <= tm.HALL_RADIUS))}


# The rings the papers' midplane values are compared with: the front of each
# tallied layer, and of the TF coil's case.
PEAK_LAYERS = {"fw": "first_wall", "bz": "breeder_zone", "mf": "manifolds_bss", "vv": "vacuum_vessel",
               "tfc": "tf_case_front", "tf": "tf_winding_pack", "bio": "bioshield_face"}


def midplane_peaks(tok: tm.Tokamak, profile: dict) -> dict:
    """The midplane ring (|z| < 1 m, 5 cm deep) at the front of each of
    PEAK_LAYERS, inboard and outboard: ``{place: (inboard, outboard)}``, each a
    ring's flux per cm3 per source neutron and, where the profile has them, its
    shares above 0.1 and 1 MeV, or None where the ring's error is over
    FIT_ERROR or there is no such ring."""
    phi, err, edges = profile["phi"], profile["err"], profile["edges"]
    shares = profile.get("shares")
    width = edges[1] - edges[0]

    def at(i):
        if not (0 <= i < len(phi) and 0 < err[i] < FIT_ERROR):
            return None
        ring = {"phi": float(phi[i]), "err": float(err[i])}
        if shares is not None:
            ring["above_0.1MeV"] = float(shares[1:, i].sum())
            ring["above_1MeV"] = float(shares[2:, i].sum())
        return ring

    ring = lambda lo: at(int(np.ceil((lo - edges[0]) / width - 1e-9)))
    ring_ending = lambda hi: at(int(np.floor((hi - edges[0]) / width + 1e-9)) - 1)

    names = [layer.name for layer in tok.layers]
    peaks = {}
    for place, cell in PEAK_LAYERS.items():
        if cell == "bioshield_face":
            peaks[place] = (None, ring(tm.HALL_RADIUS))
            continue
        k = names.index(cell)
        (ri, ro, _), layer = tok.boxes[k], tok.layers[k]
        # The first wall is thinner than a ring: the plasma side of its surface stands in.
        if cell == "first_wall":
            peaks[place] = (ring(ri), ring_ending(ro))
        else:
            peaks[place] = (ring_ending(ri), None if layer.inboard_only else ring(ro))
    return peaks


def complete_lambdas(tok: tm.Tokamak, fits: list[dict], fallback: tuple[float, float] | None) -> dict:
    """One lambda per layer and side, ``{layer: (inboard, outboard)}`` in cm,
    None for void: the first of ``fits`` that resolved it; for the armour and
    the first wall, under a ring thick, the breeder zone's; otherwise the
    vessel's, or ``fallback`` when the vessel is not resolved either."""
    def first(name: str, side: int) -> float | None:
        return next((f[name][side][0] for f in fits if f[name][side][0] is not None), None)

    vessel = [first("vacuum_vessel", i) for i in (0, 1)]
    for i in (0, 1):
        if vessel[i] is None:
            if fallback is None:
                raise SystemExit(f"{tok.blanket}: the calibration did not resolve the vacuum vessel")
            vessel[i] = fallback[i]
    breeder = [first("breeder_zone", i) or vessel[i] for i in (0, 1)]
    lambdas = {}
    for layer in tok.layers:
        if layer.material is None:
            lambdas[layer.name] = None
        elif layer.name in ("armour", "first_wall"):
            lambdas[layer.name] = tuple(breeder)
        else:
            lambdas[layer.name] = tuple(first(layer.name, i) or vessel[i] for i in (0, 1))
    return lambdas


def calibrate(tok: tm.Tokamak, sources, threads: int) -> tuple[dict, dict, list[dict]]:
    """The windows' lambdas and void levels, in two runs.

    Analog transport resolves the first wall, the breeder zone and the back
    end, and fades out in the vessel. So the analog fit sets windows for a
    second run, with a provisional lambda where it could not see, and that
    run's fit, which reaches through the vessel and the coil to the hole and
    the hall, sets the production windows."""
    analog = midplane_profile(tok, sources, threads, CALIBRATION_ANALOG, CALIBRATION_SEEDS[0])
    first_fit = fit_lambdas(tok, analog)
    provisional = complete_lambdas(tok, [first_fit], (PROVISIONAL_LAMBDA, PROVISIONAL_LAMBDA))
    ww, _ = weight_windows(tok, provisional, {"hole": None, "hall": None})
    windowed = midplane_profile(tok, sources, threads, CALIBRATION_WINDOWED, CALIBRATION_SEEDS[1], ww)
    second_fit = fit_lambdas(tok, windowed)
    lambdas = complete_lambdas(tok, [second_fit, first_fit], None)
    levels = void_levels(tok, windowed)
    return lambdas, levels, [dict(analog, fit=first_fit, lambdas=provisional),
                             dict(windowed, fit=second_fit, lambdas=lambdas)]


def depth_map(tok: tm.Tokamak, lambdas: dict, levels: dict, x: np.ndarray, y: np.ndarray,
              z: np.ndarray) -> np.ndarray:
    """D, the number of e-foldings from the plasma-facing surface to each point
    of the grid.

    Through the layers: each layer the point is past, inboard, outboard or
    vertically, adds its thickness over its lambda, and in a corner the
    deepest way counts. Voids hold the value they are entered with. Beyond the
    last layer is the hall, at ``levels["hall"]`` (else the outboard vessel's
    exit), and inside the coil is the central hole, at ``levels["hole"]`` (else
    the coil's back). The coil is reached from those as well as from the
    vessel: its inner face from the hole, its top and bottom from the hall, and
    the ends of its arms at R0 from the void where the outboard legs would be,
    and the easiest of those ways sets D. A window map that disagreed with the
    flux there would roulette the particles crossing the coil up to weights
    their neighbours do not have, or split the hall's into thousands."""
    X, Y, Z = np.meshgrid(x, y, z, indexing="ij")
    R = np.hypot(X, Y)
    H = np.abs(Z)
    D = np.zeros(R.shape)
    done = (R >= tok.boxes[0][0]) & (R <= tok.boxes[0][1]) & (H <= tok.boxes[0][2])
    inner = R < tm.MAJOR_RADIUS
    # The way up and down has two paths: through the coil's top and bottom
    # inside R0, and through the void where the outboard legs would be.
    cum_in = cum_out = cum_v_coil = cum_v = 0.0
    for k, layer in enumerate(tok.layers):
        (ri, ro, h), (ri2, ro2, h2) = tok.boxes[k], tok.boxes[k + 1]
        lam = lambdas[layer.name]
        if lam is None:
            t_in = t_out = t_v = 0.0
        else:
            t_in = layer.inboard / lam[0]
            t_out = 0.0 if layer.inboard_only else layer.outboard / lam[1]
            t_v = layer.vertical / (lam[0] if layer.inboard_only else 0.5 * (lam[0] + lam[1]))
        t_v_void = 0.0 if layer.inboard_only else t_v
        here = ~done & (R >= ri2) & (R <= ro2) & (H <= h2)
        f_in = np.clip((ri - R) / (ri - ri2), 0.0, 1.0)
        f_out = np.clip((R - ro) / (ro2 - ro), 0.0, 1.0)
        f_v = np.clip((H - h) / (h2 - h), 0.0, 1.0)
        vertical = np.where(inner, cum_v_coil + f_v * t_v, cum_v + f_v * t_v_void)
        candidates = np.stack([
            np.where(R < ri, cum_in + f_in * t_in, -np.inf),
            np.where(R > ro, cum_out + f_out * t_out, -np.inf),
            np.where(H > h, vertical, -np.inf),
        ])
        D = np.where(here, candidates.max(axis=0), D)
        done |= here
        cum_in += t_in
        cum_out += t_out
        cum_v_coil += t_v
        cum_v += t_v_void

    r_in, r_out, h_out = tok.boxes[-1]
    hall = levels["hall"] if levels.get("hall") is not None else cum_out
    hole = levels["hole"] if levels.get("hole") is not None else cum_in
    D = np.where(done, D, np.where((R < r_in) & (H <= h_out), hole, hall))
    coil_layers = [k for k, layer in enumerate(tok.layers) if layer.inboard_only]
    if coil_layers:
        ri0, ro0, h0 = tok.boxes[coil_layers[0]]
        coil = done & (R < tm.MAJOR_RADIUS) & ~((R >= ri0) & (R <= ro0) & (H <= h0))
        lam = min(lambdas[tok.layers[k].name][0] for k in coil_layers)
        D = np.where(coil, np.minimum.reduce([
            D,
            hole + (R - r_in) / lam,
            hall + (h_out - H) / lam,
            cum_v + (tm.MAJOR_RADIUS - R) / lam,
        ]), D)
    return D


def weight_windows(tok: tm.Tokamak, lambdas: dict, levels: dict) -> tuple[yamc.WeightWindowBounds, dict]:
    """Windows on a Cartesian mesh of WW_VOXEL cubes over the tokamak, to the
    back of its last layer. Outside it, in the hall and the bioshield, a
    particle keeps the weight it left the tokamak with."""
    _, outer_r, outer_h = tok.boxes[-1]
    nxy = 2 * math.ceil(outer_r / WW_VOXEL)
    nz = 2 * math.ceil(outer_h / WW_VOXEL)
    half, hz = nxy * WW_VOXEL / 2, nz * WW_VOXEL / 2
    mesh = yamc.RegularRectangularMesh(lower_left=[-half, -half, -hz], upper_right=[half, half, hz],
                                       shape=[nxy, nxy, nz])
    centres = lambda h, n: -h + (np.arange(n) + 0.5) * (2 * h / n)
    D = depth_map(tok, lambdas, levels, centres(half, nxy), centres(half, nxy), centres(hz, nz))
    # yamc's voxel order is x fastest, z slowest.
    lower = (WW_SOURCE_LOWER * np.exp(-D)).transpose(2, 1, 0).ravel()
    ww = yamc.WeightWindowBounds(mesh=mesh, lower_bounds=lower, ratio=WW_RATIO, particle="neutron",
                                 survival_factor=WW_SURVIVAL, max_split=WW_MAX_SPLIT)
    return ww, {"shape": (nxy, nxy, nz), "depth_max": float(D.max())}


# --- production ------------------------------------------------------------------

def cache_key(tok: tm.Tokamak, lambdas: dict, levels: dict, histories: int, seed: int) -> str:
    """Everything that decides a production run: every cell's material (its
    nuclides, density and temperature), the build and its cells, the source,
    the tallies, the run's parameters and the windows' lambdas, which carry
    the calibration. Not the scripts' text, so a comment or an output change
    reuses the transport."""
    def material(m):
        return None if m is None else [m.name, m.nuclides, m.density, m.temperature]
    concrete = tok.cells["bioshield_face"].material
    parts = json.dumps({
        "blanket": tok.blanket,
        "layers": [[l.name, l.inboard, l.outboard, l.inboard_only, l.leg, material(l.material)] for l in tok.layers],
        "cells": sorted(tok.cells), "locations": tm.LOCATIONS,
        "boxes": tok.boxes, "hall": [tm.HALL_RADIUS, tm.HALL_HALF_HEIGHT, tm.BIOSHIELD, tm.BIOSHIELD_FACE],
        "concrete": material(concrete), "plasma": tm.PLASMA, "source_mesh": tm.SOURCE_MESH,
        "histories": histories, "seed": seed, "structures": STRUCTURES, "peak_energies": PEAK_ENERGIES,
        "midplane": [CALIBRATION_R, CALIBRATION_Z, CALIBRATION_BIN],
        "ww": [WW_VOXEL, WW_RATIO, WW_SURVIVAL, WW_MAX_SPLIT, WW_SOURCE_LOWER],
        "lambdas": lambdas, "levels": levels, "yamc": yamc.__version__, "library": LIBRARY,
    }, sort_keys=True, default=str).encode()
    return hashlib.sha256(parts).hexdigest()[:16]


def production(tok: tm.Tokamak, sources, ww, histories: int, threads: int, cache: pathlib.Path | None,
               key: str, seed: int):
    """One production run: a flux tally over the five places per structure,
    each place's total on its own, which is what yamc's reliability checks are
    run on, and the midplane rings, total and by energy. Read back from
    ``cache`` when a run with the same key is there. Returns the results, the
    totals' verdicts and whether it was reused."""
    path = cache / f"{tok.blanket}-{key}.arrow" if cache else None
    if path and path.exists():
        print(f"  seed {seed}: reusing {path}", flush=True)
        sidecar = path.with_suffix(".json")
        return (yamc.SimulationResults.from_arrow(str(path)),
                json.loads(sidecar.read_text()) if sidecar.exists() else {}, True)
    cells = [tok.cells[tm.LOCATIONS[loc]] for loc in tm.LOCATIONS]
    tallies = [yamc.Tally(cells=cells, scores=["flux"], particle="neutron", energy_group_structure=s, name=s)
               for s in STRUCTURES]
    tallies += [yamc.Tally(cells=[tok.cells[cell]], scores=["flux"], particle="neutron", name=f"total {loc}")
                for loc, cell in tm.LOCATIONS.items()]
    tallies += [midplane_tally(), midplane_tally(PEAK_ENERGIES)]
    model = yamc.Model(geometry=tok.geometry, tallies=tallies, source=sources, verbose=[], variance_reduction=[ww])
    results = model.simulate_transport(total_particles=histories, seed=seed, threads=threads)
    verdicts = {loc: verdict(results[f"total {loc}"]) for loc in tm.LOCATIONS}
    # A particle lost in a model of nested shells is a geometry bug.
    verdicts["lost_particles"] = len(model.lost_particles)
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        results.to_arrow(str(path))
        # An Arrow file keeps each bin's statistics but not the per-history
        # moments yamc's reliability checks need, so the verdicts go beside it.
        path.with_suffix(".json").write_text(json.dumps(verdicts, indent=1))
    return results, verdicts, False


def verdict(total) -> dict:
    """yamc's reliability checks on a place's total flux, as plain data."""
    checks = total.statistical_checks
    return {"passed": checks.passed, "n_passed": checks.n_passed, "n_evaluated": checks.n_evaluated,
            "tail_slope": total.aggregate_tail_slope, "variance_of_variance": total.aggregate_variance_of_variance,
            "summary": checks.summary()}


def run_agreement(totals: list[tuple[float, float]]) -> tuple[float, float]:
    """How well independent runs of the same size agree on a total, from each
    run's ``(mean, relative error)``: the furthest any run's total lies from
    the pooled total of the others, in their combined standard errors, and the
    relative standard error of the runs' mean from their scatter alone (for
    two runs, |a - b| / (a + b)). The second is an estimate of the pooled
    error that does not trust each run's own, which a heavy-tailed total's is
    not to be."""
    means = np.array([m for m, _ in totals])
    sigmas = np.array([m * e for m, e in totals])
    n = len(means)
    furthest = 0.0
    for i in range(n):
        others = np.delete(np.arange(n), i)
        combined = math.hypot(sigmas[i], math.sqrt((sigmas[others] ** 2).sum()) / len(others))
        if combined > 0:
            furthest = max(furthest, abs(means[i] - means[others].mean()) / combined)
    mean = means.mean()
    scatter = float(means.std(ddof=1) / math.sqrt(n) / mean) if mean > 0 else 0.0
    return furthest, scatter


def location_stats(mean: list[float], error: list[float], edges: list[float]) -> dict:
    """How well one spectrum is converged."""
    m = np.array(mean)
    e = np.array(error)
    total = m.sum()
    if total <= 0:
        return {"total": 0.0}
    share = lambda limit: float(m[(m > 0) & (e < limit)].sum() / total)
    populated = m > 0
    big = m >= 1e-3 * total
    worst = int(np.argmax(np.where(big, e, -1.0)))
    lo = np.array(edges[:-1])
    hi = np.array(edges[1:])
    return {
        "total": float(total),
        "share5": share(0.05), "share10": share(0.10), "share20": share(0.20),
        "weighted": float((m * e).sum() / total),
        "median": float(np.median(e[populated])),
        "worst": float(e[worst]), "worst_ev": (float(lo[worst]), float(hi[worst])), "worst_share": float(m[worst] / total),
        "groups": int(populated.sum()),
        "fast": float(m[lo >= 1e5].sum() / total),
        "thermal": float(m[hi <= 0.625].sum() / total),
    }


# --- the emissions ---------------------------------------------------------------

def gaussian_groups(edges: list[float], mean: float, std_dev: float) -> list[float]:
    """A normal distribution integrated over the groups, normalised to one."""
    cdf = [0.5 * (1.0 + math.erf((e - mean) / (std_dev * math.sqrt(2.0)))) for e in edges]
    values = [max(0.0, hi - lo) for lo, hi in zip(cdf, cdf[1:])]
    total = sum(values)
    return [v / total for v in values]


EMISSIONS = [("dt-plasma", "DT", "D-T plasma (20 keV)"), ("dd-plasma", "DD", "D-D plasma (20 keV)")]


# --- output ----------------------------------------------------------------------

def js_number(v: float, figures: int = 5) -> str:
    if v == 0.0:
        return "0"
    return f"{v:.{figures - 1}e}".replace("e-0", "e-").replace("e+0", "e").replace("e+", "e")


def js_list(values: list[float], indent: str) -> str:
    lines, line = [], indent
    for item in map(js_number, values):
        if len(line) + len(item) + 2 > 100:
            lines.append(line.rstrip())
            line = indent
        line += item + ", "
    lines.append(line.rstrip())
    return "\n".join(lines)


def listed(items) -> str:
    """Items for a sentence: "a", "a and b", "a, b and c"."""
    items = list(items)
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} and {items[-1]}"


def seed_range(seeds: list[int]) -> str:
    """Consecutive seeds for a sentence: "3 and 4", "3 to 8"."""
    return listed(map(str, seeds)) if len(seeds) <= 2 else f"{seeds[0]} to {seeds[-1]}"


def prose_number(v: float) -> str:
    """A flux for a sentence, as the page writes one: 3.74e14."""
    return f"{v:.3g}".replace("e+", "e").replace("e-0", "e-").replace("e0", "e")


def js_string(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


def write_js(path: pathlib.Path, presets: list[dict], provenance: list[str]) -> None:
    rate = tm.source_rate()
    out = [
        "// The spectrum presets, generated by spectra/make_spectra.py. Do not edit by",
        "// hand: rerun the script, which documents the model, its references and the",
        "// statistics. The same spectra, with their statistical errors, are in",
        "// spectra/data/ on all ten neutron group structures.",
        "//",
        *[f"// {line}" for line in provenance],
        "//",
        f"// Every preset is on the {PAGE_STRUCTURE} group structure, one value per group, summing",
        "// to one: a shape, whose magnitude comes from the pulses. `flux` is a tokamak",
        "// spectrum's total at the model's full fusion power, in n/cm2/s, and null for the",
        "// two emissions, which have none; `fluxRelErr` is its relative uncertainty, the",
        "// larger of its statistical error and the scatter of the runs pooled into it;",
        "// `shortOfGate` says why a spectrum is short of its statistics gate, or is null. The",
        "// boundaries come from the solver by name.",
        "",
        f"export const SOURCE = {{ fusionPowerMW: {tm.FUSION_POWER_MW:g}, neutronsPerSecond: {js_number(rate, 4)} }};",
        "",
        "export const SPECTRA = {",
    ]
    for p in presets:
        out.append(f"  {js_string(p['key'])}: {{")
        out.append(f"    group: {js_string(p['group'])},")
        out.append(f"    label: {js_string(p['label'])},")
        out.append(f"    description: {js_string(p['description'])},")
        out.append(f"    structure: {js_string(PAGE_STRUCTURE)},")
        out.append(f"    flux: {'null' if p['flux'] is None else js_number(p['flux'], 4)},")
        out.append(f"    fluxRelErr: {'null' if p['flux_rel_err'] is None else js_number(p['flux_rel_err'], 2)},")
        out.append(f"    shortOfGate: {'null' if p['short_of_gate'] is None else js_string(p['short_of_gate'])},")
        out.append("    values: [")
        out.append(js_list(p["values"], "      "))
        out.append("    ],")
        out.append("  },")
    out.append("};")
    path.write_text("\n".join(out) + "\n")


def write_csv(path: pathlib.Path, structure: str, edges: list[float], columns: list[tuple[str, list, list | None]],
              provenance: list[str]) -> None:
    head = [
        f"# Neutron spectra of a typical EU DEMO on {structure} ({len(edges) - 1} groups), from spectra/make_spectra.py.",
        *[f"# {line}" for line in provenance],
        "# Groups ascend in energy. <key> is the flux in the group in n/cm2/s at full power, linear in",
        "# fusion power; <key>_rel_err is its relative statistical error (0 where nothing scored).",
        "# dt-plasma and dd-plasma are the unmoderated emissions as shapes summing to one.",
    ]
    names = ["group", "lower_eV", "upper_eV"]
    for key, _, err in columns:
        names.append(key)
        if err is not None:
            names.append(f"{key}_rel_err")
    rows = [",".join(names)]
    for g in range(len(edges) - 1):
        cells = [str(g + 1), f"{edges[g]:.6g}", f"{edges[g + 1]:.6g}"]
        for _, values, err in columns:
            cells.append(f"{values[g]:.6g}")
            if err is not None:
                cells.append(f"{err[g]:.3g}")
        rows.append(",".join(cells))
    path.write_text("\n".join(head + rows) + "\n")


# --- main ------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--blankets", nargs="+", choices=sorted(tm.BLANKETS), default=list(tm.BLANKETS))
    parser.add_argument("--threads", type=int, default=16, help="transport threads (default 16)")
    parser.add_argument("--scale", type=float, default=1.0, help="multiply every production history count")
    parser.add_argument("--cache", type=pathlib.Path, help="keep and reuse production results here")
    parser.add_argument("--skip-gates", action="store_true", help="write even if a spectrum misses its gate")
    parser.add_argument("--out", type=pathlib.Path, default=OUT)
    parser.add_argument("--data", type=pathlib.Path, default=DATA)
    args = parser.parse_args()
    # A subset written over the committed files would leave the page and its
    # data files without the other blankets, --skip-gates or not.
    if set(args.blankets) != set(tm.BLANKETS) and (args.out.resolve() == OUT or args.data.resolve() == DATA):
        raise SystemExit("the page's presets and data files need all four blankets: pass --out and --data "
                         "elsewhere for a subset")

    yamc.cross_section_data = LIBRARY
    rate = tm.source_rate()
    print(f"yamc-core {yamc.__version__}, {LIBRARY}; {tm.FUSION_POWER_MW:.0f} MW, {rate:.4g} n/s, "
          f"plasma-facing area {tm.first_wall_area() / 1e4:.0f} m2, mean wall load "
          f"{rate * 14.06e6 * tm.EV_TO_J / tm.first_wall_area() * 1e4 / 1e6:.2f} MW/m2", flush=True)

    sources = tm.plasma_source()
    births = tm.check_birth_points(sources)
    print(f"source: {births['sources']} ring sources; {births['n']:,} birth points all inside the plasma cell, "
          f"R {births['r_min']:.0f} to {births['r_max']:.0f} cm (mean {births['r_mean']:.0f}), |z| to "
          f"{births['z_max']:.0f} cm, {100 * births['dd_share']:.2f}% D-D", flush=True)

    edges = {s: yamc.group_structure(s) for s in STRUCTURES}
    flux: dict[str, dict[str, tuple[np.ndarray, np.ndarray]]] = {s: {} for s in STRUCTURES}
    stats: dict[str, dict] = {}
    rings: dict[str, dict] = {}
    runs: list[str] = []
    releases: dict = {}
    failures: list[str] = []
    short: dict[str, str] = {}

    # Every calibration first, so that a model the windows cannot be fitted to
    # stops the run in minutes rather than after the productions before it.
    calibrated = {}
    for blanket in args.blankets:
        tok = tm.build(blanket)
        spec = tm.BLANKETS[blanket]
        print(f"\n{spec.short}: {spec.name}", flush=True)
        lambdas, levels, stages = calibrate(tok, sources, args.threads)
        for title, stage in zip(("analog", "windowed"), stages):
            print(f"  calibration, {title}: {stage['histories']:,} histories (seed {stage['seed']}) in "
                  f"{stage['wall_s']:.0f} s; lambda in cm (rings fitted) inboard, outboard -> used", flush=True)
            for name, fit in stage["fit"].items():
                shown = [f"{value:5.1f} ({used:2d})" if value is not None else f"  -   ({used:2d})"
                         for value, used in fit]
                used_in, used_out = stage["lambdas"][name]
                print(f"    {name:16s} {shown[0]}  {shown[1]}  -> {used_in:5.1f} {used_out:5.1f}")
        shown = ", ".join(f"{k} {'-' if v is None else f'{v:.1f}'}" for k, v in levels.items())
        print(f"  void levels, e-foldings below the plasma-facing surface: {shown}", flush=True)
        calibrated[blanket] = (tok, lambdas, levels, stages)

    for blanket in args.blankets:
        tok, lambdas, levels, stages = calibrated[blanket]
        spec = tm.BLANKETS[blanket]
        per_run, n_runs = PRODUCTION[blanket]
        each = max(1, round(per_run * args.scale))
        print(f"\n{spec.short}: production", flush=True)
        ww, wwinfo = weight_windows(tok, lambdas, levels)
        print(f"  windows: {wwinfo['shape']} mesh of {WW_VOXEL:g} cm voxels, depth up to "
              f"{wwinfo['depth_max']:.1f} e-foldings", flush=True)
        # Independent runs, which have to agree with each other, pooled.
        seeds = []
        for seed in range(FIRST_PRODUCTION_SEED, FIRST_PRODUCTION_SEED + n_runs):
            key = cache_key(tok, lambdas, levels, each, seed)
            started = time.time()
            results, verdicts, reused = production(tok, sources, ww, each, args.threads, args.cache, key, seed)
            run = results.runs[0]
            releases.update(run["data_releases"])
            took = f"{run['elapsed_secs']:.0f} s" + (" (cached)" if reused else f", {time.time() - started:.0f} s here")
            lost = verdicts.get("lost_particles")
            print(f"  seed {seed}: {run['n_histories']:,} histories in {took} on {args.threads} threads"
                  + ("" if lost is None else f", {lost} lost"), flush=True)
            seeds.append((seed, results, verdicts, reused))
        pooled = yamc.combine_results(*[r for _, r, _, _ in seeds])
        live = not any(reused for *_, reused in seeds)
        histories = sum(r.runs[0]["n_histories"] for _, r, _, _ in seeds)
        runs.append(f"{blanket}: {histories:,} histories in {len(seeds)} runs of {each:,} (seeds "
                    f"{seed_range([seed for seed, *_ in seeds])}), windows calibrated on "
                    f"{stages[0]['histories']:,} analog (seed {stages[0]['seed']}) and {stages[1]['histories']:,} "
                    f"windowed (seed {stages[1]['seed']})")
        peaks = midplane_peaks(tok, profile_of(midplane_tally(), pooled["midplane"], pooled["midplane by energy"]))
        rings[blanket] = {place: [None if r is None else dict(r, phi=r["phi"] * rate) for r in sides]
                          for place, sides in peaks.items()}
        for structure in STRUCTURES:
            mean = np.array(pooled[structure].mean)
            error = np.array(pooled[structure].relative_error)
            groups = len(edges[structure]) - 1
            if len(mean) != groups * len(tm.LOCATIONS):
                raise SystemExit(f"{structure}: {len(mean)} bins, expected {groups * len(tm.LOCATIONS)}")
            for i, (loc, cell) in enumerate(tm.LOCATIONS.items()):
                scale = rate / tok.volumes[cell]
                flux[structure][f"{blanket}-{loc}"] = (mean[i * groups:(i + 1) * groups] * scale,
                                                       error[i * groups:(i + 1) * groups])
        for loc, cell in tm.LOCATIONS.items():
            key_ = f"{blanket}-{loc}"
            phi, err = flux[PAGE_STRUCTURE][key_]
            s = location_stats(list(phi), list(err), edges[PAGE_STRUCTURE])
            s["total_error"] = float(pooled[f"total {loc}"].relative_error[0])
            # Each run's total, how far the furthest is from the others in
            # their combined standard errors, and the error their scatter
            # alone gives; the uncertainty quoted is the larger of that and
            # the pooled error.
            each_total = [(float(r[f"total {loc}"].mean[0]), float(r[f"total {loc}"].relative_error[0]))
                          for _, r, _, _ in seeds]
            s["seeds"] = [m * rate / tok.volumes[cell] for m, _ in each_total]
            s["seed_sigmas"], s["seed_spread"] = run_agreement(each_total)
            s["uncertainty"] = max(s["total_error"], s["seed_spread"])
            verdicts = [v.get(loc) for _, _, v, _ in seeds]
            s["verdict"] = " and ".join(f"{'passed' if v['passed'] else 'FAILED'} {v['n_passed']}/{v['n_evaluated']}"
                                        if v else "not kept" for v in verdicts)
            if live:
                v = verdict(pooled[f"total {loc}"])
                s["verdict"] += f"; pooled {v['n_passed']}/{v['n_evaluated']}, tail slope {v['tail_slope']:.1f}"
            stats[key_] = s
            limit, need = GATES[loc]
            got = s[{0.05: "share5", 0.10: "share10"}[limit]]
            reasons = []
            if got < need:
                reasons.append(f"{100 * got:.1f}% of its flux is in groups under {100 * limit:.0f}% error, "
                               f"against the {100 * need:.0f}% its gate asks")
            if s["seed_sigmas"] > SEED_AGREEMENT:
                reasons.append(f"its {len(seeds)} runs' totals, {listed(map(prose_number, s['seeds']))}, disagree: "
                               f"one is {s['seed_sigmas']:.1f} standard errors from the others'")
            if reasons:
                short[key_] = "; ".join(reasons)
                failures.append(f"{key_}: {short[key_]}")
            s["peaks"] = [None if r is None else r["phi"] / s["total"] for r in rings[blanket][loc]]
            lo, hi = s["worst_ev"]
            print(f"  {loc:3s} {s['total']:.3e} n/cm2/s +/- {100 * s['total_error']:.2f}%, runs "
                  f"{listed(f'{v:.4g}' for v in s['seeds'])} (scatter {100 * s['seed_spread']:.2f}%, furthest "
                  f"{s['seed_sigmas']:.1f} sigma from the others; yamc: "
                  f"{s['verdict']}); under 5/10/20%: {100 * s['share5']:.1f}/{100 * s['share10']:.1f}/"
                  f"{100 * s['share20']:.1f}%, flux-weighted error {100 * s['weighted']:.2f}%, median "
                  f"{100 * s['median']:.1f}% of {s['groups']} groups, worst {100 * s['worst']:.0f}% ({lo:.3g} to "
                  f"{hi:.3g} eV, {100 * s['worst_share']:.2f}% of the flux); {100 * s['fast']:.0f}% above 0.1 MeV, "
                  f"{100 * s['thermal']:.0f}% thermal  [{'SHORT' if reasons else 'ok'}]", flush=True)

    print("\nsummary, CCFE-709: total flux at full power, the uncertainty quoted (the larger of its error and the "
          "runs' scatter), flux-weighted group error, share of the flux in groups under 5/10/20% error, and the "
          "midplane ring at the layer's front, inboard and outboard, over the average")
    ratio = lambda v: "  -  " if v is None else f"{v:5.2f}"
    for key_, s in stats.items():
        print(f"  {key_:9s} {s['total']:.3e} n/cm2/s  {100 * s['uncertainty']:5.2f}%  {100 * s['weighted']:5.2f}%  "
              f"{100 * s['share5']:5.1f} {100 * s['share10']:5.1f} {100 * s['share20']:5.1f}   "
              f"{ratio(s['peaks'][0])} {ratio(s['peaks'][1])}")
    print("\nmidplane rings at full power, n/cm2/s, inboard / outboard, with the share above 0.1 and 1 MeV, "
          "for the papers' midplane values")
    for blanket, places in rings.items():
        for place, sides in places.items():
            shown = ["-" if r is None else f"{r['phi']:.3g} (+/- {100 * r['err']:.0f}%; {100 * r['above_0.1MeV']:.0f}% "
                     f"above 0.1 MeV, {100 * r['above_1MeV']:.0f}% above 1 MeV)" for r in sides]
            print(f"  {blanket} {place:3s} {shown[0]}  /  {shown[1]}")

    if failures:
        print("\nshort of the statistics gates:\n  " + "\n  ".join(failures))
        if not args.skip_gates:
            raise SystemExit("not writing: rerun the short blankets with more histories or better windows")

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    data_line = ", ".join(f"{lib} release {r['release']} (manifest sha256 {r['manifest_sha256'][:12]})"
                          for lib, r in sorted(releases.items()))
    provenance = [
        f"Generated {stamp} with yamc-core {yamc.__version__} on {data_line}.",
        f"Model: spectra/tokamak_model.py, a typical EU DEMO (BL2015 plasma, rectangular-section shells) at "
        f"{tm.FUSION_POWER_MW:.0f} MW fusion, {rate:.4g} n/s.",
        *runs,
    ]
    if short:
        provenance.append("Written short of the statistics gates (--skip-gates): "
                          + "; ".join(f"{k}, {v}" for k, v in short.items()) + ".")
    totals_lines = [f"{k} total {s['total']:.4g} n/cm2/s, relative error {s['total_error']:.2g}, its runs "
                    f"{listed(f'{v:.4g}' for v in s['seeds'])}, uncertainty quoted {s['uncertainty']:.2g}"
                    for k, s in stats.items()]

    presets = []
    for blanket in args.blankets:
        spec = tm.BLANKETS[blanket]
        for loc in tm.LOCATIONS:
            key_ = f"{blanket}-{loc}"
            phi, _ = flux[PAGE_STRUCTURE][key_]
            total = float(phi.sum())
            label, where = LOCATION_TEXT[loc]
            # Two figures, the same in the description and in fluxRelErr.
            uncertainty = float(f"{stats[key_]['uncertainty']:.1e}")
            short_of_gate = f"Short of its statistics gate: {short[key_]}." if key_ in short else None
            back = spec.back_note if loc in BEHIND_THE_BACK and spec.back_note else None
            presets.append({
                "key": key_,
                "group": f"{spec.short} blanket",
                "label": f"{spec.short}: {label}",
                "description": " ".join(filter(None, [
                    f"Neutron flux in {where}, in a typical EU DEMO (BL2015 plasma, {tm.FUSION_POWER_MW:.0f} MW "
                    f"fusion, rectangular-section shells) with homogenised {spec.short} ({spec.name}) blankets, "
                    f"tallied with yamc: {prose_number(total)} n/cm2/s at full power, "
                    f"+/- {100 * uncertainty:.2g}%.", back, short_of_gate])),
                "flux": total,
                "flux_rel_err": uncertainty,
                "short_of_gate": short_of_gate,
                "values": list(phi / total),
            })
    for key_, reactants, label in EMISSIONS:
        dist = yamc.sources.fusion_neutron_spectrum(ION_TEMPERATURE_EV, reactants=reactants)
        presets.append({
            "key": key_,
            "group": "Plasma emission, unmoderated",
            "label": label,
            "description": (
                f"The {reactants[0]}-{reactants[1]} fusion neutron emission of a plasma at 20 keV ion temperature, "
                f"a Gaussian of {dist.mean / 1e6:.3f} MeV mean and {dist.std_dev / 1e3:.0f} keV standard deviation "
                f"(Ballabio et al., 1998), with no material between it and the point of use."),
            "flux": None,
            "flux_rel_err": None,
            "short_of_gate": None,
            "values": gaussian_groups(edges[PAGE_STRUCTURE], dist.mean, dist.std_dev),
            "dist": dist,
        })

    args.out.parent.mkdir(parents=True, exist_ok=True)
    write_js(args.out, presets, provenance)
    print(f"\nwrote {args.out} with {len(presets)} presets")
    args.data.mkdir(parents=True, exist_ok=True)
    for structure in STRUCTURES:
        columns = [(p["key"], *flux[structure][p["key"]]) for p in presets if p["flux"] is not None]
        for p in presets:
            if p["flux"] is None:
                columns.append((p["key"], gaussian_groups(edges[structure], p["dist"].mean, p["dist"].std_dev), None))
        path = args.data / f"{structure}.csv"
        write_csv(path, structure, edges[structure], columns, provenance + totals_lines)
    size = sum((args.data / f"{s}.csv").stat().st_size for s in STRUCTURES)
    print(f"wrote {len(STRUCTURES)} structures to {args.data} ({size / 1e6:.1f} MB)")


if __name__ == "__main__":
    sys.exit(main())
