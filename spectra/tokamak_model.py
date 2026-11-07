#!/usr/bin/env python3
"""A typical EU DEMO tokamak for neutron spectra: materials, geometry, source.

Imported by ``make_spectra.py``, which transports it. Run on its own it prints
the radial build and the homogenised zones of each blanket, and ``--plot``
saves an xz and an xy slice of one of them::

    python spectra/tokamak_model.py               # the build, all four blankets
    python spectra/tokamak_model.py --plot wcll   # and tokamak_wcll_{xz,xy}.png

The machine is the EU DEMO 2015 baseline ("DEMO1", BL2015): R0 907.2 cm,
a 292.7 cm, elongation 1.59, triangularity 0.33, 18 TF coils, 2037 MW of
fusion power (Noce et al. 2018, Table 1). It is a *typical* DEMO, not any one
design: all four blankets sit in the same envelope (80 cm inboard and 130 cm
outboard from the plasma-facing surface to the vacuum vessel, Fischer et al.
2016), every layer is a homogenised mixture, and every number below is tagged
with where it comes from:

    V  read in the reference named beside it
    D  derived from that reference's published dimensions, as shown
    A  assumed, the thing to change for a specific design

The references are listed in full in ``make_spectra.py``'s docstring.

Geometry. Nested toroidal shells about the z axis with a rectangular poloidal
section: each shell is one box minus the box inside it, a box being the space
between two z-cylinders and two z-planes. The plasma-facing surface is the
innermost box, R 589.5 to 1224.9 cm (25 cm outside the separatrix at
R0 -/+ a, A) and |z| <= 500 cm (the plasma reaches 465 cm, A). Each layer has
an inboard and an outboard thickness, and its top and bottom take their mean
(A). Outward:

    W armour             0.2 / 0.2 cm  (V, Noce Table 2)
    first wall           2.5 / 2.5     (V, Noce Table 2)
    breeder zone         per blanket
    manifolds and BSS    per blanket, to the 80 / 130 cm envelope (Fischer)
                         or, for the WCLL, Noce's 26.3 / 47.0 cm and then a
                         void clearance; for the HCPB in front of a 20 cm
                         steel shield block (Pereslavtsev et al. 2016)
    vacuum vessel       57   / 57      (V, Fischer)
    gap                 10   / 10      void: thermal shield and clearance (A)
    TF coil case        10             inboard only, R < R0 (A)
    TF winding pack     60             inboard only (A): the vertical leg,
                                       |z| under the layer's inner half-height,
                                       is tallied, the arms above and below
                                       it are a cell of their own
    TF coil case        20             inboard only (A)
    hall                               void to R 2000 cm and |z| 1500 cm (A)
    bioshield          200             ordinary concrete: a cylindrical wall
                                       from R 2000 to 2200 cm and slabs above
                                       and below (A)

The outboard TF legs, about a quarter of the toroidal circumference, are left
out so that a continuous coil shell does not shield the hall; the central
solenoid, PF coils, cryostat, divertor and ports are not modelled.

Not yamc.Torus: on yamc-core 0.16.3 nested z-tori lose about 2% of histories
at the torus surfaces ("Surface crossed: unknown" with the particle on the
surface), and the rectangular section loses none and runs faster.

Source. ``yamc.sources.tokamak_source`` with that shape, in H mode, with the
profile parameters of core's examples/python/tokamak_plasma_source.py (after
Fausser et al. 2012), a Shafranov shift of 44.789 cm and 50:50 D-T fuel. Each
history is one neutron; ``source_rate`` turns that into neutrons per second.
"""

from __future__ import annotations

import argparse
import dataclasses
import math
import pathlib

import yamc

# --- the machine --------------------------------------------------------------

MAJOR_RADIUS = 907.2       # cm, V (Noce Table 1: 9.072 m)
MINOR_RADIUS = 292.7       # cm, V (Noce Table 1: 2.927 m)
ELONGATION = 1.59          # V (Noce Table 1)
TRIANGULARITY = 0.33       # V (Noce Table 1)
TF_COILS = 18              # V (Noce Table 1)
FUSION_POWER_MW = 2037.0   # V (Noce Table 1; Hernandez et al. 2018)

# Energy released per D-T reaction, which makes one neutron.
DT_ENERGY_EV = 17.589e6
EV_TO_J = 1.602176634e-19

# The plasma-facing surface, cm: 25 cm outside the separatrix in R (A), and a
# flat top and bottom at 500 cm, above the plasma's 465 cm (A).
PLASMA_GAP = 25.0
FW_INNER_RADIUS = MAJOR_RADIUS - MINOR_RADIUS - PLASMA_GAP   # 589.5
FW_OUTER_RADIUS = MAJOR_RADIUS + MINOR_RADIUS + PLASMA_GAP   # 1224.9
FW_HALF_HEIGHT = 500.0

