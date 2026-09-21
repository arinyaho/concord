#!/usr/bin/env node
'use strict';
const cli = require('../engine/review-cli');
const { resolveStateDir } = require('../engine/statedir');

module.exports = cli;
if (require.main === module) cli.runMain(() => resolveStateDir(process.cwd(), process.env));