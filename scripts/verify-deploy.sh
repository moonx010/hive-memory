#!/bin/bash
# Post-deploy verification script
# Usage: ./scripts/verify-deploy.sh [url] [auth_token]

URL="${1:-https://vibrant-presence-production-cf0a.up.railway.app}"
TOKEN="${2:-$CORTEX_AUTH_TOKEN}"
MAX_RETRIES=10
RETRY_DELAY=15

echo "🔍 Verifying deployment at $URL..."

# 1. Health check with retries
for i in $(seq 1 $MAX_RETRIES); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$URL/health" 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo "✅ Health check passed (attempt $i)"
    break
  fi
  if [ "$i" = "$MAX_RETRIES" ]; then
    echo "❌ Health check FAILED after $MAX_RETRIES attempts (status: $STATUS)"
    exit 1
  fi
  echo "⏳ Health check attempt $i/$MAX_RETRIES (status: $STATUS), retrying in ${RETRY_DELAY}s..."
  sleep $RETRY_DELAY
done

# 2. MCP initialize test
INIT_RESULT=$(curl -s "$URL/" -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"verify","version":"1.0"}}}' 2>&1)

if echo "$INIT_RESULT" | grep -q "cortex"; then
  echo "✅ MCP initialize passed"
else
  echo "❌ MCP initialize FAILED: $INIT_RESULT"
  exit 1
fi

# 3. Tool list check
TOOLS_RESULT=$(curl -s "$URL/" -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' 2>&1)

TOOL_COUNT=$(echo "$TOOLS_RESULT" | grep -o '"name"' | wc -l | tr -d ' ')
if [ "$TOOL_COUNT" -ge 30 ]; then
  echo "✅ Tools loaded: $TOOL_COUNT"
else
  echo "❌ Expected 30+ tools, got $TOOL_COUNT"
  exit 1
fi

echo ""
echo "🎉 Deployment verified successfully!"
echo "   URL: $URL"
echo "   Tools: $TOOL_COUNT"
