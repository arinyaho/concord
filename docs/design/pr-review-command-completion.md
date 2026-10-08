# Requested PR review command completion

A requested review carries its issue-comment command ID in the hosted workflow run name. The extended name is `review <repo>#<pr> @ <sha> cmd:<id-or->`, where a decimal command ID denotes a request and `-` denotes an automatic run. The poller reads terminal `pr-review.yml` workflow runs as a fallback completion record when the worker cannot publish its `concord-review-failed` comment marker. A terminal run consumes the command identified by `(repository, pull request, command ID)` across head changes, including failed and cancelled runs. A later, distinct `@concord` comment has a new ID and remains eligible.

The `concord-review-failed` marker and a posted review with a command marker are command-completion evidence. Only the posted review and its attempt receipt prove review publication. A terminal workflow conclusion records that the attempted command ended; it does not prove that a review was posted or that the commit status settled. The scanner reconciles posted receipts before using terminal evidence for scheduling. Legacy names `review <repo>#<pr> @ <sha>` remain readable for active-run suppression, but a terminal legacy name cannot establish completion of a markerless command.

## Decision and trade-off

Embedding the command ID in the run name makes the record available to a later poll without another write by the failing worker. This uses hosted Actions history rather than a new database or a second best-effort marker. Active-run matching must accept both the legacy exact title and the extended title with a command-ID suffix while old runs remain in history.

## Residual exposure

GitHub's retention and deletion policies bound the fallback. After the terminal run disappears, a command with neither a posted review nor a failure marker may be selected again. Run-name evidence is a scheduling record only; status and review publication still require their own evidence. A poll that cannot read all run pages fails before dispatching, so incomplete history cannot silently make a command look unfinished.
