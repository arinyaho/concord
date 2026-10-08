# Requested PR review command completion

The hosted workflow name is exactly `review <owner>/<repo>#<pr> @ <sha> cmd:<command-id-or->`. The workflow emits it with `run-name: review ${{ inputs.repo }}#${{ inputs.pr }} @ ${{ inputs.sha }} cmd:${{ inputs.cmd_id || '-' }}`. The poller matches the entire title with `^review ([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#([1-9][0-9]*) @ ([0-9a-f]{40})( cmd:([1-9][0-9]*|-))?$`. Command IDs are decimal strings. The suffix-free form is legacy. The encoded target SHA identifies the reviewed commit; Actions `head_sha` identifies the workflow source and cannot replace it.

Every valid status other than `completed` is active and suppresses the same `(repository, pull request, target SHA)`, for both title forms. A completed extended run with a decimal command ID consumes `(repository, pull request, command ID)` regardless of conclusion, target SHA, or whether the worker started. A distinct command remains eligible. A completed legacy run cannot consume an unidentified command. Failed or unparseable inventory pagination aborts dispatch; successful traversal is not a transactional snapshot and cannot exclude concurrent pagination or dispatch races.

The poller reconciles existing publication evidence, selects unconsumed explicit commands, then applies automatic failure and coverage rules. An explicit command can bypass an automatic same-head failure barrier, but active same-head work still suppresses it. A trusted posted review proves publication. Its attempt receipt identifies the exact attempt whose status may be settled; legacy reviews retain timestamp-based reconciliation. A terminal workflow run proves neither publication nor status settlement.

## Decision and trade-off

The command ID in the hosted title survives a failed marker write without adding storage. A terminal workflow run consumes its command even if cancellation or setup/preflight failure prevented the worker from starting. Consumption prevents replay; it does not guarantee a review, failure comment, reaction cleanup, notification, or terminal commit status. A pending status may require operator reconciliation. Submit a new command to request another attempt.

## Residual exposure

Retention and deletion of workflow runs bound this fallback. If a terminal record disappears and no trusted marker or status remains, a command may be selected again. Full history traversal consumes Actions API quota proportional to retained runs. These records are scheduling evidence only.
