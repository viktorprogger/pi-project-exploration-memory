---
name: project-memory-subagent-delegation
description: Build role-aware, task-scoped PEM context for every subagent delegation, with compatible full snapshots when macros are unsupported.
---

# Project-memory subagent delegation

This applies to **every** delegation, including explorer/scout delegation, whenever a launcher exists. It does not install or change a launcher and does not change runtime macro behavior.

## Select and pass context

1. The lead selects task-relevant PEM entries through catalog, then details. Pass actual selected documents before child work: project/worktree identity; complete content and source evidence; truthful status, freshness, and integrity; explicit unknowns; and newest-five history reasons. Context references are not a substitute for documents.
2. Do not send a giant dump or irrelevant documents. Select only relevant context. Missing or contradictory evidence goes back through the lead to a scout; it is never silently filled from direct source/history exploration by another role.
3. A child receives its role and bounded task after the shared context. Explorers may research and publish PEM; other roles may inspect only exact assigned source/diffs/tests and cannot perform broad discovery or PEM mutation.

## Launcher compatibility

The runner constructs the child prompt without expanding PEM macros itself. A child session may expand real, unprotected `[[pem:slug]]` macros only when the PEM extension is actually loaded, the chosen input source supports the input hook, the child has the correct project/worktree context, and expansion stays within its limits. The current explorer configuration can meet this route; extension-disabled implementer/verifier sessions cannot. Unless those conditions are verified for the child, receive an equivalent full expanded-details snapshot, not a guessed slug, bare macro, or context reference. Preserve document content, generated source evidence, project/worktree identity, integrity/freshness/status, unknowns, and newest-five history. Do not modify runtime to fix launcher compatibility.

The extension's 64 KiB macro limit applies to macro-expanded input only; it does not magically limit explicit snapshots. Respect launcher/context limits: narrow or split the assignment rather than truncating safety or evidence or widening irrelevant input.

## Stable prefix and cache

For delegates with the same system prompt, order prompts as: system prompt supplied by the runner; one identical common user prompt with objective, constraints, and output requirements; identical common PEM macros or identical expanded snapshots in the same order; then agent-specific task data. Keep the shared prefix byte-for-byte identical. A cache exception is justified only for the same system prompt and the same ordered documents/content, with a stable common input and a real cache benefit; individual documents and task data follow the shared prefix. Cache is never a reason to include irrelevant documents.

Macro syntax and Markdown protection are in [the macro reference](../project-exploration-memory/references/macro-syntax.md). The six PEM APIs, including `project_memory_retire`, and provider-free behavior remain unchanged.
