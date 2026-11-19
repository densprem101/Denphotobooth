#!/bin/sh
# Runs the cloud self-tests (Node 22+). From the site folder:   sh cloud/tests/run-tests.sh
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; TMP="$(mktemp -d)"
cp "$ROOT/_worker.js" "$TMP/worker.mjs"
export DEN_ROOT="$ROOT" DEN_WORKER="$TMP/worker.mjs"
node --no-warnings "$ROOT/cloud/tests/worker.test.mjs"
node --no-warnings "$ROOT/cloud/tests/module.test.mjs"