# The radial build, cm, inboard and outboard.
ENVELOPE = (80.0, 130.0)   # armour to the back of the BSS, V (Fischer)
ARMOUR = 0.2               # V (Noce Table 2; 2 mm in Hernandez Fig. 2e and Aubert)
FIRST_WALL = 2.5           # V (Noce Table 2; 25 mm in Hernandez Fig. 2e and Martelli)
VACUUM_VESSEL = 57.0       # V (Fischer: 5 + 47 + 5 cm)
GAP = 10.0                 # A
TF_CASE_FRONT = 10.0       # A
TF_WINDING_PACK = 60.0     # A
TF_CASE_BACK = 20.0        # A

# The hall and the bioshield, cm (A).
HALL_RADIUS = 2000.0
HALL_HALF_HEIGHT = 1500.0
BIOSHIELD = 200.0
# The depth of the bioshield the spectrum is tallied in: its inner face.
BIOSHIELD_FACE = 20.0

# Cross-section temperatures, K: the in-vessel components near their operating
# range, the vacuum vessel and the concrete at room temperature, and the coils
# at the lowest temperature the data is published at. A fast spectrum barely
# notices the broadening; the labels are what a choice has to be made between.
IN_VESSEL_K = 600.0
ROOM_K = 294.0
MAGNET_K = 250.0

# The plasma, as ``yamc.sources.tokamak_source`` takes it: lengths in cm,
# densities in m^-3, temperatures in eV. The profiles are those of core's
# examples/python/tokamak_plasma_source.py, an EU DEMO H-mode plasma after
# C. Fausser et al., Fusion Eng. Des. 87 (2012) 787; the shape is BL2015's.
# The Shafranov shift is 44.789 cm: the example's 0.44789 is the same shift in
# metres, and tokamak_source takes centimetres.
PLASMA = dict(
    major_radius=MAJOR_RADIUS,
    minor_radius=MINOR_RADIUS,
    elongation=ELONGATION,
    triangularity=TRIANGULARITY,
    mode="H",
    ion_density_centre=1.09e20,
    ion_density_peaking_factor=1,
    ion_density_pedestal=1.09e20,
    ion_density_separatrix=3e19,
    ion_temperature_centre=45.9e3,
    ion_temperature_peaking_factor=8.06,
    ion_temperature_beta=6.0,
    ion_temperature_pedestal=6.09e3,
    ion_temperature_separatrix=0.1e3,
    pedestal_radius=0.8 * MINOR_RADIUS,
    shafranov_factor=44.789,
    fuel={"D": 0.5, "T": 0.5},
)
SOURCE_MESH = (50, 50)

# The cells the spectra are tallied in, by the key the presets use.
LOCATIONS = {
    "fw": "first_wall",
    "bz": "breeder_zone",
    "vv": "vacuum_vessel",
    "tf": "tf_winding_pack",
    "bio": "bioshield_face",
}


def source_rate(fusion_power_mw: float = FUSION_POWER_MW) -> float:
    """Neutrons per second at the given fusion power, counting every neutron as
    one D-T reaction's (the 0.5% of D-D neutrons move this by 0.3%)."""
    return fusion_power_mw * 1e6 / (DT_ENERGY_EV * EV_TO_J)


# --- materials -----------------------------------------------------------------

# Eurofer97 at its nominal composition, weight percent (Lindau et al. 2005), iron
# the balance. Tantalum as Ta181: the natural element carries a trace of the
# Ta180 isomer, which the transport libraries do not evaluate.
EUROFER97 = {"Cr": 9.0, "W": 1.1, "Mn": 0.4, "V": 0.2, "Ta181": 0.12, "C": 0.11}
EUROFER97["Fe"] = 100.0 - sum(EUROFER97.values())
EUROFER_DENSITY = 7.80

# Pb-15.7Li (Aubert et al. 2018, V), its density from the correlation of
# Mas de les Valls et al. 2008, rho = 10520.35 - 1.19051 T kg/m3, at 673 K (V:
# the PbLi property review WPEDU-PR(18) 21061 gives it as Stankus et al.'s, for
# 17 at.% Li over 508 to 880 K; that it holds at 15.7 at.% is A).
PBLI_LITHIUM = 15.7  # atom percent
PBLI_DENSITY = (10520.35 - 1.19051 * 673.0) / 1000.0  # 9.72 g/cm3

