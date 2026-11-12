import type { CatalogRequest, CatalogResult, CurrentDocument, DetailsRequest, DetailsResult, DocumentDetails, EditRequest, ExplorationMemoryService, FreshnessSummary, HistoryRequest, HistoryResult, IntegrityWarning, MutationResult, RetireRequest, RetireResult, SourceReader, WriteRequest } from "./contracts.ts";
import { invalidInput, notFound } from "./errors.ts";
import { createSourceReader } from "./project-root.ts";
import { checkFreshness, collapse, expand } from "../source-reference/codec.ts";
import { createStorage, type StorageOptions } from "./storage.ts";
export interface ExplorationMemoryServiceOptions extends StorageOptions {
  project?: string;
  sourceReader?: SourceReader;
  readFile?: (absolutePath: string) => Promise<Uint8Array>;
}
const required = (v: string, n: string) => {
  if (typeof v !== "string" || !v.trim()) throw invalidInput(`${n} is required`);
};
function projectSlugs(s: string[]) {
  if (!Array.isArray(s) || !s.length || s.some(x => typeof x !== "string" || !x.trim()) || new Set(s).size !== s.length) throw invalidInput("At least one unique slug is required");
}
function summarize(ds: DocumentDetails[]): FreshnessSummary {
  const occurrences = ds.flatMap(d => d.freshness.occurrences),
    order = ["unreadable", "missing", "changed", "valid", "not_applicable"] as const;
  return {
    status: order.find(x => occurrences.some(o => o.status === x)) ?? "valid",
    occurrences
  };
}
export function createExplorationMemoryService(cwd: string, options: ExplorationMemoryServiceOptions = {}): ExplorationMemoryService {
  const storage = createStorage(cwd, options.project, options),
    reader = options.sourceReader ?? (options.readFile ? createSourceReader(storage.projectRoot, {
      readFile: options.readFile
    }) : createSourceReader(storage.projectRoot));
  async function detailsOne(slug: string, view: "expanded" | "editable") {
    const e = (await storage.catalog()).entries.find(x => x.slug === slug);
    if (!e) throw notFound(`Unknown memory document: ${slug}`);
    const d = await storage.read(slug),
      archived = d.status === "archived",
      freshness = archived ? {
        status: "not_applicable" as const,
        occurrences: d.captures.map(c => ({
          capture: c,
          status: "not_applicable" as const
        }))
      } : await checkFreshness(d.captures, reader);
    return {
      entry: {
        ...e,
        history: e.history.slice(-5),
        status: e.status
      },
      document: {
        ...d,
        status: d.status
      },
      content: view === "editable" ? collapse(d.content).content : d.content,
      freshness
    };
  }
  async function mutate(slug: string, title: string, description: string, content: string, reason: string) {
    const existing = (await storage.catalog()).entries.find(e => e.slug === slug);
    if (existing?.status === "archived") throw invalidInput("Archived documents cannot be modified");
    const expanded = await expand(content, reader),
      r = await storage.replace({
        slug,
        content: expanded.content,
        captures: expanded.captures,
        status: "actual"
      }, {
        title,
        description
      }, reason);
    return {
      project: storage.projectRoot,
      entry: r.entry,
      document: r.document
    };
  }
  return {
    async catalog(request: CatalogRequest): Promise<CatalogResult> {
      const c = await storage.catalog(),
        q = (request.query ?? "").toLocaleLowerCase().split(/\s+/).filter(Boolean),
        warnings: IntegrityWarning[] = [];
      for (const e of c.entries) warnings.push(...((await storage.read(e.slug)).warnings ?? []));
      return {
        project: storage.projectRoot,
        schemaVersion: c.schemaVersion,
        entries: c.entries.filter(e => q.every(t => `${e.slug} ${e.title} ${e.description}`.toLocaleLowerCase().includes(t))).map(e => ({
          ...e,
          status: e.status
        })),
        ...(warnings.length ? {
          warnings
        } : {})
      };
    },
    async details(request: DetailsRequest): Promise<DetailsResult> {
      projectSlugs(request.slugs);
      const view = request.view ?? "expanded";
      if (view !== "expanded" && view !== "editable") throw invalidInput("Invalid details view");
      const documents = await Promise.all(request.slugs.map(s => detailsOne(s, view))),
        warnings = documents.flatMap(d => d.document.warnings ?? []);
      return {
        project: storage.projectRoot,
        view,
        documents,
        summary: summarize(documents),
        ...(warnings.length ? {
          warnings
        } : {})
      };
    },
    async write(request: WriteRequest) {
      required(request.slug, "Slug");
      required(request.title, "Title");
      required(request.description, "Description");
      required(request.reason, "Reason");
      return mutate(request.slug, request.title, request.description, request.content, request.reason);
    },
    async edit(request: EditRequest) {
      required(request.slug, "Slug");
      required(request.reason, "Reason");
      if (!Array.isArray(request.edits) || !request.edits.length) throw invalidInput("At least one edit is required");
      const current = await storage.read(request.slug);
      if (current.status === "archived") throw invalidInput("Archived documents cannot be modified");
      const original = collapse(current.content).content,
        spans: {
          start: number;
          end: number;
          replacement: string;
        }[] = [];
      for (const edit of request.edits) {
        if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string" || !edit.oldText || !edit.newText) throw invalidInput("Each edit requires non-empty oldText and newText strings");
        const hits: number[] = [];
        for (let i = original.indexOf(edit.oldText); i >= 0; i = original.indexOf(edit.oldText, i + 1)) hits.push(i);
        if (hits.length !== 1) throw invalidInput("Each oldText must occur exactly once");
        const span = {
          start: hits[0]!,
          end: hits[0]! + edit.oldText.length,
          replacement: edit.newText
        };
        if (spans.some(s => span.start < s.end && span.end > s.start)) throw invalidInput("Edits overlap");
        spans.push(span);
      }
      let collapsed = original;
      for (const s of [...spans].sort((a, b) => b.start - a.start)) collapsed = collapsed.slice(0, s.start) + s.replacement + collapsed.slice(s.end);
      const e = (await storage.catalog()).entries.find(x => x.slug === request.slug)!;
      return mutate(request.slug, request.title ?? e.title, request.description ?? e.description, collapsed, request.reason);
    },
    async retire(request: RetireRequest): Promise<RetireResult> {
      required(request.slug, "Slug");
      required(request.reason, "Reason");
      if (request.mode !== "archive" && request.mode !== "supersede") throw invalidInput("Invalid retire mode");
      if (request.mode === "archive") {
        const r = await storage.archive(request.slug, request.reason);
        return {
          project: storage.projectRoot,
          slug: request.slug,
          mode: "archive",
          status: "archived",
          entry: r.entry,
          document: r.document
        };
      }
      if (!Array.isArray(request.replacements) || !request.replacements.length || new Set(request.replacements).size !== request.replacements.length) throw invalidInput("At least one unique replacement slug is required");
      if (request.replacements.some(s => typeof s !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(s))) throw invalidInput("Replacement slug is invalid");
      const r = await storage.retireSupersede(request.slug, request.replacements);
      return {
        project: storage.projectRoot,
        slug: request.slug,
        mode: "supersede",
        removed: r.removed,
        replacements: r.replacements,
        outcome: r.outcome
      };
    },
    async history(request: HistoryRequest): Promise<HistoryResult> {
      required(request.slug, "Slug");
      const all = await storage.history(request.slug),
        warning = (await storage.read(request.slug)).warnings,
        limit = request.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidInput("limit must be between 1 and 100");
      let before = all.length;
      if (request.cursor !== undefined) {
        if (!request.cursor) throw invalidInput("Invalid history cursor");
        try {
          const c = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
          if (c.schema !== 1 || c.slug !== request.slug || !Number.isInteger(c.before) || c.before < 0 || c.before > all.length) throw new Error();
          before = c.before;
        } catch {
          throw invalidInput("Invalid history cursor");
        }
      }
      const start = Math.max(0, before - limit),
        entries = all.slice(start, before).reverse();
      return {
        project: storage.projectRoot,
        slug: request.slug,
        entries,
        ...(start ? {
          nextCursor: Buffer.from(JSON.stringify({
            schema: 1,
            slug: request.slug,
            before: start
          }), "utf8").toString("base64url")
        } : {}),
        ...(warning?.length ? {
          warnings: warning
        } : {})
      };
    }
  };
}
