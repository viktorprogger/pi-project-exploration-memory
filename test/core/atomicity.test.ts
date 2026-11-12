// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createStorage } from "../../src/core/storage.ts";

const temp = () => mkdtemp(path.join(os.tmpdir(), "atomic-core-"));
const memory = (r: string) => path.join(r, ".pi", "project-exploration-memory");

test("independent rename failure leaves complete old/new files and cleans temporary files", async () => {
  const root = await temp(); try {
    const base = createStorage(root); await base.replace({ slug: "a", content: "old", captures: [] }, { title: "A", description: "D" }, "create");
    const failing = createStorage(root, undefined, { beforeRename: target => { if (target.endsWith("a.md")) throw new Error("injected"); } });
    await assert.rejects(() => failing.replace({ slug: "a", content: "new", captures: [] }, { title: "A", description: "D" }, "edit"));
    assert.match(await readFile(path.join(memory(root), "documents", "a.md"), "utf8"), /old/);
    assert.match(await readFile(path.join(memory(root), "catalog.json"), "utf8"), /create/);
    assert.equal((await readdir(path.join(memory(root), "documents"))).some(x => x.endsWith(".tmp")), false);

    let calls = 0; const partial = createStorage(root, undefined, { afterRename: () => { if (++calls === 1) throw new Error("after rename"); } });
    await assert.rejects(() => partial.replace({ slug: "a", content: "new", captures: [] }, { title: "A", description: "D" }, "edit"));
    const read = await base.read("a"); assert.equal(read.content, "new"); assert.equal(read.warnings?.[0]?.slug, "a");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("catalog rename failures leave deterministic partial state and clean every temporary file", async () => {
  const root = await temp(); try {
    const base = createStorage(root); await base.replace({ slug: "a", content: "old", captures: [] }, { title: "A", description: "D" }, "create");
    let published = 0; const failing = createStorage(root, undefined, {
      beforeRename: target => { if (target.endsWith("catalog.json")) throw new Error("catalog rename"); },
      publicationHook: { published: () => { published++; } },
    });
    await assert.rejects(() => failing.replace({ slug: "a", content: "new", captures: [] }, { title: "A2", description: "D2" }, "edit"));
    assert.equal(JSON.parse(await readFile(path.join(memory(root), "catalog.json"), "utf8")).entries[0].title, "A");
    assert.equal((await base.read("a")).content, "new"); assert.equal(published, 0);
    assert.equal((await readdir(path.join(memory(root), "documents"))).some(x => x.endsWith(".tmp")), false);
    assert.equal((await readdir(memory(root))).some(x => x.endsWith(".tmp")), false);

    let count = 0; const after = createStorage(root, undefined, { afterRename: target => { if (target.endsWith("catalog.json") && ++count === 1) throw new Error("after catalog"); } });
    await assert.rejects(() => after.replace({ slug: "a", content: "final", captures: [] }, { title: "A3", description: "D3" }, "again"));
    assert.equal(JSON.parse(await readFile(path.join(memory(root), "catalog.json"), "utf8")).entries[0].title, "A3");
    assert.equal((await readdir(path.join(memory(root), "documents"))).some(x => x.endsWith(".tmp")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
