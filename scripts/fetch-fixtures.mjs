// Download the nuclear data the Python tab's checks in verify.mjs run
// against, into the layout serve.mjs reads (`<dir>/<Name>.arrow/<section>`,
// and the transmutation chain's subsections under
// `<dir>/transmutation/<subsection>.arrow/<section>`).
//
// Adapted from yamc-online's scripts/fetch-fixtures.mjs.
//
//   node scripts/fetch-fixtures.mjs [dir]      (default: .fixtures)
//
// For CI, which has no core checkout: serve.mjs reads core's fixtures first
// and .fixtures/ second. These are the objects of the current published
// release, byte for byte, each checked against the release manifest's sha256.
// Only the sections an activation load reads are fetched.
//
// The form's own checks in verify.mjs do not read these: they need core's
// fixtures, in core's layout, and skip the run without them.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://yamc-data.xsplot.com/endf-b8.1";
// The examples' materials: Fe56 for the iron, and natural lithium with the
// H2, H3 and He3 its chain reaches. The rest of iron's closure is left out,
// which the solver tolerates for daughters (they decay, but do not react).
export const NEUTRON = ["Fe56", "Li6", "Li7", "H2", "H3", "He3"];
export const TRANSMUTATION = ["decay", "reactions", "fission_yields", "branching"];
const SECTIONS = {
  neutron: ["version.json", "nuclide.arrow", "energy.arrow", "reactions.arrow"],
  // Keyed by subsection.
  decay: ["nuclides.arrow", "decay_modes.arrow", "sources.arrow", "provenance.json"],
  reactions: ["reactions.arrow", "provenance.json"],
  fission_yields: ["fission_yields.arrow", "aliases.arrow", "evaluated_yields.arrow", "provenance.json"],
  branching: ["branching.arrow", "branching_covariance.arrow", "provenance.json"],
};

// verify.mjs imports the lists above; only a direct run downloads.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || ".fixtures";
  let total = 0;
  const getJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  };
  // The CDN caches latest.json, and can go on serving a pointer to a release
  // that has since been deleted. A query string it has not seen is answered
  // by the origin, as core's scripts/fetch_test_fixtures.py asks. The
  // release's own files never change, so they are fetched as published.
  const { release } = await getJson(`${ORIGIN}/latest.json?release-check=${Date.now()}`);
  const manifest = await getJson(`${ORIGIN}/${release}/manifest.json`);
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  const wanted = [
    ...NEUTRON.map((name) => [`neutron/${name}.arrow`, name, SECTIONS.neutron]),
    ...TRANSMUTATION.map((sub) => [`transmutation/${sub}.arrow`, join("transmutation", sub), SECTIONS[sub]]),
  ];
  for (const [folder, local, sections] of wanted) {
    const target = join(dir, `${local}.arrow`);
    await mkdir(target, { recursive: true });
    for (const section of sections) {
      // An optional section this release does not publish is not listed.
      const entry = listed.get(`${folder}/${section}`);
      if (!entry) continue;
      const url = `${ORIGIN}/${release}/${entry.path}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (createHash("sha256").update(body).digest("hex") !== entry.sha256) throw new Error(`${url}: not what the manifest lists`);
      await writeFile(join(target, section), body);
      total += body.length;
    }
  }
  console.log(`${NEUTRON.join(", ")} and the transmutation chain of release ${release} into ${dir}: ${(total / 1048576).toFixed(1)} MB`);
}
