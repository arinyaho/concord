'use strict';
// Codex entrypoint shim over the vendored engine (self-contained; see bin/bundle.mjs).
const cli = require('../engine/review-cli.js');
const { resolveStateDirFromCwd } = require('../engine/statedir');
module.exports = cli;
if (require.main === module) cli.runMain(resolveStateDirFromCwd);
