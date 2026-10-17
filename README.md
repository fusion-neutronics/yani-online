# yani-online

### Online web app [fusion-neutronics.github.io/yani-online](https://fusion-neutronics.github.io/yani-online/)

[YANI](https://github.com/fusion-neutronics/yani) **Y**et **A**nother **N**uclide **I**nventory in the browser.
Build a material, build an irradiation and cooling schedule, run a real transmutation, and read back inventory, activity, decay heat, contact dose rate and decay photon lines.

The solver is the same Rust that ships in the `yani` wheel, compiled to
WebAssembly. Cross sections are continuous-energy -- nothing is collapsed to a
multigroup approximation to make it fit -- so a browser run and a `pip install
yani` run give the same answer.

Nothing is installed and nothing is uploaded: the page is one self-contained
file that runs the solve locally, and nuclear data is the only thing it fetches
-- and only the reaction channels the chain actually names, at the one
temperature the material is at, in byte ranges out of the published files rather
than the files themselves, which is about thirty times less to download for the
same answer.

## Python in the browser

The **Python** tab beside the form is an editor that runs `yani` scripts in
the page, on [Pyodide](https://pyodide.org): the `yani-core` wheel itself,
installed from PyPI, so a script there is a script that runs under
`pip install yani`. It covers what the form does not: loops over materials or
schedules, custom post-processing, anything the API can do. Figures from
plotly or matplotlib, and anything with a rich display such as a `Material`,
are drawn beside the editor. **Open it in the Python tab** turns the form's
setup into a script there; **Share** puts the script in a link.

Nothing of it loads until the tab is first opened, so the form starts as fast
as it always has. The tab needs the page served over http(s): it works on the
published page, not on a copy opened from a file.

## The same solver, locally

The Python package is the same solver without the browser's constraints --
scriptable, and against data already on disk rather than fetched per run:

```
pip install yani
```

The [documentation](https://fusion-neutronics.github.io/yani/) covers the API.
**Download this setup as Python** on the page writes the material, the data
sources, the spectrum and the schedule out as a script that reproduces them,
with the same plots.

## Development

See [dev-readme.md](dev-readme.md) for how the page is built and vendored, where
the solve runs, what each browser engine does, and where the nuclear data comes
from.

## Licence

Dual-licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

The vendored solver in `vendor/` is built from
[fusion-neutronics/core](https://github.com/fusion-neutronics/core) and carries
the same dual licence.
