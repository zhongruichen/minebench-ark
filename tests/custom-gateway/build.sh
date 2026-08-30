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
node "$TSC" -p "$CFG" || true
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
node "$TSC" -p "$CFG2" || true
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
