# Project exploration memory for Pi

A provider-free Pi package for saving reusable, project-local explanations of business functions. Documents capture business meaning, constraints, data flow, and source evidence without modifying source files.

## Install and run

```sh
pi install -l /absolute/path/to/pi-project-exploration-memory
pi -e /absolute/path/to/pi-project-exploration-memory
```

The package uses Pi's current project by default. Pass `project` to select another project context. There are no provider, network, UI, timer, or remote URL effects.

## Skills

The package exposes three focused skills: `project-exploration-memory` for scout research and PEM authoring, `project-memory-reading` for role-aware catalog-first evidence and freshness-aware reading, and `project-memory-subagent-delegation` for task-scoped context and launcher-compatible handoff. Pi discovers each skill recursively from its `SKILL.md`.

## Workflow and handoff

The lead obtains project knowledge only from task-relevant PEM details and re-reads verified scout publications. Explorers/scouts are the source-research and PEM-writing role; bounded authors and verifiers may inspect only their exact assigned source, diffs, and tests. Missing, stale, insufficient, or contradictory knowledge routes through the lead to a scout; unavailable PEM blocks dependent claims.

Every delegate receives actual relevant PEM documents with project/worktree identity, source evidence, integrity/freshness/status, unknowns, and newest-five history. The runner constructs the child prompt without expanding PEM macros itself. A child may expand real unprotected `[[pem:slug]]` references only when its PEM extension is loaded, its chosen input source supports the hook, the correct project/worktree context is present, and limits are respected; the current explorer configuration can meet this route, while extension-disabled implementer/verifier sessions cannot. Otherwise provide the equivalent full expanded-details snapshot; never use bare macros, guessed slugs, or irrelevant documents. See the bundled skills for cache-prefix and context-limit rules.

## Tools

Exactly six tools are registered:

- `project_memory_catalog({ query?, project? })` matches every whitespace-separated, case-insensitive query token as a substring in slug, title, or description; an empty query returns all entries, and content/history are not searched.
- `project_memory_details({ slugs, view?, project? })` returns current content, captures, freshness, and the latest five history entries. `editable` view restores exact source links for editing.
- `project_memory_write({ slug, title, description, content, reason, project? })` creates or replaces current content.
- `project_memory_edit({ slug, edits, reason, title?, description?, project? })` applies unique exact replacements to editable current content.
- `project_memory_history({ slug, limit?, cursor?, project? })` returns bounded newest-first history pages with an opaque stable cursor.
- `project_memory_retire({ slug, mode, reason, replacements?, project? })` archives or supersedes a memory. `archive` preserves the document as historical content; `supersede` verifies replacement preconditions and then deletes the target, with best-effort cleanup and no cross-file rollback guarantee.

Mutation reasons and history timestamps are recorded as UTC ISO timestamps. Details are intentionally compact for model use; inspect editable details immediately before an exact edit.

## Prompt-text macros

Interactive and RPC input may use `[[pem:<slug>]]` to insert a local memory document. Slugs are lowercase ASCII, 1–128 characters: the first is a letter or digit, and the remainder may be letters, digits, `_`, or `-` (`[a-z0-9][a-z0-9_-]{0,127}`). A single backslash escape, `\[[pem:slug]]`, emits literal `[[pem:slug]]` and performs no retrieval or validation.

Macros are ignored in ordinary inline code and fenced Markdown code. Inline backtick runs must have a matching closing run of the same length. A fence starts with at least three backticks or tildes at the beginning of a line (up to three leading spaces); it closes with the same character, at least the opening length, up to three leading spaces, and only spaces/tabs after the run before the line ends. Expansion is one pass: inserted document text is not scanned again.

All occurrences expand in source order; repeated slugs are retrieved once in first-occurrence order. Selection is local to the input event's `ctx.cwd`; a project selected by an earlier tool call is not reused. Only `interactive` and `rpc` input is processed; extension-originated input is untouched. Retrieval has the same content, freshness/source occurrences, integrity warnings, and newest-five history reasons as ordinary details retrieval.

The transformed input, including surrounding text and expanded documents, must be at most 64 KiB UTF-8 at this hook; later Pi template or skill expansion is outside this bound. Images are preserved. Malformed macros, retrieval/rendering failures, and overflow fail closed: input is handled and the original prompt is never delivered, even if best-effort notification fails. Macros remain provider-free and do not change the six tools above.

## Persistence and consistency

Use the six tools to read and mutate project memory. The extension owns persistence, integrity checks, freshness tracking, and recovery boundaries; invalid or inconsistent state is reported rather than silently repaired.

Git tracking and commit policy are user-controlled. The extension neither edits Git metadata nor decides whether memory files should be tracked.

## Reference grammar and freshness

Use project-relative GitHub-style anchors such as `src/orders.ts#L35-L50` or `[validation](src/orders.ts#L35-L50)`. Do not wrap source references in backticks in ordinary prose: inline-code references and fenced-code references are ignored. The only compatibility exception is a complete single-backtick anchor used as the entire Markdown list-item token, such as `- \`src/orders.ts#L35-L50\``. Paths must be UTF-8 regular files with no absolute paths, traversal, URLs, query strings, or malformed ranges.

The service preserves captured source evidence in collision-safe codec blocks and keeps the original literal for editable retrieval. Freshness hashes the entire source file: unchanged captures are `valid`; changed, missing, or unreadable files are reported with path and inclusive ranges. A document with no references reports `all-valid (no-sources)`. Catalog and details identify documents as `actual` or `archived`; archived documents remain readable, report `Freshness: not_applicable`, and bypass source reads. Archived documents cannot be written or edited. Use `archive` to preserve history; use `supersede` only when verified replacements exist, and handle controlled partial cleanup failures honestly.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run smoke
```

`npm run check` runs typecheck, the deterministic test suite, enforced 100% c8 coverage, and the mutation gate (at least 85%).

Tests use temporary projects and provider-free Pi hosts. The extension preserves Pi's built-in read/write/edit tools and performs no source or Git mutation.
