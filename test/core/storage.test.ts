import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { createStorage, documentSha256, validateCatalog } from "../../src/core/storage.ts";

const fresh = () => mkdtemp(path.join(os.tmpdir(), "memory-core-"));
const memory = (root: string) => path.join(root, ".pi", "project-exploration-memory");
const mdPath = (root: string, slug = "x") => path.join(memory(root), "documents", `${slug}.md`);
const catalogPath = (root: string) => path.join(memory(root), "catalog.json");
const front = (slug: string, body: string, eol = "\n", bom = "") => `${bom}---${eol}schemaVersion: 2${eol}slug: ${slug}${eol}captures: []${eol}---${eol}${body}`;
const yamlFront = (metadata: unknown, body = "body") => `---\n${stringify(metadata)}---\n${body}`;
const catalog = (slug: string, bytes: Uint8Array | string, extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 2, entries: [{ slug, title: "Title", description: "Description", documentSha256: documentSha256(bytes), history: [], ...extra }] });
const put = async (root: string, slug: string, markdown: string | Uint8Array, hashBytes: Uint8Array | string = markdown) => {
  await mkdir(path.dirname(mdPath(root, slug)), { recursive: true });
  await writeFile(mdPath(root, slug), markdown);
  await writeFile(catalogPath(root), catalog(slug, hashBytes));
};
const category = (name: string) => (e: any) => e?.category === name;

 test("empty initialization succeeds, but missing catalog with file, directory, temp, or legacy artifacts fails", async () => {
  const root = await fresh(); try {
    assert.deepEqual(await createStorage(root).catalog(), { schemaVersion: 2, entries: [] });
    for (const artifact of ["documents/x.md", "documents/legacy", "catalog.json.tmp", "documents/x/revisions/1.md"]) {
      await rm(memory(root), { recursive: true, force: true });
      await mkdir(path.dirname(path.join(memory(root), artifact)), { recursive: true });
      if (artifact !== "documents") await writeFile(path.join(memory(root), artifact), "artifact");
      await assert.rejects(() => createStorage(root).catalog(), category("incomplete_or_inconsistent_state"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publication has exactly catalog and Markdown, with strict schema-2 fields and documentSha256", async () => {
  const root = await fresh(); try {
    const s = createStorage(root); const result = await s.replace({ slug: "x", content: "hello", captures: [] }, { title: "Title", description: "Description" }, "create");
    const c = JSON.parse(await readFile(catalogPath(root), "utf8"));
    assert.deepEqual(Object.keys(c), ["schemaVersion", "entries"]);
    assert.deepEqual(Object.keys(c.entries[0]).sort(), ["description", "documentSha256", "history", "slug", "title"]);
    assert.equal(c.entries[0].documentSha256, documentSha256(await readFile(mdPath(root))));
    assert.equal(result.document.content, "hello");
    assert.deepEqual((await readdir(path.join(memory(root), "documents"))).sort(), ["x.md"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("front matter preserves escaped JSON values and nested capture objects", async () => {
  const root = await fresh(); try {
    const capture = { path: "src/file.ts", startLine: 1, endLine: 2, sha256: "a".repeat(64), content: 'quoted "value"\nnext', originalLiteral: "\\literal" };
    const bytes = Buffer.from(`---\n${stringify({ schemaVersion: 2, slug: "x", captures: [capture] })}---\nbody`);
    await put(root, "x", bytes);
    const document = await createStorage(root).read("x");
    assert.deepEqual(document.captures, [capture]);
    assert.equal(document.content, "body");

    const escapedCatalog = JSON.stringify({ schemaVersion: 2, entries: [{ slug: "x", title: 'Title with "quotes"', description: "line\nvalue", documentSha256: documentSha256(bytes), history: [] }] });
    await writeFile(catalogPath(root), escapedCatalog);
    assert.equal((await createStorage(root).catalog()).entries[0]!.title, 'Title with "quotes"');

    const spaced = Buffer.from('---\nschemaVersion: 2\nslug: x\ncaptures: []\n---\nspaced');
    await put(root, "x", spaced);
    assert.equal((await createStorage(root).read("x")).content, "spaced");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("YAML front matter rejects JSON flow, duplicate keys, unsafe features, and coercion", async () => {
  const root = await fresh(); try {
    const cases = [
      `---\n{schemaVersion: 2, slug: x, captures: []}\n---\nbody`,
      `---\nschemaVersion: 2\nschemaVersion: 2\nslug: x\ncaptures: []\n---\nbody`,
      `---\nschemaVersion: 2\nslug: x\ncaptures:\n  - path: a.ts\n    path: b.ts\n    startLine: 1\n    endLine: 1\n    sha256: ${"0".repeat(64)}\n    content: x\n---\nbody`,
      `---\nschemaVersion: 2\nslug: x\nextra: true\ncaptures: []\n---\nbody`,
      `---\nschemaVersion: 2\nslug: x\ncaptures: []\n...\nfoo: bar\n---\nbody`,
      `---\nschemaVersion: 2\nslug: x\ncaptures: [*capture]\n---\nbody`,
      `---\nschemaVersion: 2\nslug: x\ncaptures: [!!str nope]\n---\nbody`,
      `---\nschemaVersion: yes\nslug: x\ncaptures: []\n---\nbody`,
    ];
    for (const raw of cases) { await put(root, "x", Buffer.from(raw)); await assert.rejects(() => createStorage(root).read("x"), category("malformed_state")); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("valid legacy JSON front matter is rejected explicitly for objects and arrays", async () => {
  const root = await fresh(); try {
    const metadata = { schemaVersion: 2, slug: "x", captures: [] };
    for (const legacy of [JSON.stringify(metadata), JSON.stringify([metadata])]) {
      for (const prefix of [" ", "\t  "]) {
        const bytes = Buffer.from(`---\n${prefix}${legacy}\n---\nbody`);
      await put(root, "x", bytes);
        await assert.rejects(
          () => createStorage(root).read("x"),
          (error: any) => error?.category === "malformed_state" && error?.message === "JSON front matter is unsupported for x",
        );
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("captures without originalLiteral round-trip through replace", async () => {
  const root = await fresh(); try {
    const capture = { path: "src/file.ts", startLine: 1, endLine: 2, sha256: "a".repeat(64), content: "line 1\nline 2" };
    const storage = createStorage(root);
    await storage.replace({ slug: "x", content: "body", captures: [capture] }, { title: "T", description: "D" }, "create");
    assert.deepEqual((await storage.read("x")).captures, [capture]);
    assert.equal(Object.hasOwn((await storage.read("x")).captures[0]!, "originalLiteral"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("replace duplicates captures without emitting YAML anchors or aliases", async () => {
  const root = await fresh(); try {
    const capture = { path: "src/file.ts", startLine: 1, endLine: 2, sha256: "a".repeat(64), content: "line 1\nline 2" };
    const storage = createStorage(root);
    await storage.replace({ slug: "x", content: "body", captures: [capture, capture] }, { title: "T", description: "D" }, "create");
    const persisted = (await readFile(mdPath(root), "utf8"));
    assert.doesNotMatch(persisted, /[&*][A-Za-z0-9_-]+/);
    assert.deepEqual((await storage.read("x")).captures, [capture, capture]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("YAML capture scalars round-trip without changing body or exact hash", async () => {
  const root = await fresh(); try {
    const captures = [{ path: "src/file.ts", startLine: 1, endLine: 2, sha256: "a".repeat(64), content: "first\n\nlast\n", originalLiteral: "" }];
    const storage = createStorage(root);
    await storage.replace({ slug: "x", content: "body\r\nexact", captures }, { title: "Title", description: "Description" }, "create");
    const bytes = await readFile(mdPath(root));
    assert.match(bytes.toString(), /schemaVersion: 2\nslug: x\ncaptures:/);
    assert.equal(documentSha256(bytes), (await storage.catalog()).entries[0]!.documentSha256);
    assert.deepEqual((await storage.read("x")).captures, captures);
    assert.equal((await storage.read("x")).content, "body\r\nexact");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("front matter preserves grammar, bodies, BOM, CRLF, and exact byte hashing", async () => {
  const root = await fresh(); try {
    for (const [name, bytes, body] of [
      ["empty", Buffer.from(front("x", "")), ""], ["hello", Buffer.from(front("x", "hello")), "hello"],
      ["leading", Buffer.from(front("x", "\nhello")), "\nhello"], ["final", Buffer.from(front("x", "hello\n")), "hello\n"],
      ["bom", Buffer.from(front("x", "\uFEFFbody", "\n", "\uFEFF")), "\uFEFFbody"],
      ["crlf", Buffer.from(front("x", "hello\r\n", "\r\n")), "hello\r\n"],
    ] as const) {
      await put(root, "x", bytes); const d = await createStorage(root).read("x"); assert.equal(d.content, body, name); assert.equal(documentSha256(bytes), JSON.parse(await readFile(catalogPath(root), "utf8")).entries[0].documentSha256);
    }
    await put(root, "x", "---\nnull\n---"); await assert.rejects(() => createStorage(root).read("x"), category("malformed_state"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("front matter rejects duplicate, extra/trailing fields, schema/slug mismatch, malformed captures, and invalid UTF-8", async () => {
  const root = await fresh(); try {
    const cases = [
      `---\n{"schemaVersion":2,"schemaVersion":2,"slug":"x","captures":[]}\n---\nbody`,
      `---\n{"schemaVersion":2,"slug":"x","captures":[],"extra":1}\n---\nbody`,
      `---\nschemaVersion: 2\nslug: x\ncaptures: []\nextra: 1\n---\nbody`,
      `---\nschemaVersion: 2\nslug: x\ncaptures: [] trailing\n---\nbody`,
      `---\nnull\n---\nbody`,
      `---\nschemaVersion: 1\nslug: x\ncaptures: []\n---\nbody`,
      `---\nschemaVersion: 2\nslug: y\ncaptures: []\n---\nbody`,
      `---\nschemaVersion: 2\nslug: x\ncaptures:\n  - path: ../bad\n    startLine: 1\n    endLine: 1\n    sha256: ${"0".repeat(64)}\n    content: x\n---\nbody`,
    ];
    for (const raw of cases) { const bytes = Buffer.from(raw); await put(root, "x", bytes); await assert.rejects(() => createStorage(root).read("x"), raw.includes("schemaVersion: 1") ? category("unsupported_schema") : category("malformed_state")); }
    await put(root, "x", Buffer.from([0xff, 0xfe])); await assert.rejects(() => createStorage(root).read("x"), category("incomplete_or_inconsistent_state"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("non-ENOENT artifact and document read failures remain failures", async () => {
  const root = await fresh(); try {
    await mkdir(path.join(root, ".pi"), { recursive: true });
    await writeFile(memory(root), "not a directory");
    await assert.rejects(() => createStorage(root).catalog(), (error: any) => error?.code !== "ENOENT");

    await rm(root, { recursive: true, force: true });
    await mkdir(path.join(memory(root), "empty", "nested"), { recursive: true });
    assert.deepEqual(await createStorage(root).catalog(), { schemaVersion: 2, entries: [] });
    await rm(root, { recursive: true, force: true });
    await mkdir(memory(root), { recursive: true });
    await symlink("missing-target", path.join(memory(root), "orphan-link"));
    await assert.rejects(() => createStorage(root).catalog(), category("incomplete_or_inconsistent_state"));
    await rm(root, { recursive: true, force: true });
    await mkdir(memory(root), { recursive: true });
    await mkdir(path.join(memory(root), "catalog.json"));
    await assert.rejects(() => createStorage(root).catalog(), category("malformed_state"));
    await rm(root, { recursive: true, force: true });
    const bytes = Buffer.from(front("x", "body")); await put(root, "x", bytes);
    await rm(mdPath(root), { force: true }); await mkdir(mdPath(root));
    await assert.rejects(() => createStorage(root).read("x"), category("incomplete_or_inconsistent_state"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema-1 catalogs and revision artifacts are unsupported, never migrated", async () => {
  const root = await fresh(); try {
    await mkdir(path.join(memory(root), "documents", "x", "revisions"), { recursive: true }); await writeFile(catalogPath(root), JSON.stringify({ schemaVersion: 1, entries: [] }));
    await assert.rejects(() => createStorage(root).catalog(), category("unsupported_schema"));
    await rm(memory(root), { recursive: true, force: true }); await mkdir(path.join(memory(root), "documents", "x", "revisions"), { recursive: true });
    const bytes = Buffer.from(front("x", "body")); await writeFile(catalogPath(root), catalog("x", bytes)); await writeFile(path.join(memory(root), "documents", "x", "revisions", "1.md"), bytes);
    await assert.rejects(() => createStorage(root).read("x"), category("incomplete_or_inconsistent_state"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("readable hash mismatch is a warning with hashes and content, while malformed state is hard error", async () => {
  const root = await fresh(); try {
    const bytes = Buffer.from(front("x", "readable")); await put(root, "x", bytes, Buffer.from(front("x", "different")));
    const d = await createStorage(root).read("x"); assert.equal(d.content, "readable"); assert.deepEqual(d.warnings, [{ kind: "document_hash_mismatch", slug: "x", expectedDocumentSha256: documentSha256(Buffer.from(front("x", "different"))), observedDocumentSha256: documentSha256(bytes) }]);
    await writeFile(mdPath(root), "bad"); await assert.rejects(() => createStorage(root).read("x"), category("malformed_state"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("catalog validation rejects unsupported, extra, duplicate, ordering, and history states", async () => {
  const root = await fresh(); try {
    const cases: [string, string][] = [
      [JSON.stringify({ schemaVersion: 1, entries: [] }), "unsupported_schema"],
      [JSON.stringify({ schemaVersion: 2, entries: {}, extra: true }), "malformed_state"],
      [`{"schemaVersion":2,"schemaVersion":2,"entries":[]}`, "malformed_state"],
      [JSON.stringify({ schemaVersion: 2, entries: [{ slug: "x", title: "T", description: "D", documentSha256: "0".repeat(64), history: [], extra: 1 }] }), "malformed_state"],
      [JSON.stringify({ schemaVersion: 2, entries: [{ slug: "X", title: "T", description: "D", documentSha256: "0".repeat(64), history: [] }] }), "malformed_state"],
      [JSON.stringify({ schemaVersion: 2, entries: [{ slug: "x", title: "T", description: "D", documentSha256: "0".repeat(64), history: [{ timestamp: "bad", reason: "r" }] }] }), "malformed_state"],
      [JSON.stringify({ schemaVersion: 2, entries: [{ slug: "x", title: "T", description: "D", documentSha256: "0".repeat(64), history: [{ timestamp: "2025-01-02T00:00:00Z", reason: "r" }, { timestamp: "2025-01-01T00:00:00Z", reason: "older" }] }] }), "malformed_state"],
      [JSON.stringify({ schemaVersion: 2, entries: [] }) + " trailing", "malformed_state"],
      [`{"schemaVersion":2,"entries":"x"`, "malformed_state"],
    ];
    for (const [raw, expected] of cases) { await mkdir(memory(root), { recursive: true }); await writeFile(catalogPath(root), raw); await assert.rejects(() => createStorage(root).catalog(), category(expected)); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("storage validates slugs, metadata, captures, missing documents, and publication hooks", async () => {
  const root = await fresh(); try {
    const s = createStorage(root); await assert.rejects(() => s.read("../x"), category("invalid_input"));
    await assert.rejects(() => s.replace({ slug: "bad slug", content: "x", captures: [] }, { title: "T", description: "D" }, "r"), category("invalid_input"));
    await assert.rejects(() => s.replace({ slug: "x", content: "x", captures: [] }, { title: "", description: "D" }, "r"), category("invalid_input"));
    await assert.rejects(() => s.replace({ slug: "x", content: "x", captures: [] }, { title: "T", description: "D" }, ""), category("invalid_input"));
    await mkdir(memory(root), { recursive: true }); await writeFile(catalogPath(root), JSON.stringify({ schemaVersion: 2, entries: [{ slug: "x", title: "T", description: "D", documentSha256: "0".repeat(64), history: [] }] }));
    await assert.rejects(() => s.read("x"), category("incomplete_or_inconsistent_state"));
    await assert.rejects(() => s.read("unknown"), category("not_found"));
    const malformedCaptures = [null, "capture"];
    for (const capture of malformedCaptures) {
      const bytes = Buffer.from(yamlFront({ schemaVersion: 2, slug: "x", captures: [capture] }));
      await put(root, "x", bytes); await assert.rejects(() => s.read("x"), category("malformed_state"));
    }
    const badCaptures = [
      { path: "", startLine: 1, endLine: 1, sha256: "0".repeat(64), content: "x" },
      { path: "a", startLine: 0, endLine: 1, sha256: "0".repeat(64), content: "x" },
      { path: "a", startLine: 2, endLine: 1, sha256: "0".repeat(64), content: "x" },
      { path: "a", startLine: 1, endLine: 1, sha256: "bad", content: "x" },
      { path: "a", startLine: 1, endLine: 1, sha256: "0".repeat(64), content: "x", originalLiteral: 3 },
    ];
    for (const capture of badCaptures) { const bytes = Buffer.from(yamlFront({ schemaVersion: 2, slug: "x", captures: [capture] })); await put(root, "x", bytes); await assert.rejects(() => s.read("x"), category("malformed_state")); }
    await rm(memory(root), { recursive: true, force: true }); let published = 0; const hooked = createStorage(root, undefined, { publicationHook: { published: () => { published++; } } });
    const result = await hooked.replace({ slug: "x", content: "ok", captures: [] }, { title: "T", description: "D" }, "create"); assert.equal(result.entry.history.length, 1); assert.equal(published, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

 test("public validation enforces exact keys for every persisted object", async () => {
  const hash = "0".repeat(64);
  const valid = { schemaVersion: 2, entries: [{ slug: "x", title: "T", description: "D", documentSha256: hash, history: [] }] };
  const missingOrExtra = [
    ["catalog schema", { entries: valid.entries }],
    ["catalog entries", { schemaVersion: 2 }],
    ["entry missing", { ...valid, entries: [{ ...valid.entries[0], title: undefined }] }],
    ["entry extra", { ...valid, entries: [{ ...valid.entries[0], extra: true }] }],
    ["history extra", { ...valid, entries: [{ ...valid.entries[0], history: [{ timestamp: "2025-01-01T00:00:00Z", reason: "r", extra: true }] }] }],
    ["history missing", { ...valid, entries: [{ ...valid.entries[0], history: [{ timestamp: "2025-01-01T00:00:00Z" }] }] }],
  ] as const;
  for (const [name, value] of missingOrExtra) {
    assert.throws(() => validateCatalog(value), category("malformed_state"), name);
  }

  const root = await fresh(); try {
    const capture = { path: "a.ts", startLine: 1, endLine: 1, sha256: hash, content: "x" };
    for (const metadata of [
      { slug: "x", captures: [] },
      { schemaVersion: 2, captures: [] },
      { schemaVersion: 2, slug: "x" },
      { schemaVersion: 2, slug: "x", captures: [{ ...capture, extra: true }] },
      { schemaVersion: 2, slug: "x", captures: [{ ...capture, content: undefined }] },
    ]) {
      const bytes = Buffer.from(yamlFront(metadata)); await put(root, "x", bytes);
      await assert.rejects(() => createStorage(root).read("x"), category("malformed_state"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("persisted numeric and whitespace-invalid fields are rejected", async () => {
  const root = await fresh(); try {
    const invalidDocuments = [
      { path: "a.ts", startLine: 1.5, endLine: 2, sha256: "0".repeat(64), content: "x" },
      { path: "a.ts", startLine: "1", endLine: 2, sha256: "0".repeat(64), content: "x" },
      { path: "a.ts", startLine: 1, endLine: 0, sha256: "0".repeat(64), content: "x" },
    ];
    for (const capture of invalidDocuments) {
      const bytes = Buffer.from(yamlFront({ schemaVersion: 2, slug: "x", captures: [capture] }));
      await put(root, "x", bytes);
      await assert.rejects(() => createStorage(root).read("x"), category("malformed_state"));
    }

    const invalidCatalogs = [
      { schemaVersion: 2, entries: [{ slug: "x", title: " ", description: "D", documentSha256: "0".repeat(64), history: [] }] },
      { schemaVersion: 2, entries: [{ slug: "x", title: "T", description: "\t", documentSha256: "0".repeat(64), history: [] }] },
      { schemaVersion: 2, entries: [{ slug: "x", title: "T", description: "D", documentSha256: "0".repeat(64), history: [{ timestamp: "2025-01-01T00:00:00Z", reason: "\n" }] }] },
      { schemaVersion: 2, entries: [{ slug: "x", title: "T", description: "D", documentSha256: "0".repeat(64), history: [{ timestamp: 123, reason: "r" }] }] },
    ];
    for (const value of invalidCatalogs) {
      assert.throws(() => validateCatalog(value), category("malformed_state"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("front matter is anchored and history rejects unknown and duplicate entries", async () => {
  const root = await fresh(); try {
    const prefixed = Buffer.from(`noise\n${front("x", "body")}`);
    await put(root, "x", prefixed);
    await assert.rejects(() => createStorage(root).read("x"), category("malformed_state"));

    await assert.rejects(() => createStorage(root).history("unknown"), (error: any) => error?.category === "not_found" && error.message === "Unknown memory document: unknown");
    const hash = "0".repeat(64);
    const duplicate = { schemaVersion: 2, entries: [
      { slug: "x", title: "T", description: "D", documentSha256: hash, history: [] },
      { slug: "x", title: "T", description: "D", documentSha256: hash, history: [] },
    ] };
    assert.throws(() => validateCatalog(duplicate), category("malformed_state"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("capture paths reject absolute, backslash, dot, and empty segments", async () => {
  const root = await fresh(); try {
    for (const pathValue of ["/absolute", "a\\\\b", "a/./b", "a//b", "a/../b"]) {
      const capture = { path: pathValue, startLine: 1, endLine: 1, sha256: "0".repeat(64), content: "x" };
      const bytes = Buffer.from(yamlFront({ schemaVersion: 2, slug: "x", captures: [capture] }));
      await put(root, "x", bytes);
      await assert.rejects(() => createStorage(root).read("x"), category("malformed_state"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("duplicate JSON keys are rejected with whitespace at nested levels", async () => {
  const root = await fresh(); try {
    const document = Buffer.from('---\n{"schemaVersion": 2, "slug": "x", "captures": [{ "path": "a.ts", "path" : "b.ts", "startLine": 1, "endLine": 1, "sha256": "' + "0".repeat(64) + '", "content": "x" }]}\n---\nbody');
    await put(root, "x", document);
    await assert.rejects(() => createStorage(root).read("x"), category("malformed_state"));

    await mkdir(memory(root), { recursive: true });
    await writeFile(catalogPath(root), '{"schemaVersion": 2, "entries": [{"slug":"x","title":"T","description":"D","documentSha256":"' + "0".repeat(64) + '","history":[{"timestamp":"2025-01-01T00:00:00Z","reason":"r","reason" : "again"}]}]}');
    await assert.rejects(() => createStorage(root).catalog(), category("malformed_state"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("metadata BOM is rejected anywhere while a document-leading BOM remains valid", async () => {
  const root = await fresh(); try {
    for (const metadata of ["\uFEFFschemaVersion: 2\nslug: x\ncaptures: []", "# comment\n\uFEFFschemaVersion: 2\nslug: x\ncaptures: []"]) {
      const metadataBom = Buffer.from(`---\n${metadata}\n---\nbody`);
      await put(root, "x", metadataBom);
      await assert.rejects(() => createStorage(root).read("x"), category("malformed_state"));
    }

    const documentBom = Buffer.from(front("x", "body", "\n", "\uFEFF"));
    await put(root, "x", documentBom);
    assert.equal((await createStorage(root).read("x")).content, "body");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("replace rejects invalid captures before publishing any document or catalog", async () => {
  const root = await fresh(); try {
    const storage = createStorage(root);
    const invalid = { path: "../unsafe", startLine: 1, endLine: 1, sha256: "0".repeat(64), content: "x" };
    await assert.rejects(() => storage.replace({ slug: "x", content: "body", captures: [invalid] }, { title: "T", description: "D" }, "create"), category("malformed_state"));
    await assert.rejects(() => readFile(mdPath(root, "x")));
    assert.deepEqual(await storage.catalog(), { schemaVersion: 2, entries: [] });

    await storage.replace({ slug: "x", content: "original", captures: [] }, { title: "T", description: "D" }, "create");
    const beforeMarkdown = await readFile(mdPath(root, "x"));
    const beforeCatalog = await readFile(catalogPath(root));
    await assert.rejects(() => storage.replace({ slug: "x", content: "changed", captures: [invalid] }, { title: "T2", description: "D2" }, "edit"), category("malformed_state"));
    assert.deepEqual(await readFile(mdPath(root, "x")), beforeMarkdown);
    assert.deepEqual(await readFile(catalogPath(root)), beforeCatalog);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("strict persisted JSON rejects leading garbage and trailing data", async () => {
  const root = await fresh(); try {

    const valid = JSON.stringify({ schemaVersion: 2, entries: [] });
    for (const raw of [`garbage${valid}`, `${valid} trailing`]) {
      await mkdir(memory(root), { recursive: true });
      await writeFile(catalogPath(root), raw);
      await assert.rejects(() => createStorage(root).catalog(), category("malformed_state"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("valid YAML tags, anchors, and aliases are rejected by the feature policy", async () => {
  const root = await fresh(); try {
    const capture = `path: a.ts\nstartLine: 1\nendLine: 1\nsha256: ${"0".repeat(64)}\ncontent: x`;
    const cases = [
      ["tag", `schemaVersion: !!int 2\nslug: x\ncaptures: []`],
      ["anchor", `schemaVersion: 2\nslug: x\ncaptures:\n  - &capture\n    ${capture.replaceAll("\n", "\n    ")}`],
      ["alias", `schemaVersion: 2\nslug: x\ncaptures:\n  - &capture\n    ${capture.replaceAll("\n", "\n    ")}\n  - *capture`],
    ] as const;
    for (const [name, metadata] of cases) {
      await put(root, "x", Buffer.from(`---\n${metadata}\n---\nbody`));
      await assert.rejects(
        () => createStorage(root).read("x"),
        (error: any) => error?.category === "malformed_state" && error?.message === "Unsupported YAML feature in x.md front matter",
        name,
      );
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("replace rejects non-array captures before publication", async () => {
  const root = await fresh(); try {
    const storage = createStorage(root);
    await assert.rejects(
      () => storage.replace({ slug: "x", content: "body", captures: "not an array" as any }, { title: "T", description: "D" }, "create"),
      category("malformed_state"),
    );
    assert.deepEqual(await storage.catalog(), { schemaVersion: 2, entries: [] });
    await assert.rejects(() => readFile(mdPath(root, "x")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("long multiline captures use canonical no-wrap YAML and round-trip", async () => {
  const root = await fresh(); try {
    const unbroken = "unbroken-" + "value-".repeat(80);
    const secondWideLine = `This representative line is deliberately wide: ${"representative ".repeat(20).trim()}`;
    const content = `${unbroken}\n${secondWideLine}`;
    const capture = { path: "src/long.ts", startLine: 1, endLine: 2, sha256: "b".repeat(64), content };
    const storage = createStorage(root);
    await storage.replace({ slug: "x", content: "body", captures: [capture] }, { title: "T", description: "D" }, "create");
    const markdown = await readFile(mdPath(root), "utf8");
    assert.ok(markdown.includes(unbroken));
    assert.ok(markdown.includes(secondWideLine));
    const document = await storage.read("x");
    assert.deepEqual(document.captures, [capture]);
    assert.equal(document.content, "body");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("document reads and history use the requested slug among multiple documents", async () => {
  const root = await fresh(); try {
    const storage = createStorage(root);
    await storage.replace({ slug: "alpha", content: "alpha body", captures: [] }, { title: "A", description: "A" }, "create");
    await storage.replace({ slug: "beta", content: "beta body", captures: [] }, { title: "B", description: "B" }, "create");
    assert.equal((await storage.read("alpha")).content, "alpha body");
    assert.equal((await storage.read("beta")).content, "beta body");
    assert.deepEqual((await storage.history("alpha")).map(entry => entry.reason), ["create"]);
    assert.deepEqual((await storage.history("beta")).map(entry => entry.reason), ["create"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("document hashes distinguish UTF-8 strings and bytes, and publication formatting is stable", async () => {
  const text = "héllo";
  assert.equal(documentSha256(text), documentSha256(Buffer.from(text, "utf8")));
  assert.equal(documentSha256(new Uint8Array(Buffer.from(text))), documentSha256(text));
  const root = await fresh(); try {
    await createStorage(root).replace({ slug: "x", content: "body\n", captures: [] }, { title: "T", description: "D" }, "create");
    const markdown = await readFile(mdPath(root), "utf8");
    assert.equal(markdown, `---\nschemaVersion: 2\nslug: x\ncaptures: []\n---\nbody\n`);
    const rawCatalog = await readFile(catalogPath(root), "utf8");
    assert.equal(rawCatalog, JSON.stringify(JSON.parse(rawCatalog), null, 2) + "\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
