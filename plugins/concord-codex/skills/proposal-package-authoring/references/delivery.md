# Delivery and verification

## Control output size during authoring

Treat PPTX and PDF downloadability as a delivery requirement, not cleanup after design.

- Record the submission limit or a practical delivery-channel budget in `deck.md`; warn before the deck approaches it.
- Size raster assets for actual placement before insertion. Crop unused regions and downsample to a reasonable multiple of displayed dimensions; editor cropping may retain the full source asset.
- Use JPEG for photographs without transparency, PNG only for transparency or lossless line detail, and native objects for compatible logos, icons, and diagrams. Preserve original assets separately when needed.
- Generate or source images at the intended aspect ratio instead of heavily cropping oversized general-purpose images.
- Put repeated branding and backgrounds on the master or layout and reuse a canonical asset.
- Keep tables, charts, and required diagrams native rather than replacing them with large screenshots. Do not save space by rasterizing evidence that must remain editable.
- Avoid embedded video, animated GIFs, and unnecessary font families or weights. Prefer a linked media reference with a lightweight poster image when allowed.
- Remove obsolete duplicated slides, unused media, and abandoned layouts, but retain source evidence still referenced by the final deck.
- After representative high-asset slides are complete, make one checkpoint export and inspect packaged media sizes. Optimize the largest assets first if the projected deck exceeds its budget.
- Match PDF quality to use: screen review can use lower image resolution than print submission, but text, charts, and technical diagrams must remain legible.

## Verify at risk boundaries and milestones

- Update and directly verify notes, evidence references, manifest content, and synchronization status during every relevant revision. When those are the only changes, skip export and rendering, not the source-level check.
- Export and render affected slides when a change can alter text wrapping, font substitution, object geometry, arrows, image crops, tables, charts, backgrounds, or format conversion; when explicitly requested; or before handoff.
- Batch consecutive edits to the same slides and run one targeted verification. If targeted export is unavailable, defer the full export until the batch is ready.
- Run whole-deck PPTX and PDF verification before submission and after changes to the master, shared layouts, theme fonts, page size, slide order, or other cross-slide structures.
- Measure PPTX and PDF sizes against the budget and confirm both files can be downloaded, opened, and shared through the intended channel.
- At whole-deck verification, render every slide and inspect a montage plus full-size views of dense or high-risk pages.
- Check clipping, overlap, substituted fonts, unintended line breaks, chart and table legibility, image quality, alignment, and background changes.
- Confirm notes, links, and slide order survived conversion.
- Reopen the final artifact in the target editor when possible and verify intended content remains editable.
- Reconcile the final deck against the compliance tracker and evaluation criteria before calling the work complete.