# Coolants. Water at 15.5 MPa and 285 to 325 C (Martelli, Noce): 0.72 g/cm3.
# Water in the vacuum vessel at about 100 C: 0.96 g/cm3. Helium at 8 MPa and
# about 400 C (Hernandez, Aubert): 0.0057 g/cm3 by the ideal gas law.
WATER_HOT_DENSITY = 0.72
WATER_VV_DENSITY = 0.96
HELIUM_DENSITY = 8e6 * 4.0026e-3 / (8.314462618 * 673.15) / 1000.0


def material(composition, density, name, temperature, fraction_type="atom"):
    return yamc.Material(composition=composition, density=density, fraction_type=fraction_type,
                         name=name, temperature=temperature)


def lithium_compound(atoms: dict, li6_percent: float, natural_density: float, name: str,
                     temperature: float) -> yamc.Material:
    """A lithium compound with its lithium enriched in Li6.

    ``atoms`` is the formula with lithium as ``"Li"``; ``natural_density`` is
    the compound's density with natural lithium. Enrichment changes the mass
    of the lattice, not its volume, so the density is scaled by the molar
    masses."""
    natural = material(atoms, natural_density, name, temperature)
    enriched_atoms = {**atoms, "Li": yamc.enriched(atoms["Li"], target="Li6", percent=li6_percent,
                                                   fraction_type="atom")}
    scaled = natural_density * material(enriched_atoms, natural_density, name, temperature).average_molar_mass() \
        / natural.average_molar_mass()
    return material(enriched_atoms, scaled, name, temperature)


def pnnl(name: str, label: str, temperature: float) -> yamc.Material:
    m = yamc.materials.pnnl[name]
    m.name = label
    m.temperature = temperature
    return m


def constituents() -> dict[str, yamc.Material]:
    """The pure materials the zones are mixed from, each at its zone's temperature."""
    hot = IN_VESSEL_K
    return {
        "tungsten": material({"W": 1.0}, 19.3, "tungsten", hot),
        "eurofer": material(EUROFER97, EUROFER_DENSITY, "Eurofer97", hot, fraction_type="mass"),
        "helium": material({"He": 1.0}, HELIUM_DENSITY, "helium, 8 MPa", hot),
        "water": material({"H": 2.0, "O": 1.0}, WATER_HOT_DENSITY, "water, 15.5 MPa", hot),
        # Pb-15.7Li with 90% Li6 (Aubert, Noce: V).
        "pbli": lithium_compound({"Pb": 100.0 - PBLI_LITHIUM, "Li": PBLI_LITHIUM}, 90.0, PBLI_DENSITY,
                                 "Pb-15.7Li, 90% Li6", hot),
        # Li4SiO4 with 60% Li6 (Hernandez, V), 2.40 g/cm3 with natural lithium.
        "li4sio4": lithium_compound({"Li": 4.0, "Si": 1.0, "O": 4.0}, 60.0, 2.40, "Li4SiO4, 60% Li6", hot),
        "beryllium": material({"Be": 1.0}, 1.85, "beryllium", hot),
        # Li2TiO3 with 80% Li6 (A, see the WCCB entry), 3.43 g/cm3 with natural lithium.
        "li2tio3": lithium_compound({"Li": 2.0, "Ti": 1.0, "O": 3.0}, 80.0, 3.43, "Li2TiO3, 80% Li6", hot),
        "be12ti": material({"Be": 12.0, "Ti": 1.0}, 2.26, "Be12Ti", hot),
    }


def mix(parts: dict[str, float], pure: dict[str, yamc.Material], name: str, temperature: float) -> yamc.Material:
    """One homogenised zone from volume fractions of the constituents; whatever
    the fractions leave short of one is void."""
    total = sum(parts.values())
    if not 0.0 < total <= 1.0 + 1e-9:
        raise ValueError(f"{name}: volume fractions sum to {total}")
    mixed = yamc.Material.mix_materials([pure[k] for k in parts], list(parts.values()),
                                        fraction_type="volume", name=name)
    # mix_materials carries no temperature over.
    mixed.temperature = temperature
    return mixed


# --- the blankets ----------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class Blanket:
    short: str
    name: str
    basis: str
    breeder_depth: tuple[float, float]   # cm, inboard and outboard
    first_wall: dict[str, float]         # volume fractions of the constituents
    breeder_zone: dict[str, float]
    back: dict[str, float]               # manifolds and back supporting structure
    # The manifolds and BSS's depth where the design gives one, cm, inboard and
    # outboard; the rest of the envelope is then a void clearance in front of
    # the vessel. None: the manifolds and BSS fill the envelope.
    back_depth: tuple[float, float] | None = None
    # A shield block behind the manifolds and BSS: its depth, cm, inboard and
    # outboard, and its make-up. None: no block.
    shield: tuple[tuple[float, float], dict[str, float]] | None = None
    # What the presets behind the back end should say about it, if anything.
    back_note: str | None = None


