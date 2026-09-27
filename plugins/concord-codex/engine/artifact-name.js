'use strict';

// Finding ids look like `correctness:login-errors` and are embedded in artifact
// filenames. `:` and the other characters below are illegal in Windows filenames
// (a `:` even creates an NTFS alternate data stream or an unreadable path), so
// every site that builds a filename from an id must go through this helper.
// Only Windows-illegal characters are replaced, so non-ASCII slugs stay distinct.
function safeIdForFilename(id) {
  return String(id).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

module.exports = { safeIdForFilename };
