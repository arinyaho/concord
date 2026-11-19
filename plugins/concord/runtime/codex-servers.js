'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BARE = /^[A-Za-z0-9_-]+$/;
const UNPARSED = '<unparsed mcp_servers form>';
// The ids of [mcp_servers.<id>] and [mcp_servers.<id>.<sub>] table headers in the user's Codex config.toml. Only
// headers are read, never values. Any other form that defines servers (an [mcp_servers] table, a dotted or inline
// mcp_servers key), and a header-shaped line inside a multi-line string, is reported as UNPARSED, so no value is ever
// printed.
// ponytail: a line scan, not a TOML parser; a comment holding """ or ''' can mislead it, and then it reports UNPARSED.
function configuredServers(env = process.env) {
  let text;
  try { text = fs.readFileSync(path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8'); } catch { return []; }
  const ids = new Set();
  let open = null; // the delimiter of the multi-line string a line is inside
  for (const line of text.split(/\r?\n/)) {
    const header = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(.+?)[ \t]*\][ \t]*(?:#.*)?$/.exec(line);
    if (open && (header || /mcp_servers/.test(line))) ids.add(UNPARSED);
    else if (header) {
      const q = /^("(?:[^"\\]|\\.)*"|'[^']*')/.exec(header[1]);
      ids.add(q ? q[1] : header[1].split('.')[0].trim());
    } else if (/^\s*(\[\s*mcp_servers\s*\]|mcp_servers\s*[.=])/.test(line)) ids.add(UNPARSED);
    for (const [d] of line.matchAll(/"""|'''/g)) {
      if (!open) open = d;
      else if (d === open) open = null;
    }
  }
  // UNPARSED last, after the ids, whatever order the lines came in.
  return [...ids].filter((id) => id !== UNPARSED).concat(ids.has(UNPARSED) ? [UNPARSED] : []);
}

module.exports = { configuredServers, BARE, UNPARSED };
