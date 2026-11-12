// @ts-nocheck
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogEntry } from "../../src/core/contracts.ts";
import { documentSha256 } from "../../src/core/storage.ts";

test("catalog entries use the schema-2 public shape and whole-document hash", () => {
  const entry: CatalogEntry = { slug: "x", title: "T", description: "D", documentSha256: documentSha256("bytes"), history: [], status: "actual" };
  assert.deepEqual(Object.keys(entry).sort(), ["description", "documentSha256", "history", "slug", "status", "title"]);
  assert.match(entry.documentSha256, /^[a-f0-9]{64}$/);
});
