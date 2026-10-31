# Project exploration memory for Pi

A provider-free Pi package for saving reusable, project-local explanations of business functions. Documents capture business meaning, constraints, data flow, and source evidence without modifying source files.

## Install and run

```sh
pi install -l /absolute/path/to/pi-project-exploration-memory
pi -e /absolute/path/to/pi-project-exploration-memory
```

The package uses Pi's current working directory by default. Every document is stored below `.pi/project-exploration-memory/`. Pass `project` to select an explicit local directory; relative paths resolve from Pi's cwd. There are no provider, network, UI, timer, or remote URL effects.

## Tools

Exactly five tools are registered:

- `project_memory_catalog({ query?, project? })` searches slug, title, and description.
- `project_memory_details({ slugs, view?, project? })` returns current content, captures, freshness, and the latest five history entries. `editable` view restores exact source links for editing.
- `project_memory_write({ slug, title, description, content, reason, project? })` creates or replaces current content.
- `project_memory_edit({ slug, edits, reason, title?, description?, project? })` applies unique exact replacements to editable current content.
- `project_memory_history({ slug, limit?, cursor?, project? })` returns bounded newest-first history pages with an opaque stable cursor.

Mutation reasons and history timestamps are recorded as UTC ISO timestamps. Details are intentionally compact for model use; inspect editable details immediately before an exact edit.

## Prompt-text macros

Interactive and RPC input may use `[[pem:<slug>]]` to insert a local memory document. Slugs are lowercase ASCII, 1–128 characters: the first is a letter or digit, and the remainder may be letters, digits, `_`, or `-` (`[a-z0-9][a-z0-9_-]{0,127}`). A single backslash escape, `\[[pem:slug]]`, emits literal `[[pem:slug]]` and performs no retrieval or validation.

Macros are ignored in ordinary inline code and fenced Markdown code. Inline backtick runs must have a matching closing run of the same length. A fence starts with at least three backticks or tildes at the beginning of a line (up to three leading spaces); it closes with the same character, at least the opening length, up to three leading spaces, and only spaces/tabs after the run before the line ends. Expansion is one pass: inserted document text is not scanned again.

All occurrences expand in source order; repeated slugs are retrieved once in first-occurrence order. Selection is local to the input event's `ctx.cwd`; a project selected by an earlier tool call is not reused. Only `interactive` and `rpc` input is processed; extension-originated input is untouched. Retrieval has the same content, freshness/source occurrences, integrity warnings, and newest-five history reasons as ordinary details retrieval.

The transformed input, including surrounding text and expanded documents, must be at most 64 KiB UTF-8 at this hook; later Pi template or skill expansion is outside this bound. Images are preserved. Malformed macros, retrieval/rendering failures, and overflow fail closed: input is handled and the original prompt is never delivered, even if best-effort notification fails. Macros remain provider-free and do not change the exactly five tools above.

## Current-state files and consistency

The current state uses only a schema-2 `catalog.json` and one `documents/<slug>.md` per slug. `catalog.json` remains JSON; each Markdown document has an optional UTF-8 BOM, an opening `---` line, strict schema-2 multiline YAML front matter with exactly `schemaVersion`, `slug`, and `captures`, a closing `---` line, and a required LF/CRLF separator before the exact body. The body may be empty and its leading/trailing newlines are preserved. The catalog stores one lowercase `documentSha256` over the exact complete Markdown bytes as written, including front matter delimiters, YAML, separators, and body; there are no sidecars, secondary binding hashes, or revision directories.

Old JSON front matter is deliberately rejected. This is a format cutover: runtime has no JSON fallback, migration, or repair path. A truly empty project has an empty catalog and permits first publication. A missing catalog beside any persisted artifact is an inconsistent-state error. Markdown and catalog replacement use independent temporary-file-plus-rename operations in Markdown → catalog order. A readable document whose observed hash differs from the catalog hash is returned with an explicit warning so an agent can inspect and recover it with an ordinary write/edit. Invalid UTF-8, malformed YAML front matter/catalog, unsafe paths, missing required documents, and unsupported schema-1/revision artifacts remain hard errors; the extension never chooses a winning file or repairs state automatically.

The checked-in documents were regenerated once through the canonical writer; historical `.history` records are not rewritten by the format cutover. These independent replacements are not a transaction and do not prevent unsupported concurrent writers or power-loss races. There are no SQLite databases, locks, commits, CLI, or Git operations.

Git tracking and commit policy are user-controlled. The extension neither edits Git metadata nor decides whether memory files should be tracked. Worktree setup, coordination, and lifecycle remain the responsibility of the appropriate skills; this package only stores and retrieves exploration memory.

## Reference grammar and freshness

Use project-relative GitHub-style anchors such as `src/orders.ts#L35-L50` or `[validation](src/orders.ts#L35-L50)`. Do not wrap source references in backticks in ordinary prose: inline-code references and fenced-code references are ignored. The only compatibility exception is a complete single-backtick anchor used as the entire Markdown list-item token, such as `- \`src/orders.ts#L35-L50\``. Paths must be UTF-8 regular files with no absolute paths, traversal, URLs, query strings, or malformed ranges.

The service preserves captured source evidence in collision-safe codec blocks and keeps the original literal for editable retrieval. Freshness hashes the entire source file: unchanged captures are `valid`; changed, missing, or unreadable files are reported with path and inclusive ranges. A document with no references reports `all-valid (no-sources)`.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run smoke
```

`npm run check` runs typecheck, the deterministic test suite, enforced 100% c8 coverage, and the mutation gate (at least 85%).

Tests use temporary projects and provider-free Pi hosts. The extension preserves Pi's built-in read/write/edit tools and performs no source or Git mutation.
