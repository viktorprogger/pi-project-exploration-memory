import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import extension from "../../extensions/project-exploration-memory/index.ts";
import { ExplorationMemoryError } from "../../src/core/errors.ts";

function host() {
 const tools = new Map<string, any>([["read", {}], ["write", {}], ["edit", {}]]);
 const inputHandlers: any[] = [];
 extension({ registerTool(tool: any) { tools.set(tool.name, tool); }, on(event: string, handler: any) { if (event === "input") inputHandlers.push(handler); } } as any);
 (tools as any).dispatchInput = (event: any, cwd: string, ui: any = {}) => inputHandlers.reduce(async (result, handler) => {
  const current = await result; return current?.action === "transform" || current?.action === "handled" ? current : handler(event, { cwd, ui });
 }, Promise.resolve(undefined));
 return tools;
}
function context(cwd: string) { return { cwd } as any; }

test("exposes the stable public contract for all project-memory tools", () => {
 const tools = host();
 const projectTools = [...tools.entries()].filter(([name]) => name.startsWith("project_memory_"));
 assert.equal(projectTools.length, 5);
 assert.deepEqual(projectTools.map(([name]) => name), [
  "project_memory_catalog", "project_memory_details", "project_memory_write", "project_memory_edit", "project_memory_history",
 ]);
 const metadata = {
  project_memory_catalog: ["Project memory catalog", "Find saved exploration memories by slug, title, or description.", true, true],
  project_memory_details: ["Project memory details", "Read current memory content, source captures, and freshness; use editable view before exact edits.", true, true],
  project_memory_write: ["Write project memory", "Create or replace a project exploration memory and record the UTC reason.", false, false],
  project_memory_edit: ["Edit project memory", "Apply unique exact edits to current editable memory content and record the UTC reason.", false, false],
  project_memory_history: ["Project memory history", "Read a bounded newest-first history page for one memory.", true, true],
 } as const;
 for (const [name, tool] of projectTools) {
  const [label, description, readOnlyHint, idempotentHint] = metadata[name as keyof typeof metadata];
  assert.equal(tool.label, label);
  assert.equal(tool.description, description);
  assert.deepEqual(tool.annotations, { readOnlyHint, destructiveHint: false, idempotentHint, openWorldHint: false });
  assert.equal(tool.parameters.additionalProperties, false);
 }
 const catalog = tools.get("project_memory_catalog").parameters;
 assert.deepEqual(catalog.properties.query, { type: "string", description: "Tokens matched against slug, title, or description." });
 assert.deepEqual(catalog.properties.project, { type: "string", description: "Explicit project directory; relative paths resolve from Pi's cwd." });
 const details = tools.get("project_memory_details").parameters;
 assert.deepEqual(details.required, ["slugs"]);
 assert.deepEqual(details.properties.slugs, { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "Unique memory slugs." });
 assert.deepEqual(details.properties.view, { anyOf: [{ type: "string", const: "expanded" }, { type: "string", const: "editable" }] });
 const write = tools.get("project_memory_write").parameters;
 assert.deepEqual(write.required, ["slug", "title", "description", "content", "reason"]);
 for (const field of ["slug", "title", "description", "reason"]) assert.deepEqual(write.properties[field], { type: "string", minLength: 1 });
 assert.deepEqual(write.properties.content, { type: "string" });
 const edit = tools.get("project_memory_edit").parameters;
 assert.deepEqual(edit.required, ["slug", "edits", "reason"]);
 assert.deepEqual(edit.properties.slug, { type: "string", minLength: 1 });
 assert.deepEqual(edit.properties.edits, {
  type: "array", minItems: 1,
  items: { type: "object", required: ["oldText", "newText"], properties: { oldText: { type: "string", minLength: 1 }, newText: { type: "string" } }, additionalProperties: false },
 });
 assert.deepEqual(edit.properties.reason, { type: "string", minLength: 1 });
 assert.deepEqual(edit.properties.title, { type: "string", minLength: 1 });
 assert.deepEqual(edit.properties.description, { type: "string", minLength: 1 });
 const history = tools.get("project_memory_history").parameters;
 assert.deepEqual(history.required, ["slug"]);
 assert.deepEqual(history.properties.slug, { type: "string", minLength: 1 });
 assert.deepEqual(history.properties.limit, { type: "integer", minimum: 1, maximum: 100, description: "Maximum entries to return." });
 assert.deepEqual(history.properties.cursor, { type: "string", minLength: 1, description: "Opaque cursor from a previous history result." });
});

test("registers the provider-free input hook and expands only interactive macros", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-input-")); const tools = host(); const ctx = context(root);
 await tools.get("project_memory_write").execute("1", { slug: "known", title: "Known", description: "D", content: "memory body", reason: "created" }, undefined, undefined, ctx);
 const image = [{ type: "image", data: "abc", mimeType: "image/png" }];
 const expanded = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "before [[pem:known]] after", images: image }, root);
 assert.equal(expanded.action, "transform"); assert.match(expanded.text, /memory body/); assert.deepEqual(expanded.images, image);
 const escaped = await (tools as any).dispatchInput({ type: "input", source: "rpc", text: "\\[[pem:unknown]]", images: image }, root);
 assert.deepEqual(escaped, { action: "transform", text: "[[pem:unknown]]", images: image });
 const extensionInput = await (tools as any).dispatchInput({ type: "input", source: "extension", text: "[[pem:known]]" }, root);
 assert.deepEqual(extensionInput, { action: "continue" });
});