# The back end, for all four: the WCLL's four layers behind its breeder zone
# (Noce Table 2, outboard: LiPb manifold 14 cm, back plate 3 cm, water manifold
# 20 cm, BSS 10 cm, V; inboard 7.8, 1.7, 11.2 and 5.6 cm, the same proportions)
# homogenised, with the water manifold 93% water (Noce section 3.4, V), the LiPb
# manifold 80% LiPb (A) and the back plate and BSS Eurofer (A). The other
# concepts put their own coolant in the water's place and their breeder, or
# void, in the LiPb's (A).
_BACK_DEPTH = 14.0 + 3.0 + 20.0 + 10.0
BACK_BREEDER = 14.0 * 0.80 / _BACK_DEPTH      # 0.238
BACK_COOLANT = 20.0 * 0.93 / _BACK_DEPTH      # 0.396
BACK_STEEL = 1.0 - BACK_BREEDER - BACK_COOLANT  # 0.366
WCLL_BACK_DEPTH = (7.8 + 1.7 + 11.2 + 5.6, _BACK_DEPTH)   # 26.3 / 47.0, V (Noce Table 2)

# The helium-cooled first wall (Hernandez Fig. 2e, D): 25 mm of Eurofer with
# 12.5 mm square channels on a 17 mm pitch (12.5 mm channel, 4.5 mm rib).
HE_FW_HELIUM = 12.5 * 12.5 / (17.0 * 25.0)    # 0.368
# The water-cooled first wall (Martelli Table 6, D): 7 mm square channels on a
# 16 mm pitch in 25 mm.
WATER_FW_WATER = 7.0 * 7.0 / (16.0 * 25.0)    # 0.1225

# HCPB breeder zone (Hernandez Fig. 2e, D): a 65.5 mm repeat of a 15.5 mm
# Li4SiO4 bed, a 5 mm cooling plate, a 40 mm Be bed and another 5 mm plate; the
# Li4SiO4 packed at 0.64 (V, Pereslavtsev et al. 2016) and the Be at the same
# (A), the plates 60% Eurofer (A).
_HCPB_REPEAT = 15.5 + 40.0 + 2 * 5.0
_PEBBLE_PACKING = 0.64
HCPB_BZ = {
    "beryllium": 40.0 * _PEBBLE_PACKING / _HCPB_REPEAT,
    "li4sio4": 15.5 * _PEBBLE_PACKING / _HCPB_REPEAT,
    "eurofer": 2 * 5.0 * 0.60 / _HCPB_REPEAT,
}
HCPB_BZ["helium"] = 1.0 - sum(HCPB_BZ.values())

# HCPB shield block (Pereslavtsev et al. 2016): shortening the breeder zone to
# 22 / 51 cm made room for "an additional ~20 cm massive steel block behind the
# feeding pipes" in the BSS, to shield the vessel and the TF coil. 20 cm (V,
# inboard; A, outboard), 90% Eurofer and 10% helium for its cooling (A).
HCPB_SHIELD = ((20.0, 20.0), {"eurofer": 0.90, "helium": 0.10})

# HCLL breeder zone (Aubert, D): 5 mm helium-cooled stiffening plates every
# 35.4 mm of PbLi, the plates 70% Eurofer (A). Only the plates: the caps, side
# walls, back plates and manifold inside the zone are left out, which puts the
# zone's steel low.
_HCLL_REPEAT = 35.4 + 5.0
HCLL_BZ = {"pbli": 35.4 / _HCLL_REPEAT, "eurofer": 5.0 * 0.70 / _HCLL_REPEAT, "helium": 5.0 * 0.30 / _HCLL_REPEAT}

# WCLL breeder zone (Noce section 4, D): 800.61 m3 of LiPb in the breeding zone,
# where the "full-breeder" variant, the zone all LiPb, holds 1026 m3 against the
# reference's 845 m3 in all; so the zone is 800.61 / (800.61 + 1026 - 845) LiPb.
# The rest split 70:30 between Eurofer and water (A).
_WCLL_PBLI = 800.61 / (800.61 + 1026.0 - 845.0)   # 0.816
WCLL_BZ = {"pbli": _WCLL_PBLI, "eurofer": 0.70 * (1.0 - _WCLL_PBLI), "water": 0.30 * (1.0 - _WCLL_PBLI)}

# WCCB breeder zone (A, from the concept's descriptions: a mixed Be12Ti and
# Li2TiO3 pebble bed cooled by 15.5 MPa water): the bed fills 80% of the zone,
# packed at 0.75 (binary beds pack above 0.75), Be12Ti and Li2TiO3 4:1 by
# volume with 80% Li6, and the rest Eurofer and water 60:40.
_WCCB_BED = 0.80
_WCCB_PACKING = 0.75
WCCB_BZ = {
    "be12ti": _WCCB_BED * _WCCB_PACKING * 0.8,
    "li2tio3": _WCCB_BED * _WCCB_PACKING * 0.2,
    "eurofer": (1.0 - _WCCB_BED) * 0.6,
    "water": (1.0 - _WCCB_BED) * 0.4,
}

