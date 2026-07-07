---
description: Show or update the project task charter (north-star framing + merged decisions)
argument-hint: "[set <text> | pin]"
---

The charter CLI lives at `${CLAUDE_PLUGIN_ROOT}/hooks/charter-cli.js`.

Arguments: `$ARGUMENTS`

Do exactly one of:

- If the arguments are empty or start with `show`: run
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/charter-cli.js" show`
  and display its output verbatim to the user.

- If the arguments start with `set `, the new north-star is the text after `set `. If the arguments are `pin`, the new north-star is the user's immediately-preceding message in this conversation. In BOTH cases, do NOT embed that text in a shell command — it may contain quotes, `$()`, or backticks (a shell-injection surface). Instead: (1) write the north-star text to a temp file with the Write tool, e.g. `/tmp/charter-new.txt`; (2) run `node "${CLAUDE_PLUGIN_ROOT}/hooks/charter-cli.js" set < /tmp/charter-new.txt`. The CLI reads the north-star from stdin, so the user text never passes through shell quoting. Confirm the update in one line.

Keep it to the single command execution and a one-line confirmation. Do not editorialize.
