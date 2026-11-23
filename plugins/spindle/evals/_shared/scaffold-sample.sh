#!/usr/bin/env bash
# Puts a copy of the repository's sample SFDX project into the current directory (the empty
# workspace of an eval run). Each case's fixture.sh calls this with its own directory.
set -euo pipefail
case_dir="$1"
fixture="$(cd "$case_dir/../../../.." && pwd)/test/fixtures/sample-sfdx-project"
if [ ! -f "$fixture/sfdx-project.json" ]; then
  echo "scaffold: sample project not found at $fixture" >&2
  exit 1
fi
cp -R "$fixture/." .