test("protects fenced and multi-backtick code while preserving escaped text", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-code-")); const tools = host();
 await tools.get("project_memory_write").execute("1", { slug: "known", title: "Known", description: "D", content: "expanded", reason: "created" }, undefined, undefined, context(root));
 const text = "[[pem:known]]\n```\n[[pem:unknown]]\\[[pem:unknown]]\n```\n~~~\n[[pem:unknown]]\n~~~\n`` [[pem:unknown]] \\[[pem:unknown]] ``";
 const result = await (tools as any).dispatchInput({ type: "input", source: "interactive", text }, root);
 assert.equal(result.action, "transform");
 assert.match(result.text, /expanded[\s\S]*```\n\[\[pem:unknown\]\]\\\[\[pem:unknown\]\]/);
 assert.match(result.text, /~~~\n\[\[pem:unknown\]\]\n~~~/);
 assert.match(result.text, /`` \[\[pem:unknown\]\] \\\[\[pem:unknown\]\] ``$/);
});

test("supports indented fences and rejects trailing-text near-fences", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-fence-lines-")); const tools = host();
 await tools.get("project_memory_write").execute("1", { slug: "known", title: "Known", description: "D", content: "expanded", reason: "created" }, undefined, undefined, context(root));
 const input = "  ```markdown\n[[pem:unknown]]\n  ```\n[[pem:known]]\n```\n[[pem:unknown]]\n``` trailing\n[[pem:known]]\n```\nafter [[pem:known]]";
 const result = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: input }, root);
 assert.equal(result.action, "transform");
 assert.equal((result.text.match(/expanded/g) ?? []).length, 2);
 assert.match(result.text, /  ```markdown\n\[\[pem:unknown\]\]/);
 assert.match(result.text, /``` trailing\n\[\[pem:known\]\]/);
 assert.match(result.text, /after # Known \(known\)/);
 const crlf = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "```\r\n[[pem:unknown]]\r\n```\r\n[[pem:known]]" }, root);
 assert.equal(crlf.action, "transform"); assert.match(crlf.text, /```\r\n\[\[pem:unknown\]\]\r\n```\r\n# Known \(known\)/);
});

test("isolates warnings per rendered document and preserves freshness parity", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-macro-isolation-")); const tools = host(); const ctx = context(root);
 await writeFile(path.join(root, "source.ts"), "const value = 1;\n", "utf8");
 const write = tools.get("project_memory_write");
 await write.execute("1", { slug: "checked", title: "Checked", description: "D", content: "See source.ts#L1-L1", reason: "created" }, undefined, undefined, ctx);
 await write.execute("2", { slug: "clean", title: "Clean", description: "D", content: "clean body", reason: "created" }, undefined, undefined, ctx);
 const documentPath = path.join(root, ".pi/project-exploration-memory/documents/checked.md");
 await writeFile(documentPath, `${await readFile(documentPath, "utf8")}tampered\n`, "utf8");
 await writeFile(path.join(root, "source.ts"), "const value = 2;\n", "utf8");
 const ordinary = await tools.get("project_memory_details").execute("3", { slugs: ["checked", "clean"] }, undefined, undefined, ctx);
 const macro = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:checked]] / [[pem:clean]]" }, root);
 assert.equal(macro.action, "transform");
 assert.match(macro.text, /INTEGRITY WARNING/);
 assert.match(macro.text, /# Checked [\s\S]*Freshness: changed/);
 const cleanSection = macro.text.slice(macro.text.indexOf("# Clean"));
 assert.doesNotMatch(cleanSection, /INTEGRITY WARNING/);
 assert.match(ordinary.content[0].text, /INTEGRITY WARNING/);
 assert.match(macro.text, new RegExp(ordinary.details.documents[0].document.warnings[0].expectedDocumentSha256));
 assert.match(macro.text, /History \(checked\):/);
});

test("renders only the newest five history reasons in a macro", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-macro-history-")); const tools = host(); const ctx = context(root);
 const write = tools.get("project_memory_write"); const edit = tools.get("project_memory_edit");
 await write.execute("1", { slug: "history", title: "History", description: "D", content: "zero", reason: "old-0" }, undefined, undefined, ctx);
 for (let i = 1; i <= 6; i++) await edit.execute(String(i + 1), { slug: "history", edits: [{ oldText: i === 1 ? "zero" : `v${i - 1}`, newText: `v${i}` }], reason: `reason-${i}` }, undefined, undefined, ctx);
 const ordinary = await tools.get("project_memory_history").execute("9", { slug: "history", limit: 100 }, undefined, undefined, ctx);
 const macro = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:history]]" }, root);
 assert.equal(macro.action, "transform");
 const expectedHistory = `History (history):\n${ordinary.details.entries.slice(0, 5).reverse().map((entry: any) => `${entry.timestamp}: ${entry.reason}`).join("\n")}`;
 assert.equal(macro.text.slice(macro.text.indexOf("History (history):")), expectedHistory);
 for (const entry of ordinary.details.entries.slice(5)) assert.doesNotMatch(macro.text, new RegExp(`${entry.timestamp}: ${entry.reason}`));
});

