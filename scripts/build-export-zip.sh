#!/usr/bin/env bash
# Build a shareable zip of the context-warp package.
#
# Produces a standalone, copy-and-go zip from this package (override the source
# with PKG=/path). Strips build/artifact dirs, regenerates FILE-LIST.txt, and
# emits a top-level context-warp/ folder.
#
# Usage:  ./scripts/build-export-zip.sh [OUT.zip]
set -euo pipefail

PKG="${PKG:-$(cd "$(dirname "$0")/.." && pwd)}"
OUT="${1:-/home/jonah/exports/context-warp.zip}"

cd "$PKG"

echo "── regenerate FILE-LIST.txt ──"
find . -type f \
  -not -path './node_modules/*' \
  -not -path './dist/*' \
  -not -path './.atlas/*' \
  -not -path './.git/*' \
  -not -name '*.sqlite' -not -name '*.sqlite-*' \
  -not -name '*.tsbuildinfo' \
  -not -name 'FILE-LIST.txt' \
  | sed 's|^\./||' | sort > FILE-LIST.txt
echo "$(wc -l < FILE-LIST.txt) files listed"

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

python3 - "$PKG" "$OUT" <<'PYEOF'
import sys, os, zipfile
pkg, out = sys.argv[1], sys.argv[2]
root_name = os.path.basename(pkg)          # -> context-warp/ as the zip's top dir
parent = os.path.dirname(pkg)
EXCLUDE_DIRS = {'node_modules', 'dist', '.atlas', '.git'}

def excluded_file(name: str) -> bool:
    return name.endswith('.tsbuildinfo') or '.sqlite' in name

os.chdir(parent)
count = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirnames, filenames in os.walk(root_name):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for f in sorted(filenames):
            if excluded_file(f):
                continue
            z.write(os.path.join(dirpath, f))
            count += 1
print(f"zipped {count} entries -> {out}")
PYEOF

python3 -m zipfile -t "$OUT" >/dev/null && echo "zip integrity OK"
ls -lh "$OUT"

cat <<EOF

── Share via Google Drive (forge drive-push) ──
   forge_call server=drive-push tool=push  args={"files":["$OUT"]}
   forge_call server=drive-push tool=link  args={"name":"$(basename "$OUT")"}
EOF
