#!/bin/sh
# Compiles the AI layer to plain CJS so the custom-gateway tests can run
# without a full Next.js build (useful in constrained environments).
#
# Usage:
#   sh tests/custom-gateway/build.sh
#   node tests/custom-gateway/envelope.cjs
#   node tests/custom-gateway/security.cjs
#   node tests/custom-gateway/integration.cjs "a small stone tower"
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$ROOT/.btest"
TSC="$ROOT/node_modules/typescript/bin/tsc"

if [ ! -f "$TSC" ]; then
  echo "typescript not found at $TSC — install dependencies first" >&2
  exit 1
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
    "esModuleInterop": true,
    "module": "commonjs",
    "moduleResolution": "node",
    "resolveJsonModule": true,
    "typeRoots": ["$ROOT/node_modules/@types"],
    "types": ["node"],
    "baseUrl": "$ROOT",
    "paths": { "@/*": ["./*"] }
  },
  "files": ["$ROOT/lib/ai/generateVoxelBuild.ts"]
}
EOF

rm -rf "$OUT"
# tsc can abort mid-emit under tight memory (observed in iSH/Alpine sandboxes),
# exiting 0 having written nothing. Retry until the expected output appears.
ATTEMPT=0
while [ "$ATTEMPT" -lt 6 ]; do
  ATTEMPT=$((ATTEMPT + 1))
  node --max-old-space-size="${MB_TSC_HEAP:-1024}" "$TSC" -p "$CFG" >/dev/null 2>&1 || true
  if [ -f "$OUT/ai/providers/customGateway.js" ]; then
    break
  fi
  rm -rf "$OUT"
done
rm -f "$CFG"

# lib/benchmark/prompts.ts is not in generateVoxelBuild's import graph, so tsc's
# rootDir inference drops it. Emit it separately with rootDir pinned to lib/.
CFG2=$(mktemp)
cat > "$CFG2" <<EOF2
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
    "typeRoots": ["$ROOT/node_modules/@types"],
    "types": ["node"],
    "baseUrl": "$ROOT",
    "paths": { "@/*": ["./*"] }
  },
  "files": ["$ROOT/lib/benchmark/prompts.ts"]
}
EOF2
ATTEMPT=0
while [ "$ATTEMPT" -lt 6 ]; do
  ATTEMPT=$((ATTEMPT + 1))
  node --max-old-space-size="${MB_TSC_HEAP:-1024}" "$TSC" -p "$CFG2" >/dev/null 2>&1 || true
  if [ -f "$OUT/benchmark/prompts.js" ]; then
    break
  fi
done
rm -f "$CFG2"

# resolveJsonModule emits no JSON, so copy the data files the runtime needs.
mkdir -p "$OUT/blocks" "$OUT/ai"
cp "$ROOT/lib/blocks/palettes.json" "$OUT/blocks/" 2>/dev/null || true
cp "$ROOT/lib/blocks/atlas-map.json" "$OUT/blocks/" 2>/dev/null || true
cp "$ROOT/lib/blocks/block-colors.generated.json" "$OUT/blocks/" 2>/dev/null || true
cp "$ROOT/lib/ai/modelBenchmarkMetrics.generated.json" "$OUT/ai/" 2>/dev/null || true

if [ -f "$OUT/ai/providers/customGateway.js" ]; then
  echo "built -> $OUT"
else
  echo "build produced no gateway output" >&2
  exit 1
fi
