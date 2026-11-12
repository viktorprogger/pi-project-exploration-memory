import { Type } from "typebox";
import type { ExtensionAPI, ExtensionToolContext, InputEvent } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { ExplorationMemoryError } from "../../src/core/errors.ts";
import { createExplorationMemoryService } from "../../src/core/service.ts";
import type { CatalogResult, DetailsResult, HistoryResult, IntegrityWarning, MutationResult, RetireResult } from "../../src/core/contracts.ts";
type Result = CatalogResult | DetailsResult | MutationResult | HistoryResult | RetireResult;
const SLUG_PATTERN = "^[a-z0-9][a-z0-9_-]{0,127}$";
const RetireSlug = Type.String({
  minLength: 1,
  pattern: SLUG_PATTERN
});
const Project = Type.Optional(Type.String({
  description: "Optional project context."
}));
const CatalogParams = Type.Object({
  query: Type.Optional(Type.String({
    description: "Whitespace-separated, case-insensitive tokens. Every token must occur as a substring in slug, title, or description; empty query returns all entries. Content and history are not searched."
  })),
  project: Project
}, {
  additionalProperties: false
});
const DetailsParams = Type.Object({
  slugs: Type.Array(RetireSlug, {
    minItems: 1,
    uniqueItems: true,
    description: "Unique memory slugs."
  }),
  view: Type.Optional(Type.Union([Type.Literal("expanded"), Type.Literal("editable")])),
  project: Project
}, {
  additionalProperties: false
});
const WriteParams = Type.Object({
  slug: RetireSlug,
  title: Type.String({
    minLength: 1
  }),
  description: Type.String({
    minLength: 1
  }),
  content: Type.String(),
  reason: Type.String({
    minLength: 1
  }),
  project: Project
}, {
  additionalProperties: false
});
const EditParams = Type.Object({
  slug: RetireSlug,
  edits: Type.Array(Type.Object({
    oldText: Type.String({
      minLength: 1
    }),
    newText: Type.String({
      minLength: 1
    })
  }, {
    additionalProperties: false
  }), {
    minItems: 1
  }),
  reason: Type.String({
    minLength: 1
  }),
  title: Type.Optional(Type.String({
    minLength: 1
  })),
  description: Type.Optional(Type.String({
    minLength: 1
  })),
  project: Project
}, {
  additionalProperties: false
});
const HistoryParams = Type.Object({
  slug: RetireSlug,
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 100,
    description: "Maximum entries to return."
  })),
  cursor: Type.Optional(Type.String({
    minLength: 1,
    description: "Opaque cursor from a previous history result."
  })),
  project: Project
}, {
  additionalProperties: false
});
const RetireParams = Type.Union([Type.Object({
  slug: RetireSlug,
  mode: Type.Literal("archive"),
  reason: Type.String({
    minLength: 1
  }),
  project: Project
}, {
  additionalProperties: false
}), Type.Object({
  slug: RetireSlug,
  mode: Type.Literal("supersede"),
  reason: Type.String({
    minLength: 1
  }),
  replacements: Type.Array(RetireSlug, {
    minItems: 1,
    uniqueItems: true
  }),
  project: Project
}, {
  additionalProperties: false
})]);
const Output = Type.Any();
function freshness(result: DetailsResult["documents"][number]): string {
  if (result.freshness.status === "not_applicable") return "Freshness: not_applicable (historical)";
  const status = result.freshness.status === "valid" ? result.freshness.occurrences.length ? "all-valid (captured-sources)" : "all-valid (no-sources)" : `${result.freshness.status}; ` + result.freshness.occurrences.filter(o => o.status !== "valid").map(o => `${o.status} ${o.capture.path}#L${o.capture.startLine}-L${o.capture.endLine}`).join(", ");
  return `Freshness: ${status}`;
}
function integrityWarnings(result: Result): IntegrityWarning[] {
  const direct = "warnings" in result && result.warnings ? result.warnings : [];
  const nested = "documents" in result ? result.documents.flatMap(d => d.document.warnings ?? []) : [];
  const seen = new Set<string>();
  return [...direct, ...nested].filter(w => {
    const key = `${w.slug}:${w.expectedDocumentSha256}:${w.observedDocumentSha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function warningText(result: Result): string {
  return integrityWarnings(result).map(w => `⚠ INTEGRITY WARNING\nkind: ${w.kind}\nslug: ${w.slug}\nexpectedDocumentSha256: ${w.expectedDocumentSha256}\nobservedDocumentSha256: ${w.observedDocumentSha256}`).join("\n\n");
}
function text(result: Result): string {
  const warning = warningText(result);
  const body = "documents" in result ? result.documents.map(d => `# ${d.entry.title} (${d.entry.slug})${d.entry.status === "archived" ? " — archived historical content" : ""}\n\n${d.content}\n\n${freshness(d)}`).join("\n\n---\n\n") : "entries" in result && "slug" in result ? result.entries.length ? result.entries.map(e => `${e.timestamp}: ${e.reason}`).join("\n") : "No history entries." : "entries" in result ? result.entries.length ? result.entries.map(e => `${e.slug}: ${e.title} — ${e.description} [${e.status}]`).join("\n") : "No exploration memory documents found." : "mode" in result ? result.mode === "archive" ? `Archived ${result.slug} as historical content.` : `Superseded ${result.slug}; removed target after replacement verification.` : `Saved ${result.entry.slug}.`;
  return warning ? `${warning}\n\n${body}` : body;
}
function resultOf(result: Result) {
  return {
    content: [{
      type: "text" as const,
      text: text(result)
    }],
    details: result,
    structuredContent: result as unknown as JsonValue
  };
}
const MAX_EXPANDED_PROMPT_BYTES = 64 * 1024;
const SLUG = new RegExp(SLUG_PATTERN);
function macroText(result: DetailsResult): string {
  const document = result.documents[0]!;
  const warnings = result.warnings?.filter(w => w.slug === document.entry.slug);
  const scoped: DetailsResult = warnings?.length ? {
    ...result,
    documents: [document],
    warnings
  } : {
    ...result,
    documents: [document]
  };
  const rendered = text(scoped);
  const entries = document.entry.history.slice(0, 5);
  const history = `History (${document.entry.slug}):\n${entries.length ? entries.map(e => `${e.timestamp}: ${e.reason}`).join("\n") : "No history entries."}`;
  return `${rendered}\n\n${history}`;
}
function parseMacros(source: string): {
  parts: Array<string | number>;
  slugs: string[];
  changed: boolean;
} {
  const parts: Array<string | number> = [];
  const slugs: string[] = [];
  let changed = false;
  let last = 0;
  let i = 0;
  let lineStart = true;
  let lineIndent = 0;
  let fence: {
    character: "`" | "~";
    length: number;
  } | undefined;
  while (i < source.length) {
    const character = source[i]!;
    if (fence) {
      if (lineStart && character === " ") {
        lineIndent++;
        i++;
        continue;
      }
      if (lineStart && lineIndent <= 3 && character === fence.character) {
        let length = 0;
        while (source[i + length] === fence.character) length++;
        let trailing = i + length;
        while (source[trailing] === " " || source[trailing] === "\t") trailing++;
        if (length >= fence.length && (source[trailing] === "\n" || source[trailing] === "\r" && source[trailing + 1] === "\n" || trailing === source.length)) {
          i += length;
          lineStart = false;
          fence = undefined;
          continue;
        }
      }
      lineStart = character === "\n";
      if (lineStart) lineIndent = 0;
      i++;
      continue;
    }
    if (lineStart && character === " ") {
      lineIndent++;
      i++;
      continue;
    }
    if (lineStart && lineIndent <= 3 && (character === "`" || character === "~")) {
      let length = 0;
      while (source[i + length] === character) length++;
      if (length >= 3) {
        fence = {
          character,
          length
        };
        i += length;
        lineStart = false;
        continue;
      }
    }
    if (character === "`") {
      let length = 0;
      while (source[i + length] === "`") length++;
      let closing = i + length;
      while (closing < source.length) {
        if (source[closing] === "`") {
          let run = 0;
          while (source[closing + run] === "`") run++;
          if (run === length) break;
          closing += run;
        } else closing++;
      }
      if (closing < source.length) {
        i = closing + length;
        lineStart = false;
        continue;
      }
      i = source.length;
      break;
    }
    if (source.startsWith("[[pem:", i)) {
      let slashes = 0;
      for (let j = i - 1; j >= 0 && source[j] === "\\"; j--) slashes++;
      const end = source.indexOf("]]", i + 6);
      if (slashes % 2 === 1) {
        const escapedEnd = end < 0 ? source.length : end + 2;
        parts.push(source.slice(last, i - 1), source.slice(i, escapedEnd));
        changed = true;
        last = escapedEnd;
        i = escapedEnd;
        lineStart = escapedEnd > 0 && source[escapedEnd - 1] === "\n";
        if (lineStart) lineIndent = 0;
        continue;
      }
      if (end < 0) throw new Error("Malformed project memory macro");
      const slug = source.slice(i + 6, end);
      if (!SLUG.test(slug)) throw new Error("Malformed project memory macro");
      parts.push(source.slice(last, i), slugs.length);
      slugs.push(slug);
      last = end + 2;
      i = last;
      lineStart = false;
      continue;
    }
    lineStart = character === "\n";
    if (lineStart) lineIndent = 0;
    i++;
  }
  parts.push(source.slice(last));
  return {
    parts,
    slugs,
    changed
  };
}
async function handleInput(event: InputEvent, ctx: ExtensionToolContext): Promise<any> {
  if (event.source !== "interactive" && event.source !== "rpc") return {
    action: "continue"
  };
  let parsed: ReturnType<typeof parseMacros>;
  try {
    parsed = parseMacros(event.text);
  } catch (error) {
    try {
      ctx.ui?.notify?.(error instanceof Error ? error.message : String(error), "error");
    } catch {}
    return {
      action: "handled"
    };
  }
  if (!parsed.slugs.length && !parsed.changed) return {
    action: "continue"
  };
  if (!parsed.slugs.length) {
    const transformed = parsed.parts.join("");
    if (Buffer.byteLength(transformed, "utf8") > MAX_EXPANDED_PROMPT_BYTES) {
      try {
        ctx.ui?.notify?.("Expanded project memory prompt exceeds 64 KiB", "error");
      } catch {}
      return {
        action: "handled"
      };
    }
    return {
      action: "transform",
      text: transformed,
      ...(event.images ? {
        images: event.images
      } : {})
    };
  }
  try {
    const ordered = [...new Set(parsed.slugs)];
    const details = await service(ctx).details({
      slugs: ordered,
      view: "expanded"
    });
    const bySlug = new Map(details.documents.map(d => [d.entry.slug, macroText({
      ...details,
      documents: [d]
    })]));
    const transformed = parsed.parts.map(part => {
      if (typeof part === "string") return part;
      return bySlug.get(parsed.slugs[part]!)!;
    }).join("");
    if (Buffer.byteLength(transformed, "utf8") > MAX_EXPANDED_PROMPT_BYTES) throw new Error("Expanded project memory prompt exceeds 64 KiB");
    return {
      action: "transform",
      text: transformed,
      ...(event.images ? {
        images: event.images
      } : {})
    };
  } catch (error) {
    /* c8 ignore next 2 */
    try {
      ctx.ui?.notify?.(error instanceof Error ? error.message : String(error), "error");
    } catch {}
    return {
      action: "handled"
    };
  }
}
export function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof ExplorationMemoryError && error.details ? {
    error: message,
    outcome: error.details
  } : {
    error: message
  };
  return {
    content: [{
      type: "text" as const,
      text: message
    }],
    details,
    isError: true
  };
}
function service(ctx: ExtensionToolContext, project?: string) {
  return createExplorationMemoryService(ctx.cwd, project === undefined ? {} : {
    project
  });
}
function execute<T>(operation: () => Promise<T>, format: (value: T) => ReturnType<typeof resultOf>) {
  return operation().then(format).catch(failure);
}
export default function (pi: ExtensionAPI) {
  pi.on("input", handleInput as any);
  pi.registerTool({
    name: "project_memory_catalog",
    label: "Project memory catalog",
    description: "Find saved exploration memories by matching every whitespace-separated, case-insensitive query token as a substring of the slug, title, or description. Empty query returns all entries; content and history are not searched.",
    parameters: CatalogParams,
    outputSchema: Output,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    execute: async (_id, params, _signal, _update, ctx) => execute(() => service(ctx, params.project).catalog(params), resultOf)
  });
  pi.registerTool({
    name: "project_memory_details",
    label: "Project memory details",
    description: "Read current memory content, source captures, and freshness; use editable view before exact edits.",
    parameters: DetailsParams,
    outputSchema: Output,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    execute: async (_id, params, _signal, _update, ctx) => execute(() => service(ctx, params.project).details(params), resultOf)
  });
  pi.registerTool({
    name: "project_memory_write",
    label: "Write project memory",
    description: "Create or replace a project exploration memory and record the UTC reason.",
    parameters: WriteParams,
    outputSchema: Output,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    execute: async (_id, params, _signal, _update, ctx) => execute(() => service(ctx, params.project).write(params), resultOf)
  });
  pi.registerTool({
    name: "project_memory_edit",
    label: "Edit project memory",
    description: "Apply unique exact edits to current editable memory content and record the UTC reason.",
    parameters: EditParams,
    outputSchema: Output,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    execute: async (_id, params, _signal, _update, ctx) => execute(() => service(ctx, params.project).edit(params), resultOf)
  });
  pi.registerTool({
    name: "project_memory_history",
    label: "Project memory history",
    description: "Read a bounded newest-first history page for one memory.",
    parameters: HistoryParams,
    outputSchema: Output,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    execute: async (_id, params, _signal, _update, ctx) => execute(() => service(ctx, params.project).history(params), resultOf)
  });
  pi.registerTool({
    name: "project_memory_retire",
    label: "Retire project memory",
    description: "Archive a memory as preserved historical content with freshness skipped, or supersede it by deleting the target after verified replacement preconditions; supersede is best-effort and has no cross-file rollback guarantee.",
    parameters: RetireParams,
    outputSchema: Output,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    },
    execute: async (_id, params, _signal, _update, ctx) => execute(() => service(ctx, params.project).retire(params), resultOf)
  });
}
