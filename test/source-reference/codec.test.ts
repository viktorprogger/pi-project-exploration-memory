import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { collapse, expand, parseReference, checkFreshness } from "../../src/source-reference/codec.ts";
import type { SourceReader } from "../../src/core/contracts.ts";

test("parses labeled and bare source references", async () => {
  assert.deepEqual(parseReference("[thing](src/a.ts#L2-L3)"), { path: "src/a.ts", startLine: 2, endLine: 3, originalLiteral: "[thing](src/a.ts#L2-L3)" });
  const unicode = await expand("[é](src/a.ts#L1)", { read: async () => ({ bytes: new TextEncoder().encode("one"), text: "one" }) });
  assert.equal(collapse(unicode.content).content, "[é](src/a.ts#L1)");
  const reader: SourceReader = { read: async () => ({ bytes: new TextEncoder().encode("one\ntwo\nthree"), text: "one\ntwo\nthree" }) };
  const expanded = await expand("See src/a.ts#L2-L3.", reader);
  assert.equal(expanded.captures[0]?.content, "two\nthree");
  assert.equal(collapse(expanded.content).content, "See src/a.ts#L2-L3.");
});

test("skips code and preserves repeated labels while reading each file once", async () => {
  let reads = 0;
  const reader: SourceReader = { read: async () => { reads++; const text = "a\nconst x = `marker`;\nc"; return { bytes: new TextEncoder().encode(text), text }; } };
  const input = "`src/a.ts#L1`\n```\nsrc/a.ts#L2\n```\n[one](src/a.ts#L1) and [two](src/a.ts#L3)";
  const expanded = await expand(input, reader);
  assert.equal(reads, 1);
  assert.equal(collapse(expanded.content).content, input);
  assert.equal(expanded.captures.length, 2);
});

test("expands source-evidence list items with inline-code anchors", async () => {
  const input = "- `internal/repository/erasure.go#L52-L119`";
  const source = Array.from({ length: 119 }, (_, index) => `line ${index + 1}`).join("\n");
  let readPath: string | undefined;
  const reader: SourceReader = { read: async path => {
    readPath = path;
    return { bytes: new TextEncoder().encode(source), text: source };
  } };

  const expanded = await expand(input, reader);
  assert.equal(readPath, "internal/repository/erasure.go");
  assert.match(expanded.content, /Source: internal\/repository\/erasure\.go#L52-L119/);
  assert.equal(collapse(expanded.content).content, input);
});

test("skips ordinary links and rejects scheme-prefixed anchors without reading a suffix path", async () => {
  const ordinary = await expand("See [site](https://example.test/page)", { read: async () => ({ bytes: new Uint8Array(), text: "" }) });
  assert.equal(ordinary.content, "See [site](https://example.test/page)");
  assert.equal(ordinary.captures.length, 0);
  for (const literal of ["https:foo.ts#L1", "http://foo.ts#L1", "custom+scheme:foo.ts#L1"]) {
    let reads = 0;
    const reader: SourceReader = { read: async () => { reads++; return { bytes: new Uint8Array(), text: "" }; } };
    await assert.rejects(() => expand(`See ${literal}`, reader), /project-relative/);
    assert.equal(reads, 0);
  }
  assert.equal((await expand("See https://example.test/page", { read: async () => ({ bytes: new Uint8Array(), text: "" }) })).captures.length, 0);
});

test("enforces evidence metadata bounds and ignores nested bare matches", async () => {
  const reader: SourceReader = { read: async () => ({ bytes: new TextEncoder().encode("one"), text: "one" }) };
  const longPath = `${"a".repeat(4080)}.ts`;
  await assert.rejects(() => expand(`${longPath}#L1`, reader), /metadata exceeds/);
  const expanded = await expand("[source](a.ts#L1)", reader);
  assert.equal(expanded.captures.length, 1);
  assert.equal(collapse(expanded.content).content, "[source](a.ts#L1)");
});

test("rejects trailing or mismatched evidence end markers", async () => {
  const reader: SourceReader = { read: async () => ({ bytes: new TextEncoder().encode("one"), text: "one" }) };
  const expanded = await expand("See a.ts#L1", reader);
  assert.throws(() => collapse(expanded.content.replace(/(<!-- \/pem:v1:[^ ]+ -->)/, "$1 trailing")), /checksum/);
  assert.throws(() => collapse(expanded.content.replace(/<!-- \/pem:v1:[^ ]+ -->/, "<!-- /pem:v1:0000000000000000 -->")), /checksum/);
});

test("preserves marker-like source text inside a dynamic fence", async () => {
  const source = "<!-- /pem:v1:0000000000000000 -->\nbacktick ` and marker";
  const reader: SourceReader = { read: async () => ({ bytes: new TextEncoder().encode(source), text: source }) };
  const expanded = await expand("See a.ts#L1-L2", reader);
  assert.equal(collapse(expanded.content).content, "See a.ts#L1-L2");
});

test("freshness hashes the whole file and reports unreadable sources", async () => {
  const capture = { path: "a.ts", startLine: 1, endLine: 1, sha256: "bad", content: "same" };
  const reader: SourceReader = { read: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } };
  const summary = await checkFreshness([capture], reader);
  assert.equal(summary.status, "missing");
});

