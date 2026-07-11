#!/usr/bin/env bash
# Stage the RO-mounted concord code into the SDK-resolvable /app layout, then run the
# pipeline. Copy (not run-in-place) so /app/node_modules is an ancestor of the code
# (ESM bare-specifier resolution ignores NODE_PATH). node_modules from the host mount
# is dropped -- the image's own /app/node_modules (correct arch) is used.
set -euo pipefail
mkdir -p /app/services /app/plugins
cp -r /concord-ro/services/agent-team /app/services/agent-team
cp -r /concord-ro/plugins/concord /app/plugins/concord
# The concord plugin is CommonJS (review-cli.js uses require), but /app/package.json is
# type:module and would make Node treat the staged .js as ESM. Declare the plugin subtree
# CommonJS explicitly so review-cli runs.
echo '{"type":"commonjs"}' > /app/plugins/concord/package.json
rm -rf /app/services/agent-team/node_modules
git config --global --add safe.directory '*'
exec node /app/services/agent-team/bin/agent-team-run.mjs "$@"
