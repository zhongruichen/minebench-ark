#!/bin/sh
# Compiles the configured-provider layer to CJS so it can be exercised without a
# full Next.js build (useful in constrained environments / CI smoke checks).
#
# Usage:
#   sh tests/custom-gateway/build-configured.sh
#   node tests/custom-gateway/configured-provider.cjs
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$ROOT/.btest-configured"

# typescript may live in the project or in an external prefix (constrained envs).
TSC="$ROOT/node_modules/typescript/bin/tsc"
if [ ! -f "$TSC" ] && [ -n "${TS_PREFIX:-}" ]; then
  TSC="$TS_PREFIX/node_modules/typescript/bin/tsc"
fi
if [ ! -f "$TSC" ]; then
  echo "typescript not found (set TS_PREFIX or install dependencies)" >&2
  exit 1
fi

TYPES_DIR="$ROOT/node_modules/@types"
if [ ! -d "$TYPES_DIR" ] && [ -n "${TS_PREFIX:-}" ]; then
  TYPES_DIR="$TS_PREFIX/node_modules/@types"
fi

CFG=$(mktemp)
cat > "$CFG" <<EOF
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "esnext"],
    "skipLibCheck": true,
    "strict": true,
    "noEmitOnError": false,
    "outDir": "$OUT",
    "rootDir": "$ROOT/lib",
    "esModuleInterop": true,
    "module": "commonjs",
    "moduleResolution": "node",
    "resolveJsonModule": true,
    "typeRoots": ["$TYPES_DIR"],
    "types": ["node"],
    "baseUrl": "$ROOT",
    "paths": { "@/*": ["./*"] }
  },
  "files": [
    "$ROOT/lib/ai/providers/configuredProvider.ts",
    "$ROOT/lib/ai/providerRequest.ts",
    "$ROOT/lib/ai/providerConfig.ts"
  ]
}
EOF

rm -rf "$OUT"
# tsc can abort mid-emit under tight memory (observed in iSH/Alpine sandboxes):
# it exits 0 having written nothing. Retry with a bounded heap until the
# expected output appears rather than reporting a phantom build failure.
ATTEMPT=0
while [ "$ATTEMPT" -lt 6 ]; do
  ATTEMPT=$((ATTEMPT + 1))
  node --max-old-space-size="${MB_TSC_HEAP:-1024}" "$TSC" -p "$CFG" >/dev/null 2>&1 || true
  if [ -f "$OUT/ai/providers/configuredProvider.js" ]; then
    break
  fi
  rm -rf "$OUT"
done
rm -f "$CFG"

if [ -f "$OUT/ai/providers/configuredProvider.js" ]; then
  echo "built -> $OUT"
else
  echo "build produced no configured-provider output" >&2
  exit 1
fi
