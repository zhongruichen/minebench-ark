#!/bin/sh
# Reproduces the structured-output experiment matrix in docs/CUSTOM_PROVIDER.md §1.2.
#
# Determines whether a gateway ACTUALLY implements response_format, or merely
# shape-validates it and ignores the schema (as Ark's /api/plan/v3 does).
#
# Usage:
#   CUSTOM_API_KEY=... CUSTOM_API_BASE_URL=... sh scripts/probe-structured-output.sh
# Falls back to .env.local when the vars are unset.
set -u

if [ -z "${CUSTOM_API_KEY:-}" ] && [ -f .env.local ]; then
  CUSTOM_API_KEY=$(sed -n 's/^CUSTOM_API_KEY=//p' .env.local | head -1)
  CUSTOM_API_BASE_URL=${CUSTOM_API_BASE_URL:-$(sed -n 's/^CUSTOM_API_BASE_URL=//p' .env.local | head -1)}
  CUSTOM_API_MODEL_ID=${CUSTOM_API_MODEL_ID:-$(sed -n 's/^CUSTOM_API_MODEL_ID=//p' .env.local | head -1)}
fi
: "${CUSTOM_API_KEY:?set CUSTOM_API_KEY}"
: "${CUSTOM_API_BASE_URL:?set CUSTOM_API_BASE_URL}"
MODEL=${CUSTOM_API_MODEL_ID:-ark-code-latest}

URL=$(echo "$CUSTOM_API_BASE_URL" | sed 's#/*$##')
case "$URL" in *chat/completions) ;; *) URL="$URL/chat/completions" ;; esac

post() {
  curl -s -m 120 -X POST "$URL" \
    -H "Authorization: Bearer $CUSTOM_API_KEY" \
    -H "Content-Type: application/json" \
    -H "User-Agent: ${CUSTOM_API_USER_AGENT:-Kelivo}" \
    -d "$1"
}
show() {
  code=$(echo "$1" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p' | head -1)
  if [ -n "$code" ]; then
    echo "    -> ERROR $code"
    echo "$1" | sed -n 's/.*"message":"\([^"]*\)".*/       \1/p' | head -1 | cut -c1-200
  else
    echo "$1" | sed -n 's/.*"content":"\([^"]*\)".*/    -> \1/p' | head -1 | cut -c1-200
  fi
}

SCHEMA='{"type":"json_schema","json_schema":{"name":"pt","strict":true,"schema":{"type":"object","properties":{"x":{"type":"integer"},"y":{"type":"integer"}},"required":["x","y"],"additionalProperties":false}}}'
Q='Give me a point with x and y.'

echo "endpoint: $URL"
echo "model   : $MODEL"
echo

echo "[1] json_schema (strict)"
show "$(post "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$Q\"}],\"max_tokens\":300,\"response_format\":$SCHEMA}")"

echo "[2] json_object"
show "$(post "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$Q Reply in json.\"}],\"max_tokens\":300,\"response_format\":{\"type\":\"json_object\"}}")"

echo "[3] prompt-only (no response_format)"
show "$(post "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Return the point (3,5) as JSON with integer keys x and y. Output ONLY the JSON object, no fence, no prose.\"}],\"max_tokens\":300}")"

echo
echo "[4] is response_format parsed at all? (send a string -- must 400)"
show "$(post "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":16,\"response_format\":\"not-an-object\"}")"

echo "[5] does an UNSUPPORTED schema keyword error? (docs say it should)"
BAD='{"type":"json_schema","json_schema":{"name":"bad","strict":true,"schema":{"type":"object","properties":{"x":{"type":"integer","multipleOf":7}},"required":["x"],"additionalProperties":false,"patternProperties":{"^z":{"type":"string"}}}}}'
show "$(post "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$Q\"}],\"max_tokens\":300,\"response_format\":$BAD}")"

echo "[6] are made-up params silently accepted? (guided_json)"
show "$(post "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":16,\"guided_json\":{\"type\":\"object\"}}")"

echo
echo "Reading the result:"
echo "  [4] errors but [1] returns prose  => shape-validated, NOT implemented"
echo "                                       -> leave structured output OFF"
echo "  [1] returns strict JSON           => genuinely supported"
echo "                                       -> enable customGatewayStructuredOutput"
