# Lithium breeding: a litre of natural lithium irradiated for 30 days in a
# fusion-like neutron spectrum, then left to cool. Prints the tritium and
# helium made, and the activity and decay heat with the nuclide leading each.
# Lithium's transmutation chain stays among H, He and Li, so the first run
# fetches about 20 MB of nuclear data, most of it the decay data.
import plotly.graph_objects as go

import yani

# The cross sections, and the parts of the transmutation chain, from one
# library.
yani.cross_section_data = "endf-b8.1"
yani.transmutation_decay_data = "endf-b8.1"
yani.transmutation_reactions = "endf-b8.1"
yani.transmutation_fission_yields = "endf-b8.1"

lithium = yani.Material(
    {"Li6": 0.0759, "Li7": 0.9241}, 0.534, volume=1000.0, temperature=294, name="lithium"
)

# A 14 MeV peak over a slowed-down tail. Edges in eV, and the share of the
# flux in each bin.
edges = [1e-5, 0.625, 1e3, 1e5, 1e6, 1e7, 13.5e6, 14.5e6]
shares = [0.05, 0.10, 0.15, 0.20, 0.15, 0.05, 0.30]
spectrum = yani.NeutronSource(energy=yani.sources.Histogram(edges, shares))

# A pulse's rate is the total flux, in neutrons per cm^2 per second. A
# cooldown is decay alone.
schedule = yani.PulseSchedule([
    yani.Pulse(rate=1e14, duration=(30, "d"), source=spectrum),
    yani.Cooldown(duration=(1, "min")),
    yani.Cooldown(duration=(1, "d")),
    yani.Cooldown(duration=(1, "a")),
])
results = lithium.transmute(schedule=schedule)

material_id = lithium.id or 0
gas = results.get_gas_production(material_id)
print(f"Tritium made: {gas['H3'][1]:.1f} appm, helium-4: {gas['He4'][1]:.1f} appm")

print("\nAfter                     Activity (Bq)   Decay heat (W)   Largest")
labels = ["30 days of irradiation", "1 minute of cooling", "1 day more", "1 year more"]
steps = results.step_materials(material_id)
for label, material in zip(labels, steps):
    by_nuclide = material.activity(by_nuclide=True)
    top = max(by_nuclide, key=by_nuclide.get)
    print(f"{label:24s} {material.activity():14.4e} {material.decay_heat():14.4e}   {top}")

figure = go.Figure(go.Bar(x=labels, y=[m.decay_heat() for m in steps]))
figure.update_layout(title="Decay heat of the lithium", yaxis={"title": "decay heat [W]", "type": "log"})
figure
