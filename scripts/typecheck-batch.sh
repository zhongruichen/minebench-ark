#!/bin/sh
# Typechecks changed files in small batches.
#
# Full-project `tsc` needs more memory than some sandboxes allow (the compiler
# aborts without a diagnostic), so this walks a file list one entry at a time.
# Each invocation still resolves the whole import graph of that file, so type
# errors in the modules it touches are caught.
#
# Usage: sh scripts/typecheck-batch.sh [file ...]
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

TSC="$ROOT/node_modules/typescript/bin/tsc"
if [ ! -f "$TSC" ] && [ -n "${TS_PREFIX:-}" ]; then
  TSC="$TS_PREFIX/node_modules/typescript/bin/tsc"
fi
if [ ! -f "$TSC" ]; then
  echo "typescript not found (set TS_PREFIX or install dependencies)" >&2
  exit 1
fi

if [ "$#" -gt 0 ]; then
  FILES="$*"
else
  FILES="
lib/ai/userAgent.ts
lib/ai/providerConfig.ts
lib/ai/providerRequest.ts
lib/ai/providerConfigSchema.ts
lib/ai/providerStore.ts
lib/ai/providers/configuredProvider.ts
lib/ai/providers/customApiGuard.ts
lib/ai/types.ts
"
fi

FAILED=""
for FILE in $FILES; do
  [ -n "$FILE" ] || continue
  CFG=$(mktemp)
  cat > "$CFG" <<EOF
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "jsx": "preserve",
    "typeRoots": ["$ROOT/node_modules/@types"],
    "types": ["node", "react"],
    "baseUrl": "$ROOT",
    "paths": { "@/*": ["./*"] }
  },
  "files": ["$ROOT/$FILE"]
}
EOF
  OUT=$(node "$TSC" -p "$CFG" 2>&1 | grep -v '^Warning: disabling flag' || true)
  rm -f "$CFG"

  REAL=$(printf '%s\n' "$OUT" | grep -v '^[[:space:]]*$' || true)
  if [ -n "$REAL" ]; then
    echo "FAIL  $FILE"
    printf '%s\n' "$REAL" | sed 's/^/      /'
    FAILED="$FAILED $FILE"
  else
    echo "PASS  $FILE"
  fi
done

if [ -n "$FAILED" ]; then
  echo ""
  echo "Type errors in:$FAILED"
  exit 1
fi
echo ""
echo "All checked files passed."
