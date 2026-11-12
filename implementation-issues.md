# Implementation issues

## Upstream package-resource discovery does not reach Pi package skills

- **Affected loader:** installed `pi-subagents-lite/src/prompt/skill-loader.ts` (`loadAllSkills`), which discovers ancestor `.agents/skills`, `~/.agents/skills`, Pi defaults under `~/.pi/agent/skills`, and the project `.pi/skills` directory, but not Pi package-resource skill paths.
- **Evidence:** the installed loader source lists those roots and calls Pi `loadSkills`/`loadSkillsFromDir`; it contains no package-resource path. Before integration, the two selected PEM skill directories were absent from `~/.pi/agent/skills`, while the authoritative directories existed only in this repository.
- **Impact:** project-explorer's explicit selected skills were not visible to installed `pi-subagents-lite` on machines where the repository skill paths are not otherwise exposed to one of those loader roots.
- **Mitigation:** expose the researcher's two selected existing directories through safe symlinks at `/home/viktor/.pi/agent/skills/project-exploration-memory` and `/home/viktor/.pi/agent/skills/project-memory-reading`. After the required checkpoint, also expose `/home/viktor/.pi/agent/skills/project-memory-subagent-delegation` for planning/execution guidance. All three target authoritative repository directories, preserving whole-directory relative references and canonical-path handling.
- **Outside scope:** changing the third-party loader or its dependencies is not authorized for this task.
- **Follow-up:** consider an upstream `pi-subagents-lite` package-resource discovery fix (or an officially supported resource-registration mechanism), then remove or supersede this local visibility workaround after compatibility is verified on fresh machines.

## Global mutation gate remains below its configured threshold

- **Evidence:** `npm run check` passed typecheck, 108 tests, and c8 coverage at 100% for statements, branches, functions, and lines. Its Stryker phase exited 1 at 84.65% against the configured 85% break threshold: 2,011 mutants killed, 51 timed out, 374 survived, and 0 had no coverage or errors. The configured mutation scope is all `src/**/*.ts` and `extensions/**/*.ts` in `stryker.config.mjs`.
- **Affected paths:** surviving mutants were reported across `extensions/project-exploration-memory/index.ts` (76), `src/core/project-root.ts` (19), `src/core/service.ts` (41), `src/core/storage.ts` (115), and `src/source-reference/codec.ts` (123). The global report mixes lifecycle-owned files with pre-existing source-reference/project-root behavior; no concrete lifecycle behavior defect was established from the aggregate result.
- **Impact:** the repository-wide `npm run check` mutation gate is not green, so mutation acceptance remains unverified even though functional tests and coverage pass.
- **Outside scope:** changing unrelated source-reference/project-root behavior or weakening the configured threshold is outside the approved lifecycle scope. No such changes were made.
- **Follow-up:** run a focused mutation campaign over lifecycle-owned changes, classify equivalent/defensive survivors, and remediate concrete lifecycle test gaps without changing unrelated behavior.