BLANKETS = {
    "hcpb": Blanket(
        short="HCPB",
        name="helium-cooled pebble bed",
        basis="the EU BL2015 sandwich design (Hernandez et al. 2018) with the shield block of Pereslavtsev et al. 2016",
        breeder_depth=(23.0, 52.0),   # V (Hernandez Fig. 2e: 230 mm inboard, 520 mm outboard)
        first_wall={"eurofer": 1.0 - HE_FW_HELIUM, "helium": HE_FW_HELIUM},
        breeder_zone=HCPB_BZ,
        back={"eurofer": BACK_STEEL, "helium": BACK_COOLANT},   # A, in front of the block
        shield=HCPB_SHIELD,
        back_note=("Its manifolds and back supporting structure, in front of the 20 cm steel shield block of "
                   "Pereslavtsev et al. 2016, are assumed: the WCLL's layers with helium in place of the water "
                   "and void in place of the PbLi."),
    ),
    "hcll": Blanket(
        short="HCLL",
        name="helium-cooled lithium lead",
        basis="the EU design of Aubert et al. 2018",
        # A: the WCLL's depths, since PbLi zones need 70 to 80 cm (Fischer).
        breeder_depth=(47.0, 80.0),
        first_wall={"eurofer": 1.0 - HE_FW_HELIUM, "helium": HE_FW_HELIUM},   # A: as the HCPB's
        breeder_zone=HCLL_BZ,
        back={"eurofer": BACK_STEEL, "helium": BACK_COOLANT, "pbli": BACK_BREEDER},
        back_note=("Its manifolds and back supporting structure are assumed: the WCLL's layers with helium in "
                   "place of the water, not the HCLL design's."),
    ),
    "wcll": Blanket(
        short="WCLL",
        name="water-cooled lithium lead",
        basis="the EU single module segment design (Noce et al. 2018, Martelli et al. 2018)",
        breeder_depth=(47.0, 80.0),   # V (Noce Table 2; Martelli gives 450 / 800 mm)
        first_wall={"eurofer": 1.0 - WATER_FW_WATER, "water": WATER_FW_WATER},
        breeder_zone=WCLL_BZ,
        back={"eurofer": BACK_STEEL, "water": BACK_COOLANT, "pbli": BACK_BREEDER},
        # Noce's build is 76.0 / 129.7 cm, so 4.0 / 0.3 cm of the envelope is clearance.
        back_depth=WCLL_BACK_DEPTH,
    ),
    "wccb": Blanket(
        short="WCCB",
        name="water-cooled ceramic breeder",
        basis="the CFETR and Japanese concept, with Eurofer for their CLF-1 and F82H steels",
        breeder_depth=(23.0, 52.0),   # A: the HCPB's, a solid breeder with a multiplier
        first_wall={"eurofer": 1.0 - WATER_FW_WATER, "water": WATER_FW_WATER},   # A: as the WCLL's
        breeder_zone=WCCB_BZ,
        back={"eurofer": BACK_STEEL, "water": BACK_COOLANT},
        back_note=("Its manifolds and back supporting structure are a placeholder: the WCLL's layers with void in "
                   "place of the PbLi, not a published design."),
    ),
}

# Common to all four. Vacuum vessel (Fischer, D): 5 cm steel shells either side
# of 47 cm of 80% steel and 20% water. Winding pack (A): steel, copper,
# Nb3Sn, epoxy and liquid helium.
VV_STEEL = (2 * 5.0 + 47.0 * 0.80) / VACUUM_VESSEL   # 0.835
WINDING_PACK = {"ss316l": 0.45, "copper": 0.20, "nb3sn": 0.07, "epoxy": 0.13, "liquid_helium": 0.15}


# --- the geometry ----------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class Layer:
    name: str
    inboard: float
    outboard: float
    material: yamc.Material | None
    inboard_only: bool = False
    # Split the inboard part into the vertical leg, |z| under the layer's inner
    # half-height, and the arms above and below it, each its own cell.
    leg: bool = False

    @property
    def vertical(self) -> float:
        """Top and bottom thickness: the mean of the two sides."""
        return 0.5 * (self.inboard + self.outboard)


@dataclasses.dataclass
class Tokamak:
    blanket: str
    geometry: yamc.Geometry
    cells: dict[str, yamc.Cell]
    layers: list[Layer]
    # (inner radius, outer radius, half height) of each nested box in cm, the
    # plasma-facing surface first; layer k lies between boxes k and k + 1.
    boxes: list[tuple[float, float, float]]
    volumes: dict[str, float]


