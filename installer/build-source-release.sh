#!/bin/sh
# Builds a reproducible source archive of a committed revision, for people who download
# instead of cloning:  release/astra-bridge-<version>-<commit>.tar.gz  plus a .sha256 file.
#
# The archive is plain source. It is NOT signed or notarized, and it is not a .pkg (see
# installer/README.md, "Distribution and signing"). Users check it against the published
# checksum:  shasum -a 256 -c astra-bridge-<version>-<commit>.tar.gz.sha256
#
# Usage: installer/build-source-release.sh [<git revision, default HEAD>] [--out <dir>]
set -eu

rev=HEAD
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || { echo "--out needs a directory" >&2; exit 2; }; out="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) rev="$1"; shift ;;
  esac
done

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
out=${out:-$root/release}
commit=$(git -C "$root" rev-parse --verify "$rev^{commit}")
short=$(printf %s "$commit" | cut -c1-12)
version=$(git -C "$root" show "$commit:installer/package.json" 2>/dev/null | sed -n 's/^  "version": "\(.*\)",$/\1/p')
name="astra-bridge-${version:-0}-$short"

mkdir -p "$out"
# git archive gives every entry the commit's time and a fixed owner, and gzip -n leaves out the
# file name and time, so one commit always produces the same bytes (with the same git version).
git -C "$root" archive --format=tar --prefix="$name/" "$commit" | gzip -n -9 > "$out/$name.tar.gz"
(cd "$out" && shasum -a 256 "$name.tar.gz" > "$name.tar.gz.sha256")

if [ "$rev" = HEAD ] && [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "note: uncommitted changes are not in the archive; it holds commit $short only" >&2
fi
cat "$out/$name.tar.gz.sha256"
