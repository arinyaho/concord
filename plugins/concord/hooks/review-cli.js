'use strict';
const cli = require('../core/review-cli.js');
const { resolveStateDirFromCwd } = require('../adapters/claude-code/statedir');
module.exports = cli;
if (require.main === module) cli.runMain(resolveStateDirFromCwd);
