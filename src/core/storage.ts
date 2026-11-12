import { createHash, randomBytes } from "node:crypto";
import { isAlias, isMap, isNode, isSeq, parseDocument as parseYamlDocument, stringify } from "yaml";
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { containedMemoryPath, resolveProject } from "./project-root.ts";
import { CATALOG_SCHEMA_VERSION, type Catalog, type CatalogEntry, type CurrentDocument, type HistoryEntry, type IntegrityWarning, type LifecycleStatus, type PublicationHook, type SourceCapture, type RetireOutcome, type PresenceState } from "./contracts.ts";
import { ExplorationMemoryError, invalidInput, notFound } from "./errors.ts";
export const documentSha256 = (b: Uint8Array | string) => createHash("sha256").update(typeof b === "string" ? Buffer.from(b) : b).digest("hex");
const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code,
  obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v),
  safeSlug = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(v),
  text = (v: unknown) => typeof v === "string" && !!v.trim();
const exact = (v: Record<string, unknown>, ks: readonly string[]) => Object.keys(v).length === ks.length && Object.keys(v).every(k => ks.includes(k));
/* c8 ignore next -- callers either provide a cause or structured retirement details; the empty-options arm is defensive. */
const fail = (c: "malformed_state" | "incomplete_or_inconsistent_state" | "persistence", m: string, e?: unknown, details?: RetireOutcome) => new ExplorationMemoryError(c, m, /* c8 ignore next -- the no-cause/no-details form is defensive construction only. */
e === undefined ? details === undefined ? undefined : {
  details
} : {
  cause: e,
  details
});
function decode(b: Uint8Array, o: string) {
  try {
    return new TextDecoder("utf-8", {
      fatal: true
    }).decode(b);
  } catch (e) {
    throw fail("incomplete_or_inconsistent_state", `Invalid UTF-8 in ${o}`, e);
  }
}
function validateCapture(v: unknown, o: string): asserts v is SourceCapture {
  if (!obj(v) || !(exact(v, ["path", "startLine", "endLine", "sha256", "content", "originalLiteral"]) || exact(v, ["path", "startLine", "endLine", "sha256", "content"]))) throw fail("malformed_state", `Malformed capture in ${o}`);
  if (typeof v.path !== "string" || !v.path || v.path.startsWith("/") || v.path.includes("\\") || v.path.split("/").some(x => !x || x === '.' || x === '..') || !Number.isSafeInteger(v.startLine) || !Number.isSafeInteger(v.endLine) || v.startLine as number < 1 || v.endLine as number < (v.startLine as number) || typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256) || typeof v.content !== "string" || "originalLiteral" in v && typeof v.originalLiteral !== "string") throw fail("malformed_state", `Malformed capture in ${o}`);
}
const status = (v: unknown): LifecycleStatus => v === undefined ? "actual" : v === "actual" || v === "archived" ? v : (() => {
  throw fail("malformed_state", "Invalid lifecycle status");
})();
const order = (a: CatalogEntry, b: CatalogEntry) => (a.status === "actual" ? 0 : 1) - (b.status === "actual" ? 0 : 1) || a.slug.localeCompare(b.slug);
function validateCatalog(v: unknown): Catalog {
  if (!obj(v) || v.schemaVersion !== 2 || !exact(v, ["schemaVersion", "entries"]) || !Array.isArray(v.entries)) {
    if (obj(v) && "schemaVersion" in v && v.schemaVersion !== 2) throw new ExplorationMemoryError("unsupported_schema", "Unsupported catalog schema version");
    throw fail("malformed_state", "Catalog is malformed");
  }
  const out: CatalogEntry[] = [];
  let previous: CatalogEntry | undefined;
  for (const e of v.entries) {
    if (!obj(e) || !(exact(e, ["slug", "title", "description", "documentSha256", "history", "status"]) || exact(e, ["slug", "title", "description", "documentSha256", "history"]))) throw fail("malformed_state", "Catalog entry is malformed");
    if (!safeSlug(e.slug) || !text(e.title) || !text(e.description) || typeof e.documentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.documentSha256) || !Array.isArray(e.history)) throw fail("malformed_state", "Catalog entry is malformed");
    const hs: HistoryEntry[] = [];
    let last = "";
    for (const h of e.history) {
      if (!obj(h) || !exact(h, ["timestamp", "reason"]) || typeof h.timestamp !== "string" || Number.isNaN(Date.parse(h.timestamp)) || !text(h.reason) || h.timestamp < last) throw fail("malformed_state", `History is malformed for ${e.slug}`);
      last = h.timestamp;
      hs.push(h as unknown as HistoryEntry);
    }
    const normalized = {
      ...e,
      status: status(e.status),
      history: hs
    } as CatalogEntry;
    if (previous && order(previous, normalized) >= 0) throw fail("malformed_state", "Catalog entries are not deterministically ordered");
    previous = normalized;
    out.push(normalized);
  }
  return {
    schemaVersion: 2,
    entries: out
  };
}
function rejectYaml(n: unknown, o: string): void {
  if (isAlias(n) || isNode(n) && ((n as any).anchor !== undefined || (n as any).tag !== undefined)) throw fail("malformed_state", `Unsupported YAML feature in ${o}`);
  if (isMap(n) || isSeq(n)) for (const i of (n as any).items) isMap(n) ? (rejectYaml(i.key, o), rejectYaml(i.value, o)) : rejectYaml(i, o);
}
function parseDocument(bytes: Uint8Array, slug: string): CurrentDocument {
  const s = decode(bytes, `${slug}.md`),
    m = /^(\uFEFF)?---(\r\n|\n)([\s\S]*?)(\r\n|\n)---(\r\n|\n)([\s\S]*)$/.exec(s);
  if (!m) throw fail("malformed_state", `Malformed front matter for ${slug}`);
  const source = m[3]!;
  if (source.includes("\uFEFF")) throw fail("malformed_state", `Metadata BOM is unsupported for ${slug}`);
  if (source.trimStart().startsWith("{") || source.trimStart().startsWith("[")) throw fail("malformed_state", `JSON front matter is unsupported for ${slug}`);
  try {
    const d = parseYamlDocument(source, {
      schema: "core",
      uniqueKeys: true,
      stringKeys: true
    });
    if (d.errors.length || d.warnings.length || !isMap(d.contents)) throw fail("malformed_state", `Cannot parse ${slug}.md front matter`);
    rejectYaml(d.contents, `${slug}.md front matter`);
    const meta = d.toJSON() as unknown;
    if (!obj(meta) || meta.schemaVersion !== 2) {
      if (obj(meta) && typeof meta.schemaVersion === "number" && meta.schemaVersion !== 2) throw new ExplorationMemoryError("unsupported_schema", `Unsupported document schema version for ${slug}`);
      throw fail("malformed_state", `Malformed front matter for ${slug}`);
    }
    if (!obj(meta) || !(exact(meta, ["schemaVersion", "slug", "captures", "status"]) || exact(meta, ["schemaVersion", "slug", "captures"])) || meta.slug !== slug || !Array.isArray(meta.captures)) throw fail("malformed_state", `Malformed front matter for ${slug}`);
    for (const c of meta.captures) validateCapture(c, slug);
    return {
      slug,
      content: m[6]!,
      captures: meta.captures as SourceCapture[],
      status: status(meta.status)
    };
  } catch (e) {
    /* c8 ignore next -- YAML parser failures are native errors; domain errors are rethrown defensively. */
    if (e instanceof ExplorationMemoryError) throw e;
    throw fail("malformed_state", `Cannot parse ${slug}.md front matter`, e);
  }
}
export interface StorageOptions {
  beforeRename?: (target: string) => void | Promise<void>;
  afterRename?: (target: string) => void | Promise<void>;
  beforeDelete?: (target: string) => void | Promise<void>;
  afterDelete?: (target: string) => void | Promise<void>;
  publicationHook?: PublicationHook;
}
export interface StoredProject {
  projectRoot: string;
  memoryRoot: string;
  catalog(): Promise<Catalog>;
  read(slug: string): Promise<CurrentDocument>;
  replace(document: Omit<CurrentDocument, "status"> & {
    status?: LifecycleStatus;
  }, metadata: Pick<CatalogEntry, "title" | "description">, reason: string): Promise<{
    document: CurrentDocument;
    entry: CatalogEntry;
  }>;
  archive(slug: string, reason: string): Promise<{
    document: CurrentDocument;
    entry: CatalogEntry;
  }>;
  retireSupersede(slug: string, replacements: string[]): Promise<{
    removed: boolean;
    replacements: string[];
    outcome: RetireOutcome;
  }>;
  history(slug: string): Promise<HistoryEntry[]>;
}
export function createStorage(cwd: string, project?: string, options: StorageOptions = {}): StoredProject {
  const resolved = resolveProject(cwd, project),
    memory = () => containedMemoryPath(resolved.projectRoot),
    file = (p: string) => containedMemoryPath(resolved.projectRoot, p),
    json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
  async function ensure() {
    await mkdir(file("documents"), {
      recursive: true
    });
  }
  async function artifacts(dir: string): Promise<boolean> {
    let es;
    try {
      es = await readdir(dir, {
        withFileTypes: true
      });
    } catch (e) {
      /* c8 ignore next -- non-ENOENT directory failures are filesystem defense-in-depth; callers cannot manufacture them through the public API. */
      if (code(e) === "ENOENT") return false;
      throw e;
    }
    for (const x of es) if (x.isFile() || x.isSymbolicLink() || (await artifacts(`${dir}/${x.name}`))) return true;
    return false;
  }
  async function rawCatalog() {
    try {
      return validateCatalog(JSON.parse(decode(new Uint8Array(Buffer.from(await readFile(file("catalog.json")))), "catalog.json")));
    } catch (e) {
      if (code(e) === "ENOENT") {
        if (await artifacts(memory())) throw fail("incomplete_or_inconsistent_state", "Catalog is missing while persisted memory files exist");
        await ensure();
        return {
          schemaVersion: 2 as const,
          entries: []
        };
      }
      if (e instanceof ExplorationMemoryError) throw e;
      throw fail("malformed_state", "Cannot parse catalog.json", e);
    }
  }
  async function atomic(target: string, data: Uint8Array | string) {
    const tmp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, data);
      await options.beforeRename?.(target);
      await rename(tmp, target);
      await options.afterRename?.(target);
    } finally {
      await rm(tmp, {
        force: true
      });
    }
  }
  async function read(slug: string) {
    if (!safeSlug(slug)) throw invalidInput("Slug must be a safe lowercase path segment");
    const c = await rawCatalog(),
      e = c.entries.find(x => x.slug === slug);
    if (!e) throw notFound(`Unknown memory document: ${slug}`);
    try {
      const b = new Uint8Array(await readFile(file(`documents/${slug}.md`))),
        d = parseDocument(b, slug);
      if (d.status !== e.status) throw fail("incomplete_or_inconsistent_state", `Status mismatch for ${slug}`);
      const h = documentSha256(b);
      if (h !== e.documentSha256) d.warnings = [{
        kind: "document_hash_mismatch",
        slug,
        expectedDocumentSha256: e.documentSha256,
        observedDocumentSha256: h
      }];
      return d;
    } catch (x) {
      if (x instanceof ExplorationMemoryError) throw x;
      throw fail("incomplete_or_inconsistent_state", `Missing current document for ${slug}`, x);
    }
  }
  async function replace(doc: CurrentDocument, metadata: Pick<CatalogEntry, "title" | "description">, reason: string) {
    if (!safeSlug(doc.slug)) throw invalidInput("Slug must be a safe lowercase path segment");
    if (!text(metadata.title) || !text(metadata.description) || !text(reason)) throw invalidInput("Title, description, and reason are required");
    for (const c of doc.captures) validateCapture(c, doc.slug);
    const c = await rawCatalog(),
      old = c.entries.find(e => e.slug === doc.slug);
    const st: LifecycleStatus = doc.status === undefined ? old?.status ?? "actual" : status(doc.status);
    if (old) {
      const current = await read(doc.slug);
      if (current.status === "archived") throw fail("incomplete_or_inconsistent_state", `Archived document cannot be replaced: ${doc.slug}`);
    } else if (st !== "actual") throw fail("incomplete_or_inconsistent_state", `New document must be actual: ${doc.slug}`);
    const entryBase = {
      slug: doc.slug,
      title: metadata.title,
      description: metadata.description,
      history: [...(old?.history ?? []), {
        timestamp: new Date().toISOString(),
        reason
      }],
      status: st
    };
    const markdown = `---\n${stringify({
        schemaVersion: 2,
        status: st,
        slug: doc.slug,
        captures: doc.captures
      }, {
        schema: "core",
        indent: 2,
        lineWidth: 0,
        aliasDuplicateObjects: false
      })}---\n${doc.content}`,
      bytes = Buffer.from(markdown),
      entry = {
        ...entryBase,
        documentSha256: documentSha256(bytes)
      },
      next = {
        schemaVersion: 2 as const,
        entries: [...c.entries.filter(e => e.slug !== doc.slug), entry].sort(order)
      };
    await atomic(file(`documents/${doc.slug}.md`), bytes);
    await atomic(file("catalog.json"), json(next));
    const clean = {
      slug: doc.slug,
      content: doc.content,
      captures: doc.captures,
      status: st
    } as CurrentDocument;
    await options.publicationHook?.published(clean, next);
    return {
      document: clean,
      entry
    };
  }
  async function archive(slug: string, reason: string) {
    if (!text(reason)) throw invalidInput("Reason is required");
    const d = await read(slug),
      e = (await rawCatalog()).entries.find(x => x.slug === slug)!;
    if (d.status === "archived") return {
      document: {
        ...d,
        status: "archived" as const
      },
      entry: {
        ...e,
        status: "archived" as const
      }
    };
    return replace({
      ...d,
      status: "archived"
    }, {
      title: e.title,
      description: e.description
    }, reason);
  }
  async function retireSupersede(slug: string, replacements: string[]) {
    if (!safeSlug(slug)) throw invalidInput("Slug must be a safe lowercase path segment");
    if (!Array.isArray(replacements) || !replacements.length || new Set(replacements).size !== replacements.length) throw invalidInput("At least one unique replacement slug is required");
    if (replacements.some(r => !safeSlug(r))) throw invalidInput("Replacement slug is invalid");
    const c = await rawCatalog(),
      target = c.entries.find(e => e.slug === slug);
    if (!target) throw notFound(`Unknown memory document: ${slug}`);
    const targetDoc = await read(slug);
    if (targetDoc.warnings?.length) throw fail("incomplete_or_inconsistent_state", `Target integrity warning: ${slug}`);
    for (const r of replacements) {
      if (r === slug) throw invalidInput("Replacement cannot be target");
      const d = await read(r);
      if (d.status === "archived") throw fail("incomplete_or_inconsistent_state", `Archived document cannot be used as replacement: ${r}`);
      if (d.warnings?.length) throw fail("incomplete_or_inconsistent_state", `Replacement integrity warning: ${r}`);
    }
    if (targetDoc.status === "archived") throw fail("incomplete_or_inconsistent_state", `Archived document cannot be superseded: ${slug}`);
    const md = file(`documents/${slug}.md`);
    const state = async (): Promise<RetireOutcome> => {
      let document: PresenceState = "unknown",
        catalogEntry: PresenceState = "unknown";
      try {
        await readFile(md);
        document = "present";
      } catch (e) {
        if (code(e) === "ENOENT") document = "absent";
      }
      try {
        const current = await rawCatalog();
        catalogEntry = (["absent", "present"] as const)[Number(current.entries.some(e => e.slug === slug))]!;
      } catch {
        catalogEntry = "unknown";
      }
      return {
        target: {
          document,
          catalogEntry
        }
      };
    };
    const failurePhase = (outcome: RetireOutcome) => ({
      present: "before target deletion",
      absent: "after target deletion",
      unknown: "uncertain whether target deletion occurred"
    } as const)[outcome.target.document];
    try {
      await options.beforeDelete?.(md);
      await unlink(md);
      await options.afterDelete?.(md);
    } catch (e) {
      const outcome = await state();
      throw fail("persistence", `Supersede cleanup failed ${failurePhase(outcome)}`, e, outcome);
    }
    const next = {
      schemaVersion: 2 as const,
      entries: c.entries.filter(e => e.slug !== slug).sort(order)
    };
    try {
      await atomic(file("catalog.json"), json(next));
    } catch (e) {
      throw fail("persistence", `Supersede cleanup partially completed; catalog replacement failed`, e, await state());
    }
    return {
      removed: true,
      replacements,
      outcome: {
        target: {
          document: "absent" as const,
          catalogEntry: "absent" as const
        }
      }
    };
  }
  async function history(slug: string) {
    const c = await rawCatalog(),
      e = c.entries.find(x => x.slug === slug);
    if (!e) throw notFound(`Unknown memory document: ${slug}`);
    await read(slug);
    return e.history;
  }
  return {
    projectRoot: resolved.projectRoot,
    memoryRoot: memory(),
    catalog: rawCatalog,
    read,
    replace,
    archive,
    retireSupersede,
    history
  };
}
export { validateCatalog, parseDocument };