def layers_for(blanket: str) -> list[Layer]:
    """The radial build of one blanket, armour to the back of the TF coil."""
    spec = BLANKETS[blanket]
    pure = constituents()
    bz_in, bz_out = spec.breeder_depth
    room_in = ENVELOPE[0] - ARMOUR - FIRST_WALL - bz_in
    room_out = ENVELOPE[1] - ARMOUR - FIRST_WALL - bz_out
    (shield_in, shield_out), shield = spec.shield if spec.shield else ((0.0, 0.0), None)
    back_in, back_out = spec.back_depth if spec.back_depth else (room_in - shield_in, room_out - shield_out)
    clear_in, clear_out = room_in - shield_in - back_in, room_out - shield_out - back_out
    if min(back_in, back_out) <= 0 or min(clear_in, clear_out) < -1e-9:
        raise ValueError(f"{blanket}: the blanket does not fit the {ENVELOPE} cm envelope")
    if (clear_in > 1e-9) != (clear_out > 1e-9):
        raise ValueError(f"{blanket}: a clearance on one side only would make a zero-thickness shell")
    vessel = {
        "ss316l": pnnl("Steel, Stainless 316L", "SS316L", ROOM_K),
        "water": material({"H": 2.0, "O": 1.0}, WATER_VV_DENSITY, "water, 100 C", ROOM_K),
    }
    magnet = {
        "ss316l": pnnl("Steel, Stainless 316L", "SS316L, coil", MAGNET_K),
        "copper": material({"Cu": 1.0}, 8.96, "copper", MAGNET_K),
        "nb3sn": material({"Nb": 3.0, "Sn": 1.0}, 8.92, "Nb3Sn", MAGNET_K),
        "epoxy": material({"C": 21.0, "H": 24.0, "O": 4.0}, 1.16, "epoxy", MAGNET_K),
        "liquid_helium": material({"He": 1.0}, 0.125, "liquid helium", MAGNET_K),
    }
    s = spec.short
    layers = [
        Layer("armour", ARMOUR, ARMOUR, pure["tungsten"]),
        Layer("first_wall", FIRST_WALL, FIRST_WALL, mix(spec.first_wall, pure, f"{s} first wall", IN_VESSEL_K)),
        Layer("breeder_zone", bz_in, bz_out, mix(spec.breeder_zone, pure, f"{s} breeder zone", IN_VESSEL_K)),
        Layer("manifolds_bss", back_in, back_out, mix(spec.back, pure, f"{s} manifolds and BSS", IN_VESSEL_K)),
    ]
    if shield:
        layers.append(Layer("shield_block", shield_in, shield_out, mix(shield, pure, f"{s} shield block", IN_VESSEL_K)))
    if clear_in > 1e-9:
        layers.append(Layer("vv_clearance", clear_in, clear_out, None))
    return layers + [
        Layer("vacuum_vessel", VACUUM_VESSEL, VACUUM_VESSEL,
              mix({"ss316l": VV_STEEL, "water": 1.0 - VV_STEEL}, vessel, "vacuum vessel", ROOM_K)),
        Layer("vv_tf_gap", GAP, GAP, None),
        Layer("tf_case_front", TF_CASE_FRONT, TF_CASE_FRONT, magnet["ss316l"], inboard_only=True),
        Layer("tf_winding_pack", TF_WINDING_PACK, TF_WINDING_PACK,
              mix(WINDING_PACK, magnet, "TF winding pack", MAGNET_K), inboard_only=True, leg=True),
        Layer("tf_case_back", TF_CASE_BACK, TF_CASE_BACK, magnet["ss316l"], inboard_only=True),
    ]


def nested_boxes(layers: list[Layer]) -> list[tuple[float, float, float]]:
    boxes = [(FW_INNER_RADIUS, FW_OUTER_RADIUS, FW_HALF_HEIGHT)]
    for layer in layers:
        r_in, r_out, h = boxes[-1]
        boxes.append((r_in - layer.inboard, r_out + layer.outboard, h + layer.vertical))
    if boxes[-1][0] <= 0:
        raise ValueError("the build reaches the axis")
    return boxes


def box_volume(r_in: float, r_out: float, h: float, clip: float | None = None) -> float:
    """Volume of the annular box, optionally only the part inside R = ``clip``."""
    if clip is not None:
        r_out = min(r_out, clip)
    return math.pi * (r_out ** 2 - r_in ** 2) * 2.0 * h if r_out > r_in else 0.0