test("does not recursively expand macros inserted by a memory", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-macro-one-step-")); const tools = host(); const ctx = context(root);
 await tools.get("project_memory_write").execute("1", { slug: "other", title: "Other", description: "D", content: "other body", reason: "created" }, undefined, undefined, ctx);
 await tools.get("project_memory_write").execute("2", { slug: "inserted", title: "Inserted", description: "D", content: "literal [[pem:other]]", reason: "created" }, undefined, undefined, ctx);
 const result = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:inserted]]" }, root);
 assert.equal(result.action, "transform"); assert.match(result.text, /literal \[\[pem:other\]\]/); assert.doesNotMatch(result.text, /# Other \(other\)/);
});

test("covers the complete macro fence and inline scanner matrix", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-scanner-matrix-")); const tools = host();
 await tools.get("project_memory_write").execute("1", { slug: "known", title: "Known", description: "D", content: "expanded", reason: "created" }, undefined, undefined, context(root));
 for (const indent of ["", " ", "  ", "   "]) {
  const fence = "`".repeat(3);
  const input = `${indent}${fence}\n[[pem:unknown]]\n${indent}${fence}\n[[pem:known]]`;
  const result = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: input }, root);
  assert.equal(result.action, "transform"); assert.equal((result.text.match(/expanded/g) ?? []).length, 1); assert.match(result.text, /\[\[pem:unknown\]\]/);
 }
 const mismatched = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "```\n[[pem:unknown]]\n~~~\n[[pem:known]]\n```" }, root);
 assert.equal(mismatched.action, "continue");
 for (const input of ["````\n[[pem:unknown]]\n```\nstill protected\n````\n[[pem:known]]", "```\n[[pem:unknown]]\n  ``` \t\n[[pem:known]]"]) {
  const result = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: input }, root);
  assert.equal(result.action, "transform", `failed scanner input: ${JSON.stringify(input)}`); assert.equal((result.text.match(/expanded/g) ?? []).length, 1);
 }
 const inline = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "``inline\n[[pem:unknown]]\ntext`` [[pem:known]]" }, root);
 assert.equal(inline.action, "transform"); assert.equal((inline.text.match(/expanded/g) ?? []).length, 1); assert.match(inline.text, /``inline\n\[\[pem:unknown\]\]\ntext``/);
});

test("distinguishes Markdown fence positions, runs, and closers", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-fence-contract-")); const tools = host();
 await tools.get("project_memory_write").execute("1", { slug: "known", title: "Known", description: "D", content: "expanded", reason: "created" }, undefined, undefined, context(root));
 for (const character of ["`", "~"]) for (const indent of ["", " ", "  ", "   "]) {
  const fence = character.repeat(3);
  const result = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: `${indent}${fence}\n[[pem:known]]\n${indent}${fence}\n[[pem:known]]` }, root);
  assert.equal(result.action, "transform");
  assert.equal((result.text.match(/expanded/g) ?? []).length, 1, `${character} fence at ${indent.length} spaces must protect its body`);
 }
 {
  const fence = "~~~";
  const result = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: `    ${fence}\n[[pem:known]]\n    ${fence}\n[[pem:known]]` }, root);
  assert.equal(result.action, "transform");
  assert.equal((result.text.match(/expanded/g) ?? []).length, 2, "four-space tilde candidates are not fences");
 }
 const candidates = [
  "x~~~\n[[pem:known]]\nx~~~\n[[pem:known]]", // opening fence is not at line start
  "~~~\n[[pem:known]]\n~~\n[[pem:known]]\n~~~\n[[pem:known]]", // shorter closer
  "~~~\n[[pem:known]]\n```\n[[pem:known]]\n~~~\n[[pem:known]]", // mismatched closer
  "~~~\n[[pem:known]]\n~~~ trailing\n[[pem:known]]\n~~~\n[[pem:known]]", // trailing text is not a closer
 ];
 const midline = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: candidates[0] }, root);
 assert.equal(midline.action, "transform");
 assert.equal((midline.text.match(/expanded/g) ?? []).length, 2);
 for (const input of candidates.slice(1)) {
  const result = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: input }, root);
  assert.equal(result.action, "transform");
  assert.equal((result.text.match(/expanded/g) ?? []).length, 1, `non-closing candidate: ${JSON.stringify(input)}`);
 }
 const validClosing = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "~~~\n[[pem:known]]\n~~~ \t\n[[pem:known]]" }, root);
 assert.equal(validClosing.action, "transform");
 assert.equal((validClosing.text.match(/expanded/g) ?? []).length, 1);
});

