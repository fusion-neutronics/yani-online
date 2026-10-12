# Iron activation: a litre of Fe-56 irradiated for a year in a fusion-like
# neutron spectrum, then cooled for ten years. Prints the activity and decay
# heat at each step with the nuclide leading each, and plots both against time
# after shutdown. The first run fetches the nuclear data for the twenty or so
# nuclides near iron that its transmutation reaches; later runs read it from
# memory.
import plotly.graph_objects as go

import yani

# The cross sections, and the parts of the transmutation chain, from one
# library.
yani.cross_section_data = "endf-b8.1"
yani.transmutation_decay_data = "endf-b8.1"
yani.transmutation_reactions = "endf-b8.1"
yani.transmutation_fission_yields = "endf-b8.1"

iron = yani.Material({"Fe56": 1.0}, 7.874, volume=1000.0, temperature=294, name="iron")

# The spectrum as a histogram: a 14 MeV peak over a slowed-down tail. Edges in
# eV, and the share of the flux in each bin.
edges = [1e-5, 0.625, 1e3, 1e5, 1e6, 1e7, 13.5e6, 14.5e6]
shares = [0.05, 0.10, 0.15, 0.20, 0.15, 0.05, 0.30]
spectrum = yani.NeutronSource(energy=yani.sources.Histogram(edges, shares))

# A year at 1e14 n/cm^2/s, then cooling steps whose cumulative times run
# log-evenly from a second to ten years after shutdown.
schedule = yani.PulseSchedule(
    [yani.Pulse(rate=1e14, duration=(1, "a"), source=spectrum)]
    + yani.cooldown_steps((1, "s"), (10, "a"), 10)
)
results = iron.transmute(schedule=schedule)

# One material per step, at the end of it: the pulse, then each cooldown.
steps = results.step_materials(iron.id or 0)
YEAR = 365.25 * 86400.0
shutdown = results.times[1]
after = [(t - shutdown) / YEAR for t in results.times[1:]]

print("After shutdown     Activity (Bq)   Decay heat (W)   Largest")
for t, material in zip(after, steps):
    by_nuclide = material.activity(by_nuclide=True)
    top = max(by_nuclide, key=by_nuclide.get)
    print(f"{t:10.3e} a    {material.activity():14.4e}   {material.decay_heat():14.4e}   {top}")

figure = go.Figure()
figure.add_scatter(x=after[1:], y=[m.activity() for m in steps[1:]], name="activity [Bq]")
figure.add_scatter(x=after[1:], y=[m.decay_heat() for m in steps[1:]], name="decay heat [W]", yaxis="y2")
figure.update_layout(
    title="Fe-56 after a year at 1e14 n/cm2/s",
    xaxis={"title": "time after shutdown [years]", "type": "log"},
    yaxis={"title": "activity [Bq]", "type": "log", "exponentformat": "power"},
    yaxis2={"title": "decay heat [W]", "type": "log", "exponentformat": "power", "overlaying": "y", "side": "right"},
    legend={"x": 0.02, "y": 0.02},
)
figure
