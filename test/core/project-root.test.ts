// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { containedMemoryPath, createSourceReader, resolveProject } from "../../src/core/project-root.ts";

async function tempProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "root-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const isCategory = (expected: string) => (error: unknown) => (error as { category?: string }).category === expected;

test("project selection resolves relative projects and preserves the memory location", async () => {
  const p = await tempProject();
  try {
    const selected = path.join(p.root, "selected");
    await mkdir(selected);
    assert.deepEqual(resolveProject(p.root, "selected"), {
      projectRoot: selected,
      memoryRoot: path.join(selected, ".pi", "project-exploration-memory"),
    });
    assert.equal(resolveProject(p.root, selected).projectRoot, selected);
  } finally { await p.cleanup(); }
});

test("project selection rejects missing and non-directory roots with observable categories", async () => {
  const p = await tempProject();
  try {
    assert.throws(() => resolveProject(path.join(p.root, "missing")), error =>
      isCategory("invalid_reference")(error) && (error as Error).message === "Cannot select cwd: ENOENT");
    const file = path.join(p.root, "file"); await writeFile(file, "x");
    assert.throws(() => resolveProject(file), error =>
      isCategory("invalid_reference")(error) && (error as Error).message === "cwd is not a directory");
    assert.throws(() => resolveProject(p.root, "missing"), error =>
      isCategory("invalid_reference")(error) && (error as Error).message === "Cannot select project: ENOENT");
    assert.throws(() => resolveProject(p.root, "file"), error =>
      isCategory("invalid_reference")(error) && (error as Error).message === "project is not a directory");
  } finally { await p.cleanup(); }
});

test("memory paths reject traversal, separators, and symlink components", async () => {
  const p = await tempProject();
  try {
    for (const value of ["../outside", "a/../../outside", "/outside", "a/../b", "a//b", "./a", "a\\b", "a\0b"]) {
      assert.throws(() => containedMemoryPath(p.root, value), error =>
        isCategory("invalid_reference")(error) && !(("cause" in (error as object))) && /memory path|Memory path/.test((error as Error).message));
    }
    assert.equal(containedMemoryPath(p.root), path.join(p.root, ".pi/project-exploration-memory"));
    assert.equal(containedMemoryPath(p.root, "."), containedMemoryPath(p.root));
    const memory = path.join(p.root, ".pi", "project-exploration-memory");
    await mkdir(path.join(p.root, ".pi"), { recursive: true });
    await symlink(os.tmpdir(), memory);
    assert.throws(() => containedMemoryPath(p.root, "child"), error =>
      isCategory("invalid_reference")(error) && (error as Error).message.includes("Memory path contains a symbolic link"));

    const p2 = await tempProject();
    try {
      await symlink(os.tmpdir(), path.join(p2.root, ".pi"));
      assert.throws(() => containedMemoryPath(p2.root), /Memory path contains a symbolic link/);
    } finally { await p2.cleanup(); }

    const nested = path.join(p.root, ".pi", "project-exploration-memory", "nested");
    await rm(memory, { recursive: true, force: true });
    await mkdir(path.dirname(nested), { recursive: true });
    await symlink(os.tmpdir(), nested);
    assert.throws(() => containedMemoryPath(p.root, "nested/file"), /Memory path contains a symbolic link/);
  } finally { await p.cleanup(); }
});

test("source reader enforces project containment and regular UTF-8 files", async () => {
  const p = await tempProject(); const outside = await mkdtemp(path.join(os.tmpdir(), "outside-"));
  try {
    await mkdir(path.join(p.root, "src"));
    await writeFile(path.join(p.root, "src", "ok.ts"), "héllo");
    const reader = createSourceReader(p.root);
    const result = await reader.read("src/ok.ts");
    assert.equal(result.text, "héllo"); assert.deepEqual([...result.bytes], [...new TextEncoder().encode("héllo")]);
    for (const source of ["", "../x.ts", "src/../x.ts", "/x.ts", "src\\x.ts", "src//x.ts", "src/./x.ts", "src/\0x.ts"]) {
      await assert.rejects(() => reader.read(source), error =>
        (isCategory("invalid_reference")(error) && (error as Error).message === "source path must be a non-empty project-relative path") ||
        (isCategory("invalid_reference")(error) && (error as Error).message === "source path must not contain traversal or empty path segments"));
    }
    await assert.rejects(() => reader.read("src/missing.ts"), error =>
      isCategory("source_unavailable")(error) && (error as Error).message === "Cannot resolve source src/missing.ts (ENOENT)");
    await assert.rejects(() => reader.read("src"), error =>
      isCategory("source_unavailable")(error) && (error as Error).message === "Source is not a regular file: src");
    const outsideFile = path.join(outside, "outside.ts"); await writeFile(outsideFile, "outside");
    await symlink(outsideFile, path.join(p.root, "src", "outside.ts"));
    await assert.rejects(() => reader.read("src/outside.ts"), error =>
      isCategory("invalid_reference")(error) && (error as Error).message === "Source symlink resolves outside the selected project");
    await mkdir(path.join(p.root, "dir"));
    await symlink(path.join(p.root, "dir"), path.join(p.root, "src", "dir-link"));
    await assert.rejects(() => reader.read("src/dir-link"), error =>
      isCategory("source_unavailable")(error) && (error as Error).message === "Source is not a regular file: src/dir-link");
    await writeFile(path.join(p.root, "inside.ts"), "inside");
    await symlink(path.join(p.root, "inside.ts"), path.join(p.root, "src", "inside-link.ts"));
    assert.equal((await reader.read("src/inside-link.ts")).text, "inside");
  } finally { await p.cleanup(); await rm(outside, { recursive: true, force: true }); }
});

test("source reader reports injected read and UTF-8 failures", async () => {
  const p = await tempProject();
  try {
    const file = path.join(p.root, "a.ts"); await writeFile(file, "x");
    const failing = createSourceReader(p.root, { readFile: async () => { throw Object.assign(new Error("no"), { code: "EACCES" }); } });
    await assert.rejects(() => failing.read("a.ts"), error =>
      isCategory("source_unavailable")(error) && (error as Error).message === "Cannot read source a.ts (EACCES)");
    const invalid = createSourceReader(p.root, { readFile: async () => new Uint8Array([0xff]) });
    await assert.rejects(() => invalid.read("a.ts"), error =>
      isCategory("source_unavailable")(error) && (error as Error).message === "Source is not valid UTF-8: a.ts");
  } finally { await p.cleanup(); }
});

test("fallback messages handle uncoded public failures", async () => {
  assert.throws(() => resolveProject(Symbol("cwd") as unknown as string), /Cannot select cwd: filesystem error/);

  const p = await tempProject();
  try {
    await mkdir(path.join(p.root, ".pi", "project-exploration-memory"), { recursive: true });
    await assert.throws(() => containedMemoryPath(p.root, "a".repeat(300)), isCategory("persistence"));
    await writeFile(path.join(p.root, "a.ts"), "x");
    const reader = createSourceReader(p.root, { readFile: async () => { throw "read failed"; } });
    await assert.rejects(() => reader.read("a.ts"), error =>
      (error as Error).message.includes("Cannot read source a.ts (filesystem error)"));
    const nullFailure = createSourceReader(p.root, { readFile: async () => { throw null; } });
    await assert.rejects(() => nullFailure.read("a.ts"), error =>
      isCategory("source_unavailable")(error) &&
      (error as Error).message === "Cannot read source a.ts (filesystem error)" &&
      "cause" in (error as object) && (error as { cause?: unknown }).cause === null);
  } finally { await p.cleanup(); }
});