test("protects inline multi-backtick code across a shorter run", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-inline-runs-")); const tools = host();
 await tools.get("project_memory_write").execute("1", { slug: "known", title: "Known", description: "D", content: "expanded", reason: "created" }, undefined, undefined, context(root));
 const result = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "``code ` [[pem:known]] `` [[pem:known]]" }, root);
 assert.equal(result.action, "transform");
 assert.equal((result.text.match(/expanded/g) ?? []).length, 1);
 assert.match(result.text, /``code ` \[\[pem:known\]\] ``/);
});

test("keeps escaped macros exact before a same-line tilde candidate", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-escaped-fence-")); const tools = host();
 await tools.get("project_memory_write").execute("1", { slug: "known", title: "Known", description: "D", content: "expanded", reason: "created" }, undefined, undefined, context(root));
 const result = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "\\[[pem:known]]~~~\n[[pem:known]]\n~~~\n[[pem:known]]" }, root);
 assert.equal(result.action, "transform");
 assert.match(result.text, /^\[\[pem:known\]\]~~~/);
 assert.equal((result.text.match(/expanded/g) ?? []).length, 1);
});

test("checks UTF-8 size for escaped-only transforms at the boundary", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-size-")); const tools = host();
 const exact = "🙂".repeat(16381) + "aaa\\[[pem:x]]";
 const accepted = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: exact }, root);
 assert.equal(accepted.action, "transform"); assert.equal(Buffer.byteLength(accepted.text), 65536);
 const over = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "a".repeat(65528) + "\\[[pem:x]]" }, root, { notify() { throw new Error("notify failure"); } });
 assert.deepEqual(over, { action: "handled" });
 await tools.get("project_memory_write").execute("2", { slug: "small", title: "Small", description: "D", content: "body", reason: "created" }, undefined, undefined, context(root));
 const noImagesMacro = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:small]]" }, root);
 assert.equal(noImagesMacro.action, "transform");
 await tools.get("project_memory_write").execute("3", { slug: "base", title: "Boundary", description: "D", content: "body", reason: "created" }, undefined, undefined, context(root));
 await tools.get("project_memory_write").execute("4", { slug: "utf8", title: "Boundary", description: "D", content: "body🙂", reason: "created" }, undefined, undefined, context(root));
 const probe = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:base]]" }, root);
 const prefix = "a".repeat(65536 - Buffer.byteLength(probe.text));
 const exactMacro = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: prefix + "[[pem:base]]" }, root);
 assert.equal(Buffer.byteLength(exactMacro.text), 65536);
 const multibyteOver = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: prefix + "[[pem:utf8]]" }, root);
 assert.deepEqual(multibyteOver, { action: "handled" });
 const expandedOver = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:small]]".repeat(1000) }, root);
 assert.deepEqual(expandedOver, { action: "handled" });
 const primitiveRender = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:small]]", get images(): never { throw "primitive render failure"; } }, root);
 assert.deepEqual(primitiveRender, { action: "handled" });
});

test("expands repeated macros in source order and retrieves warning parity", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-macro-order-")); const tools = host(); const ctx = context(root);
 const write = tools.get("project_memory_write");
 await write.execute("1", { slug: "first", title: "First", description: "D", content: "ONE", reason: "created" }, undefined, undefined, ctx);
 await write.execute("2", { slug: "second", title: "Second", description: "D", content: "TWO", reason: "created" }, undefined, undefined, ctx);
 const ordinary = await tools.get("project_memory_details").execute("3", { slugs: ["first", "second"] }, undefined, undefined, ctx);
 const expanded = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:second]] / [[pem:first]] / [[pem:second]]" }, root);
 assert.equal(expanded.action, "transform");
 assert.ok(expanded.text.indexOf("TWO") < expanded.text.indexOf("ONE"));
 assert.equal((expanded.text.match(/# Second \(second\)/g) ?? []).length, 2);
 const documentPath = path.join(root, ".pi/project-exploration-memory/documents/first.md");
 const stored = await readFile(documentPath, "utf8"); await writeFile(documentPath, stored.replace("ONE", "tampered"), "utf8");
 const warning = await tools.get("project_memory_details").execute("4", { slugs: ["first"] }, undefined, undefined, ctx);
 const macro = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:first]]" }, root);
 assert.equal(warning.details.documents[0].document.warnings.length, 1);
 assert.match(warning.content[0].text, /expectedDocumentSha256:[^\\n]+/);
 assert.match(macro.text, /INTEGRITY WARNING[\s\S]*expectedDocumentSha256:/);
 assert.match(ordinary.content[0].text, /# First \(first\)/);
});

test("handles unchanged, malformed, and unmatched macro input deterministically", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-input-edge-")); const tools = host();
 const unchanged = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "plain text" }, root);
 assert.deepEqual(unchanged, { action: "continue" });
 const notifyMessages: string[] = [];
 const malformed = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:bad!]]" }, root, { notify(message: string) { notifyMessages.push(message); } });
 assert.deepEqual(malformed, { action: "handled" }); assert.equal(notifyMessages[0], "Malformed project memory macro");
 const invalidLeadingSlug = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:-known]]" }, root, { notify(message: string) { notifyMessages.push(message); } });
 assert.deepEqual(invalidLeadingSlug, { action: "handled" }); assert.equal(notifyMessages[1], "Malformed project memory macro");
 const unmatched = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "`[[pem:unknown]]" }, root);
 assert.deepEqual(unmatched, { action: "continue" });
 const mismatched = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "``x``` [[pem:unknown]] ``" }, root);
 assert.deepEqual(mismatched, { action: "continue" });
 const escapedUnclosed = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "\\[[pem:unknown" }, root);
 assert.deepEqual(escapedUnclosed, { action: "transform", text: "[[pem:unknown" });
 const escapedNewline = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "\\[[pem:unknown\n" }, root);
 assert.deepEqual(escapedNewline, { action: "transform", text: "[[pem:unknown\n" });
 const malformedUnclosed = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:unknown" }, root);
 assert.deepEqual(malformedUnclosed, { action: "handled" });
 const primitive = await (tools as any).dispatchInput({ source: "interactive", get text(): string { throw "primitive parse failure"; } }, root, { notify() { throw new Error("notify failure"); } });
 assert.deepEqual(primitive, { action: "handled" });
 await tools.get("project_memory_write").execute("2", { slug: "empty", title: "Empty", description: "D", content: "body", reason: "created" }, undefined, undefined, context(root));
 const catalogPath = path.join(root, ".pi/project-exploration-memory/catalog.json"); const catalog = await readFile(catalogPath, "utf8");
 await writeFile(catalogPath, catalog.replace(/(\"history\": )\[[\s\S]*?\]/, "$1[]"), "utf8");
 const emptyHistory = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:empty]]" }, root);
 assert.equal(emptyHistory.action, "transform");
 assert.equal(emptyHistory.text.slice(emptyHistory.text.indexOf("History (empty):")), "History (empty):\nNo history entries.");
});

