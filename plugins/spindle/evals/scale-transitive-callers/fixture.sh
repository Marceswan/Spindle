#!/usr/bin/env bash
# Runs in the empty workspace of the eval run. Generates the larger billing project
# (about 200 classes, with known answers and decoys). Needs bun on PATH.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun run "$here/../_shared/scale-project.ts" .
