---
name: project-exploration-memory
description: Use for non-trivial repository exploration, understanding business functions, source-backed planning, or updating reusable project memory. Trigger this skill whenever exploration findings may help a later agent, even if the user does not explicitly mention memory.
---

# Project Exploration Memory

Use project memory to reduce repeated exploration without replacing source evidence. Keep the flow low-cognitive-load and evidence-led.

## Decide whether memory applies

- Skip memory for trivial, mechanical, or already-localized tasks such as a one-line typo, a direct formatter change, or a clearly named file edit.
- Use memory for business-function discovery, multi-file exploration, source-backed plans, unfamiliar behavior, or findings worth reusing.
- Never treat memory as authority over the repository. Source and current runtime behavior remain authoritative.

## Prompt-text macros

For interactive or RPC input, `[[pem:<slug>]]` expands a local project-memory document. A slug is lowercase ASCII, 1–128 characters, matching `[a-z0-9][a-z0-9_-]{0,127}`. A single backslash escape (`\[[pem:slug]]`) produces literal `[[pem:slug]]` with no retrieval or validation.

Do not expand macros in ordinary inline code or fenced Markdown code. Inline code requires a matching backtick run of the same length. Fences are recognized only when a line begins with up to three spaces and at least three identical backticks or tildes; a closing fence uses that character at least as many times, allows up to three leading spaces and only spaces/tabs after it, and ends at the line ending. Expansion is nonrecursive and one-step.

Expand multiple occurrences in source order, retrieving each repeated slug once in first-occurrence order. Resolve only from the input event's `ctx.cwd`; never carry forward a project override from a tool call. Process only `interactive` and `rpc` input; leave extension-originated input unchanged. The expansion must preserve ordinary retrieval parity: content, freshness/source occurrences, integrity warnings, and the newest five history reasons. Preserve images.

The complete transformed input at this hook is limited to 64 KiB UTF-8, before any later Pi template or skill expansion. Malformed syntax, retrieval/rendering errors, or overflow fail closed: mark input handled and never deliver the original prompt, even when notification fails. This remains provider-free and leaves the existing five tools unchanged.

## Explore in a short loop

1. Call `project_memory_catalog` first. Do not begin by guessing document slugs.
2. Select only relevant entries and retrieve them with expanded `project_memory_details`.
3. Inspect the referenced source files and surrounding code. Check source-relative anchors, whole-file freshness, and any evidence status before relying on a claim.
4. Report stale, missing, unreadable, or insufficient evidence plainly. Do not silently substitute a guess or newer-looking prose for persisted evidence.
5. Update or create memory only when repository evidence supports a durable finding. Never invent facts, inferred intent, source ranges, or business rules.
6. Immediately before editing memory, retrieve the editable details again. Use the current content and evidence from that read as the edit basis.
7. Use an exact edit for a known unique replacement, or a write for a complete new/current document. State a concise reason for the change.
8. Keep source-relative anchors and whole-file freshness information intact. Preserve expanded evidence when it is still valid; recapture only from inspected source. Write source references as bare `path#Lstart[-Lend]` anchors or Markdown links; do not wrap them in backticks in ordinary prose, because inline-code references are ignored. The only compatibility exception is a complete single-backtick anchor used as the entire Markdown list-item token (for example, `- \`src/orders.ts#L35-L50\``).
9. Use `project_memory_history` only for entries older than the latest five. `project_memory_details` already provides the latest five history entries.

## Memory boundaries

- The extension stores current state only: no revisions, drafts, commits, locks, SQLite database, or cross-file transaction guarantee.
- Memory is isolated per worktree. Do not assume another worktree sees or shares it, and do not promise concurrent-writer safety.
- Do not modify repository source, Git policy, `.gitignore`, commits, or tracking choices as part of memory work. Agents own correctness and reasons; the memory extension owns persistence and evidence bindings.
- Treat a changed, missing, or unreadable source as a freshness problem to report, not as permission to overwrite evidence.
- Do not merge conflicting states, repair partial publication, or choose the newest-looking artifact. Malformed, unsafe, unreadable, or missing state must fail clearly; a readable document-hash mismatch is an explicit warning that an agent may recover with an ordinary write/edit.

## Persisted document format

The current state is strict schema 2: `catalog.json` remains JSON and is the sole owner of `documentSha256`, while each `documents/<slug>.md` uses ordinary multiline YAML front matter between `---` delimiters with exactly `schemaVersion`, `slug`, and `captures`, followed by the exact Markdown body. The writer uses LF framing; reads accept LF or CRLF framing and preserve the body unchanged. `documentSha256` is the lowercase SHA-256 of the exact complete Markdown bytes on disk, including delimiters, YAML, separators, and body; it is not document front-matter metadata. Captures, source-evidence content, and freshness behavior remain part of the existing contract.

Legacy JSON front matter is deliberately unsupported and rejected. There is no JSON fallback, runtime migration, automatic conversion, or repair path; the two checked-in documents were regenerated once through the canonical writer, without rewriting historical `.history` records. Source-reference parsing/codec, prompt macros, service contracts, and exactly five public tools remain unchanged.

## Reporting

When memory is useful, summarize which catalog/details entries were consulted, which source files support the conclusion, and whether evidence is current. When memory is stale or absent, say exactly what is missing and continue with direct source inspection where possible. Distinguish a source-backed fact from an unresolved question.