test("registers exactly five current tools and preserves built-ins", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-extension-"));
 const tools = host();
 assert.deepEqual([...tools.keys()], ["read", "write", "edit", "project_memory_catalog", "project_memory_details", "project_memory_write", "project_memory_edit", "project_memory_history"]);
 assert.equal(Value.Check(tools.get("project_memory_write").parameters, { slug: "orders", title: "Orders", description: "Creation", content: "# Orders", reason: "created" }), true);
 assert.equal(Value.Check(tools.get("project_memory_write").parameters, { slug: "orders", title: "Orders", description: "Creation", content: "# Orders", reason: "created", extra: true }), false);
 assert.equal(Value.Check(tools.get("project_memory_catalog").parameters, { query: "orders", extra: true }), false);
 assert.equal(Value.Check(tools.get("project_memory_details").parameters, { slugs: ["orders"], extra: true }), false);
 assert.equal(Value.Check(tools.get("project_memory_history").parameters, { slug: "orders", extra: true }), false);
 assert.equal(Value.Check(tools.get("project_memory_edit").parameters, { slug: "orders", edits: [{ oldText: "Orders", newText: "Updated" }], reason: "updated", extra: true }), false);
 const ctx = context(root);
 const write = await tools.get("project_memory_write").execute("1", { slug: "orders", title: "Orders", description: "Creation", content: "# Orders", reason: "created" }, undefined, undefined, ctx);
 assert.equal(write.isError, undefined);
 assert.match(write.content[0].text, /Saved orders\./);
 const edit = await tools.get("project_memory_edit").execute("2", { slug: "orders", edits: [{ oldText: "Orders", newText: "Orders and validation" }], reason: "clarified" }, undefined, undefined, ctx);
 assert.match(edit.content[0].text, /Saved orders\./);
 const catalog = await tools.get("project_memory_catalog").execute("3", { query: "orders" }, undefined, undefined, ctx);
 assert.equal(catalog.details.entries.length, 1);
 assert.equal(catalog.content[0].text, "orders: Orders — Creation");
 const details = await tools.get("project_memory_details").execute("4", { slugs: ["orders"], view: "editable" }, undefined, undefined, ctx);
 assert.match(details.content[0].text, /Orders and validation/);
 await tools.get("project_memory_write").execute("5", { slug: "payments", title: "Payments", description: "Creation", content: "# Payments", reason: "created" }, undefined, undefined, ctx);
 const allCatalog = await tools.get("project_memory_catalog").execute("5b", {}, undefined, undefined, ctx);
 assert.equal(allCatalog.content[0].text, "orders: Orders — Creation\npayments: Payments — Creation");
 const multiple = await tools.get("project_memory_details").execute("6", { slugs: ["orders", "payments"] }, undefined, undefined, ctx);
 assert.deepEqual(multiple.details.documents.map((document: any) => document.entry.slug), ["orders", "payments"]);
 assert.match(multiple.content[0].text, /# Orders \(orders\)[\s\S]*Orders and validation[\s\S]*\n\n---\n\n[\s\S]*# Payments \(payments\)[\s\S]*# Payments/);
 assert.equal((multiple.content[0].text.match(/\n\n---\n\n/g) ?? []).length, 1);
 const history = await tools.get("project_memory_history").execute("7", { slug: "orders", limit: 2 }, undefined, undefined, ctx);
 assert.equal(history.details.entries.length, 2);
 assert.equal(history.details.entries[0].reason, "clarified");
 assert.match(history.details.entries[0].timestamp, /Z$/);
 assert.match(history.content[0].text, /clarified/);
 assert.match(history.content[0].text, /\n/);
});

test("uses input cwd independently from earlier tool project overrides", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-input-cwd-")); const other = await mkdtemp(path.join(tmpdir(), "pi-memory-input-other-")); const tools = host();
 await tools.get("project_memory_write").execute("1", { slug: "same", title: "Root", description: "D", content: "ROOT", reason: "created" }, undefined, undefined, context(root));
 await tools.get("project_memory_write").execute("2", { slug: "same", title: "Other", description: "D", content: "OTHER", reason: "created", project: other }, undefined, undefined, context(root));
 await tools.get("project_memory_catalog").execute("3", { project: other }, undefined, undefined, context(root));
 const result = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:same]]" }, root);
 assert.equal(result.action, "transform"); assert.match(result.text, /ROOT/); assert.doesNotMatch(result.text, /OTHER/);
 const unknown = await (tools as any).dispatchInput({ type: "input", source: "interactive", text: "[[pem:missing]]" }, root);
 assert.deepEqual(unknown, { action: "handled" });
});