def build(blanket: str) -> Tokamak:
    """The whole model for one blanket: geometry, cells by name, the build, and
    the analytic volume of every tallied cell."""
    layers = layers_for(blanket)
    boxes = nested_boxes(layers)

    def region(r_in, r_out, h):
        return (yamc.Cylinder(axis="z", radius=r_in).above & yamc.Cylinder(axis="z", radius=r_out).below
                & yamc.Plane(axis="z", offset=-h).above & yamc.Plane(axis="z", offset=h).below)

    regions = [region(*b) for b in boxes]
    split = yamc.Cylinder(axis="z", radius=MAJOR_RADIUS)
    cells = {"plasma": yamc.Cell(region=regions[0], name="plasma")}
    for k, layer in enumerate(layers):
        shell = regions[k + 1] & ~regions[k]
        if layer.inboard_only and layer.leg:
            # The vertical leg, between the two boxes' inner cylinders and under
            # the inner box's top and bottom; the arms are the rest inside R0.
            (r_in, _, h), (r_in2, _, _) = boxes[k], boxes[k + 1]
            leg = (yamc.Cylinder(axis="z", radius=r_in2).above & yamc.Cylinder(axis="z", radius=r_in).below
                   & yamc.Plane(axis="z", offset=-h).above & yamc.Plane(axis="z", offset=h).below)
            cells[layer.name] = yamc.Cell(region=leg, material=layer.material, name=layer.name)
            cells[f"{layer.name}_arms"] = yamc.Cell(region=shell & split.below & ~leg, material=layer.material,
                                                    name=f"{layer.name}_arms")
            cells[f"{layer.name}_outboard"] = yamc.Cell(region=shell & split.above, name=f"{layer.name}_outboard")
        elif layer.inboard_only:
            cells[layer.name] = yamc.Cell(region=shell & split.below, material=layer.material, name=layer.name)
            cells[f"{layer.name}_outboard"] = yamc.Cell(region=shell & split.above, name=f"{layer.name}_outboard")
        elif layer.material is None:
            cells[layer.name] = yamc.Cell(region=shell, name=layer.name)
        else:
            cells[layer.name] = yamc.Cell(region=shell, material=layer.material, name=layer.name)

    concrete = pnnl("Concrete, Ordinary (NIST)", "ordinary concrete", ROOM_K)
    wall_in = yamc.Cylinder(axis="z", radius=HALL_RADIUS)
    face = yamc.Cylinder(axis="z", radius=HALL_RADIUS + BIOSHIELD_FACE)
    wall_out = yamc.Cylinder(axis="z", radius=HALL_RADIUS + BIOSHIELD, boundary="vacuum")
    floor_top = yamc.Plane(axis="z", offset=-HALL_HALF_HEIGHT)
    roof_bottom = yamc.Plane(axis="z", offset=HALL_HALF_HEIGHT)
    floor_bottom = yamc.Plane(axis="z", offset=-HALL_HALF_HEIGHT - BIOSHIELD, boundary="vacuum")
    roof_top = yamc.Plane(axis="z", offset=HALL_HALF_HEIGHT + BIOSHIELD, boundary="vacuum")
    between = floor_top.above & roof_bottom.below
    cells["hall"] = yamc.Cell(region=wall_in.below & between & ~regions[-1], name="hall")
    cells["bioshield_face"] = yamc.Cell(region=wall_in.above & face.below & between, material=concrete,
                                        name="bioshield_face")
    cells["bioshield_wall"] = yamc.Cell(region=face.above & wall_out.below & between, material=concrete,
                                        name="bioshield_wall")
    cells["floor"] = yamc.Cell(region=wall_out.below & floor_bottom.above & floor_top.below, material=concrete,
                               name="floor")
    cells["roof"] = yamc.Cell(region=wall_out.below & roof_bottom.above & roof_top.below, material=concrete,
                              name="roof")
    geometry = yamc.Geometry(list(cells.values()))

    volumes = {}
    for k, layer in enumerate(layers):
        clip = MAJOR_RADIUS if layer.inboard_only else None
        volumes[layer.name] = box_volume(*boxes[k + 1], clip=clip) - box_volume(*boxes[k], clip=clip)
        if layer.leg:
            (r_in, _, h), (r_in2, _, _) = boxes[k], boxes[k + 1]
            volumes[f"{layer.name}_arms"] = volumes[layer.name] - box_volume(r_in2, r_in, h)
            volumes[layer.name] = box_volume(r_in2, r_in, h)
    volumes["bioshield_face"] = box_volume(HALL_RADIUS, HALL_RADIUS + BIOSHIELD_FACE, HALL_HALF_HEIGHT)
    return Tokamak(blanket, geometry, cells, layers, boxes, volumes)


