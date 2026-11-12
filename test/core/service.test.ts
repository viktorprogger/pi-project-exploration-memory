// @ts-nocheck
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createExplorationMemoryService } from "../../src/core/service.ts";

const temp = () => mkdtemp(path.join(os.tmpdir(), "service-core-"));
const md = (r: string, s: string) => path.join(r, ".pi", "project-exploration-memory", "documents", `${s}.md`);
const cat = (r: string) => path.join(r, ".pi", "project-exploration-memory", "catalog.json");

test("write/edit return exact content and recover a readable mismatch", async () => {
  const root = await temp(); try {
    const m = createExplorationMemoryService(root); await m.write({ slug: "a", title: "A", description: "D", content: "one two", reason: "create" });
    const bytes = await readFile(md(root, "a")); const changed = Buffer.from(bytes.toString().replace("one two", "stale two")); await writeFile(md(root, "a"), changed);
    const details = await m.details({ slugs: ["a"] }); assert.equal(details.documents[0]!.content, "stale two");
    const warning = details.warnings?.[0]; assert.equal(warning?.kind, "document_hash_mismatch"); assert.equal(warning?.expectedDocumentSha256, JSON.parse(await readFile(cat(root), "utf8")).entries[0].documentSha256);
    assert.deepEqual((await m.catalog({})).warnings, [warning]); assert.deepEqual((await m.history({ slug: "a" })).warnings, [warning]);
    const editedMismatch = await m.edit({ slug: "a", edits: [{ oldText: "stale", newText: "repaired" }], reason: "edit mismatch" }); assert.equal(editedMismatch.document.content, "repaired two");
    const replacement = await m.write({ slug: "a", title: "A", description: "D", content: "fresh", reason: "repair" }); assert.equal(replacement.document.content, "fresh");
    const edited = await m.edit({ slug: "a", edits: [{ oldText: "fresh", newText: "freshly edited" }], reason: "edit" }); assert.equal(edited.document.content, "freshly edited"); assert.equal((await m.catalog({})).warnings, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed state is not mutable, while ordinary history/details remain public", async () => {
  const root = await temp(); try {
    const m = createExplorationMemoryService(root); await m.write({ slug: "a", title: "A", description: "D", content: "old", reason: "create" }); await writeFile(md(root, "a"), "not front matter");
    await assert.rejects(() => m.edit({ slug: "a", edits: [{ oldText: "old", newText: "new" }], reason: "edit" }));
    await assert.rejects(() => m.write({ slug: "a", title: "A", description: "D", content: "new", reason: "replace" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("details use latest five history entries and history pages newest entries", async () => {
  const root = await temp(); try {
    const m = createExplorationMemoryService(root); for (let i = 0; i < 7; i++) await m.write({ slug: "a", title: "A", description: "D", content: String(i), reason: String(i) });
    const details = await m.details({ slugs: ["a"] }); assert.deepEqual(details.documents[0]!.entry.history.map(x => x.reason), ["2", "3", "4", "5", "6"]);
    const all = await m.history({ slug: "a" }); assert.deepEqual(all.entries.map(x => x.reason), ["6", "5", "4", "3", "2", "1", "0"]);
    const page = await m.history({ slug: "a", limit: 2 }); assert.deepEqual(page.entries.map(x => x.reason), ["6", "5"]); assert.ok(page.nextCursor);
    const older = await m.history({ slug: "a", limit: 2, cursor: page.nextCursor }); assert.deepEqual(older.entries.map(x => x.reason), ["4", "3"]); assert.ok(older.nextCursor);
    const final = await m.history({ slug: "a", limit: 2, cursor: older.nextCursor }); assert.deepEqual(final.entries.map(x => x.reason), ["2", "1"]); assert.ok(final.nextCursor);
    const last = await m.history({ slug: "a", limit: 2, cursor: final.nextCursor }); assert.deepEqual(last.entries.map(x => x.reason), ["0"]); assert.equal(last.nextCursor, undefined);
    const maxPage = await m.history({ slug: "a", limit: 100 }); assert.deepEqual(maxPage.entries.map(x => x.reason), ["6", "5", "4", "3", "2", "1", "0"]);
    const empty = await m.history({ slug: "a", limit: 2, cursor: Buffer.from(JSON.stringify({ schema: 1, slug: "a", before: 0 }), "utf8").toString("base64url") }); assert.deepEqual(empty.entries, []); assert.equal(empty.nextCursor, undefined);
    for (const before of [-1, 8]) {
      const cursor = Buffer.from(JSON.stringify({ schema: 1, slug: "a", before }), "utf8").toString("base64url");
      await assert.rejects(() => m.history({ slug: "a", cursor }), (e: any) => e?.category === "invalid_input");
    }
    assert.ok(details.documents[0]!.entry.history.every(x => !Number.isNaN(Date.parse(x.timestamp))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source readFile fallback, default views, and edit options are public contract paths", async () => {
  const root = await temp(); try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "fallback.ts"), "filesystem line\nother line");
    const m = createExplorationMemoryService(root, { readFile: async () => new TextEncoder().encode("fallback line\nother line") });
    await m.write({ slug: "a", title: "A", description: "D", content: "src/fallback.ts#L1 and src/fallback.ts#L2", reason: "create" });
    assert.deepEqual((await m.details({ slugs: ["a"] })).documents[0]!.freshness.occurrences.map(x => x.status), ["valid", "valid"]);
    assert.equal((await m.details({ slugs: ["a"] })).view, "expanded");
    const edited = await m.edit({ slug: "a", title: "Updated", description: "Changed", edits: [{ oldText: "src/fallback.ts#L2", newText: "second" }, { oldText: "src/fallback.ts#L1", newText: "first" }], reason: "options" });
    assert.equal(edited.entry.title, "Updated"); assert.equal(edited.entry.description, "Changed");
    assert.equal((await m.details({ slugs: ["a"], view: "editable" })).documents[0]!.content, "first and second");

    await m.write({ slug: "b", title: "B", description: "D", content: "AB", reason: "create" });
    await m.edit({ slug: "b", edits: [{ oldText: "B", newText: "b" }, { oldText: "A", newText: "a" }], reason: "disjoint" });
    const catalog = JSON.parse(await readFile(cat(root), "utf8")); catalog.entries.find((e: any) => e.slug === "b").history = [];
    await writeFile(cat(root), JSON.stringify(catalog));
    assert.deepEqual((await m.history({ slug: "b" })).entries, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project override and source evidence freshness are preserved", async () => {
  const root = await temp(); const other = await temp(); try {
    const source = { read: async () => ({ bytes: new TextEncoder().encode("line one\nline two"), text: "line one\nline two" }) };
    const m = createExplorationMemoryService(root, { project: other, sourceReader: source }); const result = await m.write({ slug: "a", title: "A", description: "D", content: "See a.ts#L1", reason: "create" });
    assert.equal(result.project, other); const d = await m.details({ slugs: ["a"] }); assert.equal(d.summary.status, "valid"); assert.equal(d.documents[0]!.document.captures.length, 1); assert.equal(d.documents[0]!.freshness.occurrences[0]!.status, "valid");
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test("service validates requests, filters catalog, and handles editable details", async () => {
  const root = await temp(); try {
    const m = createExplorationMemoryService(root);
    for (const slugs of [[], ["a", "a"], ["a", 1 as any], ["a", null as any]])
      await assert.rejects(() => m.details({ slugs: slugs as any }), (e: any) => e?.category === "invalid_input" && e.name === "ExplorationMemoryError" && e.message === "At least one unique slug is required");
    await m.write({ slug: "a", title: "Alpha", description: "First", content: "hello", reason: "create" });
    await m.write({ slug: "b", title: "Beta", description: "Second", content: "bye", reason: "create" });
    assert.deepEqual((await m.catalog({ query: "  ALPHA   first  " })).entries.map(e => e.slug), ["a"]);
    assert.equal((await m.catalog({ query: "alpha second" })).entries.length, 0);
    assert.equal((await m.catalog({ query: "alpha\nfirst" })).entries.length, 1);
    assert.equal((await m.catalog({ query: "missing" })).entries.length, 0);
    assert.equal((await m.details({ slugs: ["a"], view: "editable" })).documents[0]!.content, "hello");
    assert.equal((await m.details({ slugs: ["a"] })).view, "expanded");
    assert.equal((await m.details({ slugs: ["a"] })).summary.status, "valid");
    assert.equal((await m.details({ slugs: ["a"] })).warnings, undefined);
    assert.equal((await m.history({ slug: "a" })).warnings, undefined);
    await assert.rejects(() => m.details({ slugs: ["a"], view: "bad" as any }), (e: any) => e?.category === "invalid_input" && e.message === "Invalid details view");
    for (const [request, message] of [
      [{ slug: 1 as any, title: "T", description: "D", content: "x", reason: "r" }, "Slug is required"],
      [{ slug: "b", title: null as any, description: "D", content: "x", reason: "r" }, "Title is required"],
      [{ slug: "b", title: "T", description: 1 as any, content: "x", reason: "r" }, "Description is required"],
      [{ slug: "b", title: "T", description: "D", content: "x", reason: null as any }, "Reason is required"],
      [{ slug: " ", title: "T", description: "D", content: "x", reason: "r" }, "Slug is required"],
      [{ slug: "b", title: " ", description: "D", content: "x", reason: "r" }, "Title is required"],
      [{ slug: "b", title: "T", description: "\t", content: "x", reason: "r" }, "Description is required"],
      [{ slug: "b", title: "T", description: "D", content: "x", reason: "\n", }, "Reason is required"],
    ] as const) await assert.rejects(() => m.write(request), (e: any) => e?.category === "invalid_input" && e.message === message);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("edit rejects malformed and ambiguous operations and preserves metadata defaults", async () => {
  const root = await temp(); try {
    const m = createExplorationMemoryService(root); await m.write({ slug: "a", title: "A", description: "D", content: "one one", reason: "create" });
    for (const edits of [[], null, [null], [{}], [{ oldText: 1 as any, newText: "x" }], [{ oldText: "one", newText: 2 as any }], [{ oldText: "", newText: "x" }], [{ oldText: "one", newText: "" }], [{ oldText: "absent", newText: "x" }], [{ oldText: "one", newText: "x" }], [{ oldText: "one", newText: "x" }, { oldText: "one", newText: "y" }]])
      await assert.rejects(() => m.edit({ slug: "a", edits: edits as any, reason: "bad" }), (e: any) => e?.category === "invalid_input" && (e.message === "At least one edit is required" || e.message === "Each edit requires non-empty oldText and newText strings" || e.message === "Each oldText must occur exactly once"));
    await assert.rejects(() => m.edit({ slug: "a", edits: [{ oldText: "one", newText: "x" }], reason: "" }), (e: any) => e?.category === "invalid_input" && e.message === "Reason is required");
    await m.write({ slug: "b", title: "B", description: "D", content: "abc", reason: "create" });
    await assert.rejects(() => m.edit({ slug: "b", edits: [{ oldText: "ab", newText: "x" }, { oldText: "bc", newText: "y" }], reason: "overlap" }), (e: any) => e?.category === "invalid_input" && e.message === "Edits overlap");
    const adjacent = await m.edit({ slug: "b", edits: [{ oldText: "ab", newText: "AB" }, { oldText: "c", newText: "C" }], reason: "adjacent" });
    assert.equal(adjacent.document.content, "ABC");
    await m.write({ slug: "c", title: "C", description: "D", content: "alpha beta gamma", reason: "create" });
    const reverse = await m.edit({ slug: "c", edits: [{ oldText: "gamma", newText: "G" }, { oldText: "alpha", newText: "ALPHA-EXPANDED" }], reason: "reverse" });
    assert.equal(reverse.document.content, "ALPHA-EXPANDED beta G");
    const result = await m.edit({ slug: "a", edits: [{ oldText: "one one", newText: "done" }], reason: "edit" });
    assert.equal(result.entry.title, "A"); assert.equal(result.entry.description, "D"); assert.equal(result.document.content, "done");
    await assert.rejects(() => m.details({ slugs: ["unknown"] }), (e: any) => e?.category === "not_found" && e.name === "ExplorationMemoryError" && e.message === "Unknown memory document: unknown");
    await assert.rejects(() => m.edit({ slug: "unknown", edits: [{ oldText: "x", newText: "y" }], reason: "edit" }), (e: any) => e?.category === "not_found");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lifecycle views archived content without freshness and reject archived mutations", async () => {
  const root = await temp(); try {
    const m = createExplorationMemoryService(root, { sourceReader: { read: async () => ({ bytes: new TextEncoder().encode("changed"), text: "changed" }) } });
    await m.write({ slug: "a", title: "A", description: "D", content: "a.ts#L1", reason: "create" });
    const archived = await m.retire({ slug: "a", mode: "archive", reason: "retire" });
    assert.equal(archived.status, "archived");
    const details = await m.details({ slugs: ["a"] });
    assert.equal(details.summary.status, "not_applicable");
    assert.equal(details.documents[0]!.freshness.occurrences[0]!.status, "not_applicable");
    assert.equal((await m.catalog({})).entries[0]!.status, "archived");
    await assert.rejects(() => m.edit({ slug: "a", edits: [{ oldText: "a.ts#L1", newText: "other.ts#L1" }], reason: "edit" }), (e: any) => e?.category === "invalid_input" && e.message === "Archived documents cannot be modified");
    const again = await m.retire({ slug: "a", mode: "archive", reason: "again" });
    assert.equal(again.status, "archived");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy lifecycle fields default to actual without rewriting", async () => {
  const root = await temp(); try {
    const m = createExplorationMemoryService(root);
    await m.write({ slug: "legacy", title: "L", description: "D", content: "body", reason: "create" });
    const documentPath = md(root, "legacy");
    await writeFile(documentPath, (await readFile(documentPath, "utf8")).replace("status: actual\\n", ""));
    const catalog = JSON.parse(await readFile(cat(root), "utf8")); delete catalog.entries[0].status;
    await writeFile(cat(root), JSON.stringify(catalog));
    const result = await m.details({ slugs: ["legacy"] });
    assert.equal(result.documents[0]!.document.status, "actual");
    assert.equal(result.documents[0]!.entry.status, "actual");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retire validates supersede mode and replacement integrity", async () => {
  const root = await temp(); try {
    const m = createExplorationMemoryService(root);
    await m.write({ slug: "a", title: "A", description: "D", content: "a", reason: "create" });
    await assert.rejects(() => m.retire({ slug: "a", mode: "bad" as any, reason: "r" }), (e: any) => e?.category === "invalid_input");
    for (const replacements of [[], ["b", "b"], ["bad slug"]])
      await assert.rejects(() => m.retire({ slug: "a", mode: "supersede", replacements, reason: "r" }), (e: any) => e?.category === "invalid_input");
    await assert.rejects(() => m.retire({ slug: "a", mode: "supersede", replacements: ["a"], reason: "r" }), (e: any) => e?.category === "invalid_input" && e.message === "Replacement cannot be target");
    await m.write({ slug: "b", title: "B", description: "D", content: "b", reason: "create" });
    const bBytes = await readFile(md(root, "b"));
    await writeFile(md(root, "b"), Buffer.from(bBytes.toString().replace(/\nb$/, "\nchanged")));
    await assert.rejects(() => m.retire({ slug: "a", mode: "supersede", replacements: ["b"], reason: "r" }), (e: any) => e?.category === "incomplete_or_inconsistent_state" && e.message === "Replacement integrity warning: b");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("history validates limits and cursors and freshness reports warning statuses", async () => {
  const root = await temp(); try {
    let checking = false; const source = { read: async (p: string) => {
      if (checking && p === "missing.ts") { const e: any = new Error("missing"); e.code = "ENOENT"; throw e; }
      if (checking && p === "bad.ts") throw new Error("unreadable");
      const text = checking && p === "changed.ts" ? "changed\nline" : "original\nline"; return { bytes: new TextEncoder().encode(text), text };
    }};
    const m = createExplorationMemoryService(root, { sourceReader: source });
    await m.write({ slug: "a", title: "A", description: "D", content: "changed.ts#L1 missing.ts#L1 bad.ts#L1", reason: "create" });
    checking = true; const d = await m.details({ slugs: ["a"] }); assert.equal(d.summary.status, "unreadable"); assert.deepEqual(d.documents[0]!.freshness.occurrences.map(x => x.status), ["changed", "missing", "unreadable"]);
    for (const limit of [0, 101, 1.5]) await assert.rejects(() => m.history({ slug: "a", limit }), (e: any) => e?.category === "invalid_input");
    const atEnd = Buffer.from(JSON.stringify({ schema: 1, slug: "a", before: 1 }), "utf8").toString("base64url");
    assert.equal((await m.history({ slug: "a", cursor: atEnd })).entries[0]?.reason, "create");
    for (const cursor of ["", "not-base64", Buffer.from(JSON.stringify({ schema: 2, slug: "a", before: 0 })).toString("base64url"), Buffer.from(JSON.stringify({ schema: 1, slug: "b", before: 0 })).toString("base64url"), Buffer.from(JSON.stringify({ schema: 1, slug: "a", before: 2 })).toString("base64url")])
      await assert.rejects(() => m.history({ slug: "a", cursor }), (e: any) => e?.category === "invalid_input");
    await assert.rejects(() => m.history({ slug: "unknown" }), (e: any) => e?.category === "not_found");
  } finally { await rm(root, { recursive: true, force: true }); }
});
