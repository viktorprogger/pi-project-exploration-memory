---
name: worktree-lifecycle
description: Use whenever creating, preparing, using, exporting, finishing, or deleting a Git worktree for agent work. Follow this skill before investigation in a new worktree and before any cleanup that could lose local state.
---

# Safe Worktree Lifecycle

Treat a worktree as an isolated agent workspace with project-local context that Git may not carry. Prefer explicit inspection and reversible operations over convenience.

## Create and prepare

1. Inspect the current worktree, repository root, branch, status, and existing worktree list. Confirm the intended source worktree and destination.
2. Create the worktree with `git worktree` using the requested branch or detached state. Do not improvise a branch policy.
3. Before investigation, copy the project-local agent, context, memory, and skill scaffold from the source worktree. Preserve symlinks and copy discovered equivalents, including:
   - `AGENTS.md`, `CLAUDE.md`
   - `.pi/`, `.claude/`, `.context/`, `.history/`
   - `.mcp.json`
   - other project-local agent/context/memory/skill files found during inspection
4. Copy configuration and documents as project files, not as Git metadata. Do not copy `.git`, dependency directories, secrets, caches, generated runtime state, or IDE state. Avoid copying credentials embedded in local configuration; inspect questionable files first.
5. Handle untracked local project memory explicitly. Ask whether continuity is wanted or inspect the user's stated intent; copy it only intentionally. Never assume Git carries local memory.
6. Verify the destination scaffold, symlink targets, repository identity, and status before starting work. Record what was intentionally omitted.

Do not silently overwrite existing destination context or memory. Stop and ask before merging two local scaffolds or replacing non-empty files.

## Use, export, and finish

- Keep worktree-local memory, context, and untracked results associated with that worktree unless the user explicitly requests export.
- Before exporting or handing off, inspect tracked, untracked, and ignored changes. Preserve needed outputs and explain whether they are tracked, ignored, or intentionally local.
- Never commit, edit `.gitignore`, or change Git tracking policy automatically. Git tracking remains the user's choice.
- Before deletion, stop or confirm that no agent, process, test watcher, editor, or other work is active in the worktree.
- Inspect `git status --short`, ignored files, and relevant untracked paths. Preserve or export memory, context, skills, and other needed untracked results first.
- Refuse silent loss. If state is ambiguous, stop and ask instead of deleting. Do not assume a clean Git status means local ignored memory or runtime results are disposable.

## Delete safely

1. Confirm the target path and repository association.
2. Confirm no active work remains and record/export anything that must survive.
3. Inspect tracked, untracked, and ignored changes, including local project memory.
4. Prefer normal `git worktree remove <path>` so Git performs the ordinary lifecycle checks.
5. Use force only with explicit authorization naming the target and accepting loss. Never use destructive cleanup as a default or hide failures with broad removal commands.
6. Verify with `git worktree list` and, when appropriate, `git worktree prune`. Confirm the directory and worktree metadata have the expected state.

Never delete a worktree merely because its branch is merged. Local memory and ignored results may still matter.

## Recovery after interruption

If creation, copying, export, or removal is interrupted, do not repeat a destructive command blindly. Inspect the filesystem, `git worktree list`, repository status, symlink targets, and the destination's local scaffold. Recover or copy missing context and memory before resuming. If removal partially happened, use normal Git worktree inspection and repair/prune guidance; preserve any remaining files before retrying. Report what was recovered, what is missing, and any state that still needs user confirmation.
