#!/usr/bin/env bash
# Runs in the empty workspace of the eval run.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/../_shared/scaffold-sample.sh" "$here"
