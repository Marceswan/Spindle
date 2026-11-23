#!/usr/bin/env bash
# Runs in the empty workspace of the eval run: one SFDX project at the root, two nested
# projects, and a dependency folder that has a manifest but is not a project to index.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/../_shared/scaffold-sample.sh" "$here"
for nested in packages/billing tools/legacy-org; do
  mkdir -p "$nested"
  (cd "$nested" && bash "$here/../_shared/scaffold-sample.sh" "$here")
done
mkdir -p node_modules/some-pkg docs
echo '{"packageDirectories":[{"path":"force-app"}]}' > node_modules/some-pkg/sfdx-project.json
echo "# Notes" > docs/readme.md