def first_wall_area() -> float:
    """Area of the plasma-facing surface, cm2."""
    r_in, r_out, h = FW_INNER_RADIUS, FW_OUTER_RADIUS, FW_HALF_HEIGHT
    return 2 * math.pi * (r_in + r_out) * 2 * h + 2 * math.pi * (r_out ** 2 - r_in ** 2)


# --- the source ------------------------------------------------------------------

def plasma_source() -> list[yamc.NeutronSource]:
    """One ring source per (R, Z) voxel of the plasma and reaction, strengths
    summing to one."""
    return yamc.sources.tokamak_source(**PLASMA, mesh_resolution=SOURCE_MESH)


def check_birth_points(sources: list[yamc.NeutronSource], n: int = 100_000, seed: int = 1) -> dict:
    """Sample ``n`` birth points, strength-weighted, and fail if any lies outside
    the plasma cell. Returns what was found, for the log."""
    import random

    rng = random.Random(seed)
    counts = [0] * len(sources)
    for i in rng.choices(range(len(sources)), weights=[s.strength for s in sources], k=n):
        counts[i] += 1
    r_lo, r_hi, z_hi = math.inf, 0.0, 0.0
    r_sum = 0.0
    for source, count in zip(sources, counts):
        if not count:
            continue
        positions, _ = source.sample_n(count)
        for x, y, z in positions:
            r = math.hypot(x, y)
            if not (FW_INNER_RADIUS < r < FW_OUTER_RADIUS and abs(z) < FW_HALF_HEIGHT):
                raise SystemExit(f"a birth point at R {r:.1f} cm, z {z:.1f} cm is outside the plasma cell")
            r_lo, r_hi, z_hi = min(r_lo, r), max(r_hi, r), max(z_hi, abs(z))
            r_sum += r
    # The D-D share by strength, which is exact, rather than by the sample.
    dd = sum(s.strength for s in sources if s.energy.mean < 5e6) / sum(s.strength for s in sources)
    return {"n": n, "sources": len(sources), "r_min": r_lo, "r_max": r_hi, "z_max": z_hi,
            "r_mean": r_sum / n, "dd_share": dd}


# --- on its own ------------------------------------------------------------------

def describe(blanket: str) -> str:
    tok = build(blanket)
    spec = BLANKETS[blanket]
    lines = [f"{spec.short}, {spec.name}: {spec.basis}"]
    lines.append(f"  {'layer':16s} {'inboard':>8s} {'outboard':>9s}  {'g/cm3':>6s}  volume m3  material")
    for layer in tok.layers:
        m = layer.material
        where = ""
        if layer.leg:
            where = f" (inboard only; the vertical leg, the arms above and below it {tok.volumes[layer.name + '_arms'] / 1e6:.1f} m3)"
        elif layer.inboard_only:
            where = " (inboard only)"
        lines.append(f"  {layer.name:16s} {layer.inboard:8.1f} {layer.outboard:9.1f}  "
                     f"{(m.density if m else 0.0):6.3f}  {tok.volumes[layer.name] / 1e6:9.1f}  "
                     f"{m.name if m else 'void'}{where}")
    zones = [("first wall", spec.first_wall), ("breeder zone", spec.breeder_zone), ("manifolds and BSS", spec.back)]
    if spec.shield:
        zones.append(("shield block", spec.shield[1]))
    for zone, parts in zones:
        void = 1.0 - sum(parts.values())
        shares = ", ".join(f"{k} {100 * v:.1f}%" for k, v in parts.items())
        lines.append(f"  {zone}: {shares}{f', void {100 * void:.1f}%' if void > 1e-9 else ''}")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--plot", choices=sorted(BLANKETS), help="save xz and xy slices of this blanket's model")
    parser.add_argument("--out", type=pathlib.Path, default=pathlib.Path("."), help="where the slices go")
    args = parser.parse_args()
    for key in BLANKETS:
        print(describe(key))
        print()
    print(f"plasma-facing area {first_wall_area() / 1e4:.0f} m2, {source_rate():.4g} neutrons/s at "
          f"{FUSION_POWER_MW:.0f} MW")
    if args.plot:
        tok = build(args.plot)
        extent = 2 * (HALL_RADIUS + BIOSHIELD)
        height = 2 * (HALL_HALF_HEIGHT + BIOSHIELD)
        args.out.mkdir(parents=True, exist_ok=True)
        for basis, width in [("xz", (extent, height)), ("xy", (extent, extent))]:
            plot = tok.geometry.plot(origin=(0.0, 0.0, 0.0), width=width, basis=basis, color_by="material",
                                     outline="cell", axis_units="m", resolution=(1200, round(1200 * width[1] / width[0])))
            path = args.out / f"tokamak_{args.plot}_{basis}.png"
            plot.save(str(path))
            print(f"wrote {path}")


if __name__ == "__main__":
    main()