test("returns current details and freshness, and supports project override", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-freshness-"));
 await writeFile(path.join(root, "source.ts"), "const original = true;\n", "utf8");
 const other = await mkdtemp(path.join(tmpdir(), "pi-memory-project-"));
 const tools = host();
 const write = tools.get("project_memory_write");
 const details = tools.get("project_memory_details");
 const ctx = context(root);
 await write.execute("1", { slug: "source", title: "Source", description: "Test", content: "See source.ts#L1-L1", reason: "created" }, undefined, undefined, ctx);
 const result = await details.execute("2", { slugs: ["source"], view: "expanded" }, undefined, undefined, ctx);
 assert.match(result.content[0].text, /const original = true/);
 assert.match(result.content[0].text, /Freshness: all-valid/);
 await write.execute("3", { slug: "other", title: "Other", description: "Test", content: "No source", reason: "created", project: other }, undefined, undefined, ctx);
 const override = await details.execute("4", { slugs: ["other"], project: other }, undefined, undefined, ctx);
 assert.match(override.content[0].text, /# Other/);
 assert.match(override.content[0].text, /Freshness: all-valid \(no-sources\)/);
 assert.equal(result.details.project, root);
 assert.equal(override.details.project, other);
 const explicitWrite = await write.execute("5", { slug: "explicit", title: "Explicit", description: "Test", content: "No source", reason: "created", project: other }, undefined, undefined, ctx);
 assert.equal(explicitWrite.details.project, other);
 const omittedWrite = await write.execute("6", { slug: "omitted", title: "Omitted", description: "Test", content: "No source", reason: "created" }, undefined, undefined, ctx);
 assert.equal(omittedWrite.details.project, root);
});

test("renders hash mismatch warnings without hiding content and recovers on write/edit", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-integrity-"));
 const tools = host();
 const write = tools.get("project_memory_write");
 const details = tools.get("project_memory_details");
 const edit = tools.get("project_memory_edit");
 const ctx = context(root);
 await write.execute("1", { slug: "checked", title: "Checked", description: "Test", content: "original", reason: "created" }, undefined, undefined, ctx);
 const documentPath = path.join(root, ".pi/project-exploration-memory/documents/checked.md");
 const stored = await readFile(documentPath, "utf8");
 await writeFile(documentPath, stored.replace("original", "changed outside the tool"), "utf8");
 const warning = await details.execute("2", { slugs: ["checked"] }, undefined, undefined, ctx);
 assert.equal(warning.isError, undefined);
 assert.match(warning.content[0].text, /INTEGRITY WARNING/);
 assert.match(warning.content[0].text, /slug: checked/);
 assert.match(warning.content[0].text, /expectedDocumentSha256:/);
 assert.match(warning.content[0].text, /observedDocumentSha256:/);
 assert.match(warning.content[0].text, /changed outside the tool/);
 const recoveredByEdit = await edit.execute("3", { slug: "checked", edits: [{ oldText: "changed outside the tool", newText: "edited after warning" }], reason: "recovered by edit" }, undefined, undefined, ctx);
 assert.equal(recoveredByEdit.isError, undefined);
 const rewritten = await write.execute("4", { slug: "checked", title: "Checked", description: "Test", content: "rewritten", reason: "recovered by write" }, undefined, undefined, ctx);
 assert.equal(rewritten.isError, undefined);
 const edited = await edit.execute("5", { slug: "checked", edits: [{ oldText: "rewritten", newText: "edited" }], reason: "refined" }, undefined, undefined, ctx);
 assert.equal(edited.isError, undefined);
 assert.match(edited.content[0].text, /Saved checked/);
});

test("turns missing documents and malformed state into failed tool results", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-errors-"));
 const tools = host();
 const missing = await tools.get("project_memory_history").execute("1", { slug: "missing" }, undefined, undefined, context(root));
 assert.equal(missing.isError, true);
 assert.match(missing.content[0].text, /Unknown memory document/);
 const write = tools.get("project_memory_write");
 await write.execute("2", { slug: "x", title: "X", description: "X", content: "x", reason: "created" }, undefined, undefined, context(root));
 const catalogPath = path.join(root, ".pi/project-exploration-memory/catalog.json");
 await writeFile(catalogPath, "{not json", "utf8");
 const failed = await tools.get("project_memory_catalog").execute("3", {}, undefined, undefined, context(root));
 assert.equal(failed.isError, true);
 assert.match(failed.content[0].text, /Cannot parse catalog/);
 assert.equal(failed.details.error, "Cannot parse catalog.json");
 assert.equal(failed.structuredContent, undefined);
});

test("formats primitive adapter failures through public tools", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-primitive-error-")); const tools = host();
 const query = { toLocaleLowerCase() { throw "primitive query failure"; } };
 const failed = await tools.get("project_memory_catalog").execute("1", { query } as any, undefined, undefined, context(root));
 assert.equal(failed.isError, true);
 assert.equal(failed.content[0].text, "primitive query failure");
 assert.equal(failed.details.error, "primitive query failure");
});

