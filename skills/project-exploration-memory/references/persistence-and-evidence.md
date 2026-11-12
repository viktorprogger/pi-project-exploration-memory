# Evidence reference

The package exposes six PEM APIs: catalog, details, write, edit, history, and `project_memory_retire`. Use catalog before details; details includes current content, captures, freshness, integrity warnings, and the newest five history reasons. Use history only for older records and paginate with its cursor. `project_memory_retire` supports `archive`, which preserves historical content, bypasses source-freshness checks, and denies later mutations, and `supersede`, which removes the target after verified replacement preconditions while reporting controlled best-effort failures without cross-file rollback.

## What the agent supplies and what the extension generates

The agent must inspect the current repository source, write the explanatory narrative, and place a supported source anchor next to each source-backed claim. For `project_memory_write`, `content` is that ordinary Markdown/prose plus anchors; title, description, and reason are the document metadata and audit reason. For `project_memory_edit`, first retrieve the document in editable view, then supply unique exact `oldText`/`newText` replacements against that editable text, with a reason and any intentional title/description change. Do not supply copied source code as a substitute for an anchor, or paste an expanded evidence block.

A supported anchor is a project-relative bare reference such as `src/orders.ts#L35-L50`, or a Markdown link such as `[handler](src/orders.ts#L35-L50)`. A backtick-wrapped anchor is supported only as the token in a standalone Markdown list item, for example `- \`src/orders.ts#L35-L50\``; inline code elsewhere is protected and is not expanded. The path and range must be inspected; these examples are illustrative, not repository evidence.

On every write or edit, the service passes the submitted content through the codec's `expand`. The codec first collapses any existing generated blocks, finds supported anchors, reads each referenced project file, validates that the range exists, captures the selected lines, and replaces the anchor with a generated fenced evidence block containing source text and integrity metadata. The expanded view contains generated evidence, while the agent should author and edit only the collapsed anchor form. A mutation rereads all anchors that remain in the submitted content, so still-valid evidence is retained by retaining its anchor and is regenerated from source; it is not retained by hand-editing a block.

## Views and a practical flow

1. **Write:** inspect source and prepare a narrative with inspected anchors (not copied code), then write it. The extension reads the files and captures/expands source evidence automatically.
2. **Read:** use details' default `expanded` view to read the generated source code beside the narrative. Use `view: editable` when exact text must be changed: it collapses each valid evidence block back to its original anchor literal. The service's edit operation applies each replacement only when `oldText` occurs exactly once, then expands the resulting anchor text again.
3. **Refresh:** retrieve details and inspect freshness. Freshness hashes the whole captured source file, so a changed file can make an occurrence `changed` even if the selected lines look similar. Research the current source; update the dependent prose and replace the old anchor with a newly inspected range/path when the implementation moved. Submit that collapsed change through edit (or a complete replacement through write), allowing the extension to reread and regenerate the captures.

Illustrative flow, not actual repository evidence:

- inspected claim: “The handler validates the request” — `[handler](path/to/handler.ts#L10-L24)` *(illustrative)*
- editable update: replace `path/to/handler.ts#L10-L24` with `path/to/handler.ts#L14-L30` only after inspecting the new location and updating any prose that changed *(illustrative)*
- retrieved expanded result: the narrative remains, and the extension supplies a `Source: path/to/handler.ts#L14-L30` fenced block with the lines it read *(illustrative)*

Do not edit generated evidence blocks or their contents. Do not blindly reuse stale line ranges, assert that unreadable or missing evidence is current, or discard it merely to force a green freshness result. Research and rebind an anchor to an inspected location; if that cannot yet be done, preserve the evidence and state the deferral rather than inventing replacement source.

## Integrity boundaries

The extension manages generated evidence, freshness, integrity checks, and recovery boundaries. Do not edit managed artifacts directly. Report malformed, unreadable, or inconsistent state rather than inventing repairs.

## Role and handoff boundary

PEM is factual evidence, not an infallible substitute for source. The lead consumes catalog/details and task-relevant expanded documents but does not perform source/history/map discovery or direct mutation. Scouts research gaps and publish verified updates; bounded authors/verifiers do not broaden discovery. When a launcher cannot expand a validated macro, pass the full expanded details snapshot with identity, evidence, integrity/freshness, status, unknowns, and newest-five history rather than a slug or macro.
