---
name: project-exploration-memory
description: Research and author source-backed project memory for a business function, technical contract, architecture/navigation area, or project-wide rule set.
---

# Project exploration memory

Use this skill for bounded exploration whose result should be reusable. Current source and runtime behavior are factual authority; PEM is evidence-led but not infallible. This skill is the only role permitted to research source/history/maps and mutate PEM.

## Roles and workflow

- **Lead:** consumes relevant PEM documents, user requirements, governing instructions, plans, and execution/verification reports. The lead does not explore source, history, maps, or directly mutate PEM. Missing, stale, insufficient, or contradictory knowledge is routed to a scout; after verified publication the lead re-reads PEM before continuing. Unavailable PEM blocks dependent claims; there is no direct-source fallback or fabricated memory.
- **Scout/source-writing explorer:** performs the bounded source, history, and optional map research requested by the lead, then publishes or refreshes PEM. Existing CTX maps are optional aids; do not initialize, regenerate, or mutate them during research. `ast-grep` and outline tools are scout-only.
- **Bounded author/verifier:** may read exact assigned source, diffs, and tests to implement or independently verify its slice, but does not perform broad/domain discovery or mutate PEM. Ask the lead for a scout when material knowledge is missing.

Operational inputs such as user tasks, governing instructions, plans, and reports guide work; they are not alternative project-knowledge stores.

## Scout authoring

1. Call `project_memory_catalog` first. Never guess a slug. Select relevant entries and retrieve `project_memory_details` before relying on them. Reuse a valid document; create a new document only when the catalog confirms that no suitable entry exists.
2. Scope one coherent unit: a business function, technical contract, architecture/navigation area, or project-wide rules and decisions. Explain purpose, actors/inputs, outcomes, success and negative paths, authorization, durable data or external effects, and boundaries without dumping a transitive call graph.
3. Research the requested source/history scope and write ordinary prose with inspected project-relative anchors beside factual claims. Facts, unknowns, and inference must be labeled. Anchors are generated evidence: submit anchors, never hand-copy source excerpts or generated blocks and never invent paths/ranges.
4. Incoming relevant PEM documents are mandatory context when they exist. Preserve valid evidence and history, refresh dependent prose and flow when sources changed, and record freshness/integrity limits. Bootstrap an empty project truthfully; do not imply knowledge that was not researched.
5. For project-wide rules, curate current rules, why, authority, history, and revisit conditions. Keep them project-wide, not user-global; avoid a monolith and include only relevant global rules. Historical claims remain historical unless freshly supported.

Before an exact edit, retrieve editable details again. Use the six PEM APIs: catalog, details, write, edit, history, and retire. Catalog entries are `actual` or `archived`; archived details remain readable for historical context, report freshness `not_applicable`, and do not read source files. Archived documents are mutation-denied. Use `retire` with `mode: "archive"` to preserve a historical document, or `mode: "supersede"` only after verifying every replacement; supersede deletes the target and is best-effort, with no cross-document rollback guarantee, so report controlled partial failures honestly. Preserve evidence and integrity warnings; never invent unsupported behavior. Explicit no-write requests and destructive recovery are not overridden.

## Delegation and handoff

Every delegate receives only task-relevant PEM documents, with project/worktree identity, document content and source evidence, freshness/integrity/status, unknowns, and newest-five history reasons. The lead must re-read published PEM after a scout handoff. See the delegation skill for launcher compatibility and full-snapshot rules.

## Boundaries

Do not modify source, runtime/API behavior, package configuration, tracking policy, or unrelated skills. Preserve worktree/Git safety and existing evidence/reorganization rules.
