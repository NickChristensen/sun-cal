# Reproducing the timezone assets

`src/data/timezones.json` contains 344 deduplicated VTIMEZONE components and 597
names/aliases. `timezones-manifest.json` records sizes, SHA256, source commits and
options. Runtime conversion uses matching `moment-timezone@0.6.5` (IANA 2026e)
and `moment@2.31.0`. Update these dependencies and both generated files together.
The runtime refuses mismatched conversion/asset IANA versions. Asset digest
participates in named cache keys.

Prerequisites: `npm ci`, Git, C compiler, make, pkg-config and GLib development
headers/libraries. Check out sources outside the application checkout:

```sh
git clone https://github.com/libical/libical.git /tmp/sun-cal-libical
git -C /tmp/sun-cal-libical checkout 0dec1575bc81de232b8bea18f5d9c22fbc0daa12
git clone https://github.com/eggert/tz.git /tmp/sun-cal-iana
git -C /tmp/sun-cal-iana checkout 039ef27cc5f062a2055cb67435d6d71adbefd27d
bash scripts/generate-timezones.sh /tmp/sun-cal-libical /tmp/sun-cal-iana
```

The IANA commit is the exact 2026e release tag. The script verifies source pins
and tracked cleanliness, rebuilds with an empty TZID prefix, and generates
`--pure --no-rrules --no-rdates` output in a temporary directory. `GLIB_CFLAGS`
and `GLIB_LDADD` can override pkg-config when using locally extracted headers.
No runtime filesystem access or generator dependency is needed.

`extract-timezones.mjs` sorts paths, resolves alias symlinks, extracts only the
matching VTIMEZONE and omits optional LAST-MODIFIED build timestamps. Identical
pinned inputs regenerate identical bytes, without manual rule edits. Current
JSON: 4,079,120 bytes / 165,245 gzip bytes. The actual Worker additionally bundles
conversion code/data; measure it with the normal dry-run build. A feed includes
only its selected component.

Structural coverage: 2006-01-01 inclusive through 2088-01-01 exclusive UTC. The
lower bound follows the latest first explicit onset (Antarctica/Troll,
2005-02-12). Vzic expands unbounded rules through maximum Zone UNTIL year plus
two; these inputs' 105 recurring components end in 2088. Never treat the last
offset as an indefinite tail. Regeneration must revisit the runtime guard,
transition-boundary equivalence, aliases, fixtures, and cache namespace if
serialization changes. Legislation may require earlier updates.

IANA timezone data is public domain, with details in upstream LICENSE. Vzic is
a build-time GPL-2.0-or-later tool; its source is not bundled into the Worker.
Moment and Moment Timezone carry upstream MIT licenses in the pinned packages.