test("parseReference rejects malformed, unsafe, and impossible ranges", () => {
  for (const literal of ["", "x.ts", "x.ts#L1-L2-L3", "[label](x.ts#L1 extra)"]) assert.equal(parseReference(literal), undefined);
  assert.equal(parseReference("x.ts#L1-L2")?.endLine, 2);
  assert.throws(() => parseReference("x.ts#L1#L2"), /unsupported query/);
  assert.throws(() => parseReference("x.ts#L999999999999999999999"), /line range/);
  assert.throws(() => parseReference("x.ts#L0"), /line range/);
  assert.throws(() => parseReference("x.ts#L2-L1"), /line range/);
  for (const literal of ["../x.ts#L1", "a//x.ts#L1", "a\\x.ts#L1", "/x.ts#L1"]) {
    assert.throws(() => parseReference(literal), /Source reference/);
  }
  assert.throws(() => parseReference("x.ts?x#L1"), /unsupported query/);
  assert.throws(() => parseReference("x.ts#L1-L999999999999999999999"), /line range/);
  assert.equal(parseReference("[label](x.ts#L3)")?.originalLiteral, "[label](x.ts#L3)");
  assert.equal(parseReference(`${"a".repeat(4096)}#L1`), undefined);
});

test("masks inline code and both fence styles, including unmatched delimiters", async () => {
  const input = "`a.ts#L1` and a.ts#L1\n~~~\na.ts#L1\n~~~\n~~~~\na.ts#L1\n~~~\n```\n- `a.ts#L1`\n```\n- `ordinary code`\ntext `unterminated a.ts#L1";
  let reads = 0;
  const reader: SourceReader = { read: async () => { reads++; return { bytes: new TextEncoder().encode("one"), text: "one" }; } };
  const expanded = await expand(input, reader);
  assert.equal(reads, 1); assert.equal(expanded.captures.length, 1);
});

test("uses only unprotected references and preserves capture order", async () => {
  const files = new Map([
    ["a.ts", "a1\na2"],
    ["b.ts", "b1"]
  ]);
  const reader: SourceReader = { read: async path => {
    const text = files.get(path)!;
    return { bytes: new TextEncoder().encode(text), text };
  } };
  const input = "`b.ts#L1` a.ts#L2 and [named](b.ts#L1)";
  const expanded = await expand(input, reader);
  assert.deepEqual(expanded.captures.map(c => [c.path, c.startLine, c.content]), [["a.ts", 2, "a2"], ["b.ts", 1, "b1"]]);
  assert.equal(collapse(expanded.content).content, input);
});

