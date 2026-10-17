#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 ]]; then
  echo 'Usage: bash scripts/generate-timezones.sh <libical-checkout> <iana-checkout>' >&2
  exit 1
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
libical_dir="$(cd -- "$1" && pwd)"
iana_dir="$(cd -- "$2" && pwd)"
test "$(git -C "$libical_dir" rev-parse HEAD)" = 0dec1575bc81de232b8bea18f5d9c22fbc0daa12
test "$(git -C "$iana_dir" rev-parse HEAD)" = 039ef27cc5f062a2055cb67435d6d71adbefd27d
git -C "$libical_dir" diff --quiet HEAD -- vzic
git -C "$iana_dir" diff --quiet HEAD
glib_flags="${GLIB_CFLAGS:-$(pkg-config --cflags glib-2.0)}"
glib_libraries="${GLIB_LDADD:-$(pkg-config --libs glib-2.0)}"
# Rebuild even if a previous binary used a different TZID prefix/configuration.
make -B -C "$libical_dir/vzic" GLIB_CFLAGS="$glib_flags" GLIB_LDADD="$glib_libraries" TZID_PREFIX=
generated_dir="$(mktemp -d)"
trap 'rm -rf -- "$generated_dir"' EXIT
"$libical_dir/vzic/vzic" --pure --no-rrules --no-rdates --olson-dir "$iana_dir" --output-dir "$generated_dir"
node "$script_dir/extract-timezones.mjs" "$generated_dir"
