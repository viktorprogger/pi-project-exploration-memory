---
name: project-memory-reading
description: Read task-relevant project-memory documents with catalog-first evidence, integrity, freshness, and role-aware handoff rules.
---

# Project memory reading

## Role separation

The **lead** consumes PEM plus user requirements, governing instructions, plans, and execution/verification reports. The lead does not explore source, history, maps, or directly mutate PEM. A **scout/source-writing explorer** researches material gaps and publishes verified PEM. A bounded author or verifier may inspect only exact assigned source, diffs, and tests; it must request a scout for broad or missing knowledge. Operational inputs are not alternative project-knowledge stores.

## Read workflow

1. Call `project_memory_catalog` first; never guess slugs. Select only task-relevant entries, then retrieve `project_memory_details`. Details include content, source captures/evidence, integrity, freshness, status, and newest-five history reasons. Use history only for older records and paginate its cursor.
2. Treat current source as factual authority, while recognizing PEM is not infallible. A catalog entry is `actual` or `archived`; archived details remain readable historical evidence but report freshness `not_applicable` because source files are not read. Freshness is not semantic completeness: a valid hash does not prove that the document covers the needed behavior. Keep facts, unknowns, inference, and historical claims explicit.
3. If knowledge is missing, stale, insufficient, or contradictory, route the gap through the lead to a scout. The scout researches and publishes verified PEM; the lead re-reads it before continuing. If PEM is unavailable, block dependent claims. Do not read source/history/maps directly as a fallback and do not fabricate PEM.
4. If captured sources are changed, missing, or unreadable, the scout refreshes dependent prose and flow, not just hashes. Dirty files alone do not establish an intentional-staleness exception; only confirmed ongoing changes that make refresh temporarily pointless permit an explained deferral.
5. Do not directly edit PEM. The scout retrieves editable details immediately before exact edits. Preserve the six-tool boundary, evidence, and integrity warnings. Archived documents cannot be written or edited. Use archive to preserve historical content; supersede requires verified replacements, deletes the target, and may report controlled best-effort partial cleanup without cross-document rollback.

## Handoff

Pass only relevant documents, not the full graph or a default dump. Include project/worktree identity, full selected content and source evidence, truthful status/freshness/integrity, unknowns, and newest-five history reasons. A delegate must not rely on a bare slug or an unavailable macro; see the delegation and macro references.