test("selects the shortest safe evidence fence", async () => {
  const source = "contains `` and ~";
  const expanded = await expand("a.ts#L1", { read: async () => ({ bytes: new TextEncoder().encode(source), text: source }) });
  assert.match(expanded.content, /Source: a\.ts#L1\n~~\ncontains `` and ~\n~~\n/);
});

test("collapse rejects malformed evidence structure and metadata", async () => {
  const reader: SourceReader = { read: async () => ({ bytes: new TextEncoder().encode("one"), text: "one" }) };
  const evidence = (await expand("a.ts#L1", reader)).content;
  const cases = [
    evidence.replace("<!-- pem:v1:", "prefix <!-- pem:v1:"),
    evidence.replace(/\nSource:[^\n]+/, "\nWrong source"),
    evidence.replace(/\n`\n/, "\nnot-a-fence\n"),
    evidence.replace(/\none\n`/, "\none\n"),
    evidence.replace(/<!-- pem:v1:[^:]+:[0-9a-f]{16} -->/, "<!-- pem:v1:bad:0000000000000000 -->"),
    evidence.replace(/<!-- pem:v1:[^:]+:[0-9a-f]{16} -->/, "<!-- pem:v1:%%%:0000000000000000 -->"),
    evidence.replace(/<!-- \/pem:v1:[0-9a-f]{16} -->/, "<!-- /pem:v1:0000000000000000 -->"),
    "<!-- /pem:v1:0000000000000000 -->"
  ];
  for (const malformed of cases) assert.throws(() => collapse(malformed), /Malformed|Invalid|Unterminated/);
});

test("expand validates ranges and evidence fence bounds", async () => {
  const reader: SourceReader = { read: async () => ({ bytes: new TextEncoder().encode("one\ntwo"), text: "one\ntwo" }) };
  await assert.rejects(() => expand("a.ts#L3", reader), /outside/);
  const long = "`".repeat(128) + "~".repeat(128);
  await assert.rejects(() => expand("a.ts#L1", { read: async () => ({ bytes: new TextEncoder().encode(long), text: long }) }), /fence/);
});

test("collapse validates missing, oversized, malformed, and inconsistent metadata", async () => {
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  const block = (value: string, sum = digest(value), leading = true) => `${leading ? "\n" : ""}<!-- pem:v1:${value}:${sum} -->\nSource: a.ts#L1\n` + "`\none\n`\n" + `<!-- /pem:v1:${sum} -->\n`;

  const withoutEndMarker = block(encoded({ p: "a.ts", o: "a.ts#L1", s: 1, e: 1 })).replace(/\n<!-- \/pem:v1:.*\n$/, "\n");
  assert.throws(() => collapse(withoutEndMarker), /Unterminated/);
  assert.throws(() => collapse(block("A".repeat(16385))), /Malformed/);
  assert.throws(() => collapse(block("A")), /Malformed/);
  const missingField = encoded({ p: 7, o: "a.ts#L1", s: 1, e: 1 });
  assert.throws(() => collapse(block(missingField)), /Invalid source evidence metadata/);
  const mismatchedReference = encoded({ p: "other.ts", o: "a.ts#L1", s: 1, e: 1 });
  assert.throws(() => collapse(block(mismatchedReference)), /Invalid source evidence metadata/);
  const invalidOriginal = encoded({ p: "a.ts", o: "not-a-source-reference", s: 1, e: 1 });
  assert.throws(() => collapse(block(invalidOriginal)), /Invalid source evidence metadata/);
  const valid = encoded({ p: "a.ts", o: "a.ts#L1", s: 1, e: 1 });
  assert.deepEqual(collapse(block(valid, digest(valid), false)).content, "a.ts#L1");
});

test("rejects unsafe paths with the public invalid-reference category", () => {
  assert.throws(() => parseReference("/absolute.ts#L1"), error => {
    assert.equal((error as { category?: string }).category, "invalid_reference");
    assert.equal((error as Error).message, "Source reference must be project-relative");
    return true;
  });
});

test("reference grammar requires complete labels, anchors, and scheme boundaries", () => {
  assert.equal(parseReference("[label](src/a.ts#L1)tail"), undefined);
  assert.equal(parseReference("[label](src/a.ts#L1)" )?.path, "src/a.ts");
  assert.equal(parseReference("src/a.ts#L1x"), undefined);
  assert.equal(parseReference("x.ts#L1-L2" )?.endLine, 2);
  assert.throws(() => parseReference("a:foo.ts#L1"), /project-relative/);
  assert.throws(() => parseReference("a+b:foo.ts#L1"), /project-relative/);
  const exact = `${"a".repeat(4087)}#L1`;
  assert.equal(exact.length, 4090);
  assert.ok(parseReference(exact));
  assert.equal(parseReference(`${exact}xxx`), undefined);
  const maxLiteral = `${"a".repeat(4093)}#L1`;
  assert.equal(maxLiteral.length, 4096);
  assert.ok(parseReference(maxLiteral));
  assert.equal(parseReference(`${maxLiteral}x`), undefined);
});

test("does not discover references in prefixed, unmatched, or fenced code and handles list anchors", async () => {
  const input = "prefix`a.ts#L1` a.ts#L2\n- `b.ts#L1`\n- `c.ts#L1` extra\n~~~\n- `d.ts#L1`\n~~~";
  const paths: string[] = [];
  const reader: SourceReader = { read: async path => {
    paths.push(path);
    return { bytes: new TextEncoder().encode("one\ntwo"), text: "one\ntwo" };
  } };
  const expanded = await expand(input, reader);
  assert.deepEqual(paths, ["a.ts", "b.ts"]);
  assert.deepEqual(expanded.captures.map(c => c.path), ["a.ts", "b.ts"]);
});

test("deduplicates overlapping list/link matches and retains source order", async () => {
  const input = "- `first.ts#L1`\nSee [second](second.ts#L1) and first.ts#L2";
  const expanded = await expand(input, { read: async path => ({ bytes: new TextEncoder().encode("x\ny"), text: "x\ny" }) });
  assert.deepEqual(expanded.captures.map(c => [c.path, c.startLine]), [["first.ts", 1], ["second.ts", 1], ["first.ts", 2]]);
  assert.equal(collapse(expanded.content).content, input);
});

test("masks inline delimiter runs without masking adjacent text", async () => {
  const input = "``a.ts#L1`` and a.ts#L2";
  const paths: string[] = [];
  const expanded = await expand(input, { read: async path => { paths.push(path); return { bytes: new TextEncoder().encode("x\ny"), text: "x\ny" }; } });
  assert.deepEqual(paths, ["a.ts"]);
  assert.equal(expanded.captures[0]?.startLine, 2);
});

test("supports exact evidence fence limits and collapse at EOF", async () => {
  const source = "x" + "`".repeat(127);
  const expanded = await expand("a.ts#L1", { read: async () => ({ bytes: new TextEncoder().encode(source), text: source }) });
  assert.ok(expanded.content.includes(`\n~\nx${"`".repeat(127)}\n~\n`));
  assert.equal(collapse(expanded.content).content, "a.ts#L1");
  const noFinalNewline = expanded.content.replace(/\n$/, "");
  assert.equal(collapse(noFinalNewline).content, "a.ts#L1");
  const tooLong = "`".repeat(128) + "~".repeat(128);
  await assert.rejects(() => expand("a.ts#L1", { read: async () => ({ bytes: new TextEncoder().encode(tooLong), text: tooLong }) }), /fence/);
});

test("validates every evidence metadata field and visible line exactly", async () => {
  const reader: SourceReader = { read: async () => ({ bytes: new TextEncoder().encode("one"), text: "one" }) };
  const evidence = (await expand("a.ts#L1", reader)).content;
  assert.throws(() => collapse(evidence.replace("Source: a.ts#L1", "prefix Source: a.ts#L1")), /Malformed/);
  assert.throws(() => collapse(evidence.replace("Source: a.ts#L1", "Source: a.ts#L1 trailing")), /Malformed/);
  assert.throws(() => collapse(evidence.replace("<!-- /pem:v1:", "x<!-- /pem:v1:")), /checksum|Unterminated/);
});

test("freshness uses error causes and direct codes with unreadable priority", async () => {
  const capture = (path: string) => ({ path, startLine: 1, endLine: 1, sha256: "", content: "" });
  const summary = await checkFreshness([capture("cause"), capture("direct")], { read: async path => {
    if (path === "cause") throw Object.assign(new Error("wrapped"), { cause: { code: "EACCES" } });
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  } });
  assert.equal(summary.status, "unreadable");
  assert.deepEqual(summary.occurrences.map(o => o.status), ["unreadable", "missing"]);
});

test("freshness reports every status, priority, and reads duplicate paths once", async () => {
  const captures = [
    { path: "valid.ts", startLine: 1, endLine: 1, sha256: "", content: "v" },
    { path: "changed.ts", startLine: 1, endLine: 1, sha256: "different", content: "c" },
    { path: "missing.ts", startLine: 1, endLine: 1, sha256: "", content: "m" },
    { path: "bad.ts", startLine: 1, endLine: 1, sha256: "", content: "b" },
    { path: "changed.ts", startLine: 2, endLine: 2, sha256: "different", content: "c" },
    { path: "missing.ts", startLine: 2, endLine: 2, sha256: "", content: "m" }
  ];
  const validBytes = new TextEncoder().encode("v");
  captures[0]!.sha256 = createHash("sha256").update(validBytes).digest("hex");
  const reads = new Map<string, number>();
  const reader: SourceReader = { read: async path => {
    reads.set(path, (reads.get(path) ?? 0) + 1);
    if (path === "valid.ts") return { bytes: validBytes, text: "v" };
    if (path === "changed.ts") return { bytes: new TextEncoder().encode("different"), text: "different" };
    throw Object.assign(new Error(path), { code: path === "missing.ts" ? "ENOENT" : "EACCES" });
  } };
  const summary = await checkFreshness(captures, reader);
  assert.equal(summary.status, "unreadable");
  assert.deepEqual(summary.occurrences.map(item => item.status), ["valid", "changed", "missing", "unreadable", "changed", "missing"]);
  assert.equal(reads.get("changed.ts"), 1);
  assert.equal(reads.get("missing.ts"), 1);
  assert.equal((await checkFreshness([], reader)).status, "valid");
  const caused = { path: "caused.ts", startLine: 1, endLine: 1, sha256: "", content: "" };
  const causedSummary = await checkFreshness([caused], { read: async () => { throw Object.assign(new Error("wrapped"), { cause: { code: "ENOENT" } }); } });
  assert.equal(causedSummary.status, "missing");
});