test("renders exactly the newest five history entries", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-history-five-")); const tools = host(); const ctx = context(root); const write = tools.get("project_memory_write");
 await write.execute("0", { slug: "history", title: "History", description: "D", content: "body", reason: "reason-0" }, undefined, undefined, ctx);
 for (let i = 1; i <= 7; i++) await write.execute(String(i), { slug: "history", title: "History", description: "D", content: "body", reason: `reason-${i}` }, undefined, undefined, ctx);
 const result = await tools.get("project_memory_history").execute("8", { slug: "history", limit: 5 }, undefined, undefined, ctx);
 assert.equal(result.details.entries.length, 5);
 assert.deepEqual(result.details.entries.map((entry: any) => entry.reason), ["reason-7", "reason-6", "reason-5", "reason-4", "reason-3"]);
 assert.equal(result.content[0].text, result.details.entries.map((entry: any) => `${entry.timestamp}: ${entry.reason}`).join("\n"));
});

test("formats empty catalog and history results through public tools", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-empty-")); const tools = host(); const ctx = context(root);
 const catalog = await tools.get("project_memory_catalog").execute("1", {}, undefined, undefined, ctx);
 assert.match(catalog.content[0].text, /No exploration memory documents found/);
 await tools.get("project_memory_write").execute("2", { slug: "empty-history", title: "Empty", description: "D", content: "body", reason: "created" }, undefined, undefined, ctx);
 const catalogPath = path.join(root, ".pi/project-exploration-memory/catalog.json"); const stored = await readFile(catalogPath, "utf8");
 await writeFile(catalogPath, stored.replace(/("history": )\[[\s\S]*?\]/, "$1[]"), "utf8");
 const history = await tools.get("project_memory_history").execute("3", { slug: "empty-history" }, undefined, undefined, ctx);
 assert.match(history.content[0].text, /No history entries/);
});

test("accepts optional fields while rejecting closed-schema edge cases", () => {
 const tools = host();
 assert.equal(Value.Check(tools.get("project_memory_catalog").parameters, { project: "/tmp/project" }), true);
 assert.equal(Value.Check(tools.get("project_memory_details").parameters, { slugs: ["x"], view: "expanded", project: "/tmp/project" }), true);
 assert.equal(Value.Check(tools.get("project_memory_write").parameters, { slug: "x", title: "X", description: "D", content: "", reason: "r", project: "/tmp/project" }), true);
 assert.equal(Value.Check(tools.get("project_memory_edit").parameters, { slug: "x", edits: [{ oldText: "a", newText: "" }], reason: "r", title: "X", description: "D", project: "/tmp/project" }), true);
 assert.equal(Value.Check(tools.get("project_memory_history").parameters, { slug: "x", limit: 1, cursor: "abc", project: "/tmp/project" }), true);
 assert.equal(Value.Check(tools.get("project_memory_catalog").parameters, { query: "x", nope: true }), false);
 assert.equal(Value.Check(tools.get("project_memory_details").parameters, { slugs: ["x"], view: "bad" }), false);
 assert.equal(Value.Check(tools.get("project_memory_details").parameters, { slugs: [] }), false);
 assert.equal(Value.Check(tools.get("project_memory_write").parameters, { slug: "", title: "X", description: "D", content: "x", reason: "r" }), false);
 assert.equal(Value.Check(tools.get("project_memory_edit").parameters, { slug: "x", edits: [{ oldText: "", newText: "x" }], reason: "r" }), false);
 assert.equal(Value.Check(tools.get("project_memory_history").parameters, { slug: "x", limit: 0 }), false);
 assert.equal(Value.Check(tools.get("project_memory_history").parameters, { slug: "x", limit: 101 }), false);
 assert.equal(Value.Check(tools.get("project_memory_history").parameters, { slug: "x", cursor: "" }), false);
});

test("exposes structured integrity warnings from catalog, details, and history", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-warning-")); const tools = host(); const ctx = context(root);
 await tools.get("project_memory_write").execute("1", { slug: "warn", title: "Warn", description: "D", content: "body", reason: "created" }, undefined, undefined, ctx);
 const documentPath = path.join(root, ".pi/project-exploration-memory/documents/warn.md");
 const stored = await readFile(documentPath, "utf8"); await writeFile(documentPath, stored.replace("body", "tampered"), "utf8");
 const catalog = await tools.get("project_memory_catalog").execute("2", {}, undefined, undefined, ctx);
 assert.equal(catalog.details.warnings.length, 1); assert.equal(catalog.structuredContent.warnings[0].kind, "document_hash_mismatch"); assert.match(catalog.content[0].text, /observedDocumentSha256:/);
 const details = await tools.get("project_memory_details").execute("3", { slugs: ["warn"] }, undefined, undefined, ctx);
 assert.equal(details.details.documents[0].document.warnings.length, 1); assert.match(details.content[0].text, /# Warn \(warn\)/);
 assert.equal((details.content[0].text.match(/⚠ INTEGRITY WARNING/g) ?? []).length, 1);
 assert.equal(details.structuredContent.warnings.length, 1);
 const history = await tools.get("project_memory_history").execute("4", { slug: "warn" }, undefined, undefined, ctx);
 assert.equal(history.details.warnings.length, 1); assert.match(history.content[0].text, /created/);
});

