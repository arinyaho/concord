'use strict';
// Codex charter-cli entrypoint over the vendored engine (self-contained).
const cli = require('../engine/charter-cli.js');
const { resolveStateDirFromCwd } = require('../engine/statedir');
module.exports = cli;
if (require.main === module) cli.runMain(resolveStateDirFromCwd);
