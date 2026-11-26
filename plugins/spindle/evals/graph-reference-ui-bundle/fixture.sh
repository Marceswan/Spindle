#!/usr/bin/env bash
# Runs in the empty workspace of the eval run. The sample project, plus one React UI bundle
# with the Apex REST classes and the object that the bundle refers to.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/../_shared/scaffold-sample.sh" "$here"
cp -R "$here/../../../../test/fixtures/ui-bundle/." force-app/main/default/