test("collects nested warnings, deduplicates warning keys, and preserves separators", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-warning-collection-")); const tools = host(); const ctx = context(root);
 const write = tools.get("project_memory_write"); const details = tools.get("project_memory_details");
 for (const slug of ["first", "second"]) await write.execute(slug, { slug, title: slug, description: "D", content: `${slug} body`, reason: "created" }, undefined, undefined, ctx);
 for (const slug of ["first", "second"]) {
  const documentPath = path.join(root, `.pi/project-exploration-memory/documents/${slug}.md`);
  const stored = await readFile(documentPath, "utf8"); await writeFile(documentPath, stored.replace(`${slug} body`, `${slug} tampered`), "utf8");
 }
 const result = await details.execute("1", { slugs: ["first", "second"] }, undefined, undefined, ctx);
 assert.equal(result.details.warnings.length, 2);
 assert.equal(result.details.documents.flatMap((d: any) => d.document.warnings ?? []).length, 2);
 assert.equal((result.content[0].text.match(/⚠ INTEGRITY WARNING/g) ?? []).length, 2);
 assert.match(result.content[0].text, /observedDocumentSha256:[^\n]+\n\n⚠ INTEGRITY WARNING/);
 assert.equal((result.content[0].text.match(/\n\n---\n\n/g) ?? []).length, 1);
 assert.match(result.content[0].text, /first tampered/);
 assert.match(result.content[0].text, /second tampered/);
});

test("keeps the domain error name stable", () => {
 const error = new ExplorationMemoryError("invalid_input", "bad input");
 assert.equal(error.name, "ExplorationMemoryError");
 assert.equal(error.category, "invalid_input");
});

test("formats mixed freshness statuses with deterministic occurrence details", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-mixed-freshness-"));
 const files = ["valid.ts", "changed.ts", "missing.ts", "unreadable.ts"];
 for (const file of files) await writeFile(path.join(root, file), `const ${file.replace(".ts", "")} = true;\\n`, "utf8");
 const tools = host(); const ctx = context(root); const write = tools.get("project_memory_write");
 await write.execute("1", { slug: "mixed", title: "Mixed", description: "D", content: files.map(file => `${file}#L1-L1`).join(" "), reason: "created" }, undefined, undefined, ctx);
 await writeFile(path.join(root, "changed.ts"), "const changed = false;\\n", "utf8");
 await unlink(path.join(root, "missing.ts"));
 await writeFile(path.join(root, "unreadable.ts"), new Uint8Array([0xff, 0xfe]));
 const result = await tools.get("project_memory_details").execute("2", { slugs: ["mixed"] }, undefined, undefined, ctx);
 assert.equal(result.details.summary.status, "unreadable");
 assert.deepEqual(result.details.documents[0].freshness.occurrences.map((occurrence: any) => occurrence.status), ["valid", "changed", "missing", "unreadable"]);
 assert.match(result.content[0].text, /Freshness: unreadable; changed changed\.ts#L1-L1, missing missing\.ts#L1-L1, unreadable unreadable\.ts#L1-L1/);
 assert.doesNotMatch(result.content[0].text, /Freshness: unreadable; valid/);
});

test("renders freshness statuses and history pagination through public tools", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pi-memory-branches-")); const source = path.join(root, "source.ts");
 await writeFile(source, "const value = 1;\n", "utf8"); const tools = host(); const ctx = context(root); const write = tools.get("project_memory_write");
 await write.execute("1", { slug: "ref", title: "Ref", description: "D", content: "See source.ts#L1-L1", reason: "one" }, undefined, undefined, ctx); await unlink(source);
 let result = await tools.get("project_memory_details").execute("2", { slugs: ["ref"] }, undefined, undefined, ctx); assert.match(result.content[0].text, /Freshness: missing/);
 await writeFile(source, "const value = 2;\n", "utf8"); result = await tools.get("project_memory_details").execute("3", { slugs: ["ref"] }, undefined, undefined, ctx); assert.match(result.content[0].text, /Freshness: changed/);
 await writeFile(source, new Uint8Array([0xff, 0xfe])); result = await tools.get("project_memory_details").execute("4", { slugs: ["ref"] }, undefined, undefined, ctx); assert.match(result.content[0].text, /Freshness: unreadable/);
 await writeFile(source, "const value = 3;\n", "utf8");
 for (const reason of ["two", "three"]) await write.execute(reason, { slug: "ref", title: "Ref", description: "D", content: "See source.ts#L1-L1", reason }, undefined, undefined, ctx);
 const page = await tools.get("project_memory_history").execute("5", { slug: "ref", limit: 1 }, undefined, undefined, ctx); assert.equal(page.details.entries.length, 1); assert.ok(page.details.nextCursor);
 const next = await tools.get("project_memory_history").execute("6", { slug: "ref", limit: 1, cursor: page.details.nextCursor }, undefined, undefined, ctx); assert.equal(next.details.entries.length, 1); assert.notEqual(next.details.entries[0].reason, page.details.entries[0].reason);
 const invalid = await tools.get("project_memory_history").execute("7", { slug: "ref", cursor: "not-valid" }, undefined, undefined, ctx); assert.equal(invalid.isError, true); assert.match(invalid.content[0].text, /Invalid history cursor/);
});
