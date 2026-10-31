import { lstatSync, realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SourceReader } from "./contracts.ts";
import { ExplorationMemoryError } from "./errors.ts";

const MEMORY_DIRECTORY = path.join(".pi", "project-exploration-memory");

type FsError = NodeJS.ErrnoException;

function domainError(category: "invalid_reference" | "source_unavailable" | "persistence", message: string, cause?: unknown): ExplorationMemoryError {
  return new ExplorationMemoryError(category, message, cause === undefined ? undefined : { cause });
}

function codeOf(error: unknown): string | undefined {
  return (error as FsError | undefined)?.code;
}

function canonicalDirectory(directory: string, description: string): string {
  try {
    const resolved = realpathSync(directory);
    if (!statSync(resolved).isDirectory()) {
      throw domainError("invalid_reference", `${description} is not a directory`);
    }
    return resolved;
  } catch (error) {
    if (error instanceof ExplorationMemoryError) throw error;
    throw domainError("invalid_reference", `Cannot select ${description}: ${codeOf(error) ?? "filesystem error"}`, error);
  }
}

function relativePath(value: string, kind: string): void {
  if (value.length === 0 || path.isAbsolute(value) || value.includes("\\") || value.includes("\0")) {
    throw domainError("invalid_reference", `${kind} must be a non-empty project-relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || part === "." || part.length === 0)) {
    throw domainError("invalid_reference", `${kind} must not contain traversal or empty path segments`);
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export interface ResolvedProject {
  projectRoot: string;
  memoryRoot: string;
}

/** Resolve the selected project; an explicit path is relative to cwd and may select any local directory. */
export function resolveProject(cwd: string, project?: string): ResolvedProject {
  const processRoot = canonicalDirectory(cwd, "cwd");
  const selected = project === undefined ? processRoot : canonicalDirectory(path.resolve(processRoot, project), "project");
  return {
    projectRoot: selected,
    memoryRoot: path.join(selected, MEMORY_DIRECTORY),
  };
}

function rejectMemorySymlinks(projectRoot: string, candidate: string): void {
  const relative = path.relative(projectRoot, candidate);
  /* Stryker disable next-line MethodExpression -- path.relative normalizes valid descendants, so it cannot produce empty components. */
  const components = relative.split(path.sep).filter(Boolean);
  let current = projectRoot;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) {
        throw domainError("invalid_reference", `Memory path contains a symbolic link: ${current}`);
      }
    } catch (error) {
      if (error instanceof ExplorationMemoryError) throw error;
      if (codeOf(error) === "ENOENT") break;
      /* c8 ignore next -- Node lstat errors provide a code; this fallback is defensive only. */
      throw domainError("persistence", `Cannot inspect memory path (${codeOf(error) ?? "filesystem error"})`, error);
    }
  }
}

/** Return a path below the fixed memory directory, safely even when storage has not been created yet. */
export function containedMemoryPath(projectRoot: string, relative = ""): string {
  const root = canonicalDirectory(projectRoot, "project root");
  const memoryRoot = path.join(root, MEMORY_DIRECTORY);
  if (relative !== "" && relative !== ".") relativePath(relative, "memory path");
  const candidate = relative === "" || relative === "." ? memoryRoot : path.resolve(memoryRoot, ...relative.split("/"));
  /* c8 ignore next 4 -- relativePath rejects every escape segment before resolution; this remains defense-in-depth. */
  /* Stryker disable all -- lexical validation makes this containment failure unreachable; it is defense-in-depth. */
  if (!contained(memoryRoot, candidate)) {
    throw domainError("invalid_reference", "Memory path escapes the selected project");
  }
  /* Stryker restore all */
  rejectMemorySymlinks(root, candidate);
  return candidate;
}

export interface SourceReaderOptions {
  /** Test seam; it is invoked only after realpath and regular-file checks. */
  readFile?: (absolutePath: string) => Promise<Uint8Array>;
}

/** Create a reader whose every operation validates lexical and realpath containment before opening. */
export function createSourceReader(projectRoot: string, options: SourceReaderOptions = {}): SourceReader {
  const root = canonicalDirectory(projectRoot, "project root");
  const open = options.readFile ?? (async (absolutePath: string) => new Uint8Array(await readFile(absolutePath)));

  return {
    async read(sourcePath: string): Promise<{ bytes: Uint8Array; text: string }> {
      relativePath(sourcePath, "source path");
      const lexical = path.resolve(root, ...sourcePath.split("/"));
      /* c8 ignore next 4 -- relativePath rejects every lexical escape before resolution; this remains defense-in-depth. */
      /* Stryker disable all -- lexical validation makes this containment failure unreachable; it is defense-in-depth. */
      if (!contained(root, lexical)) {
        throw domainError("invalid_reference", "Source path escapes the selected project");
      }
      /* Stryker restore all */
      let actual: string;
      try {
        actual = await realpath(lexical);
        if (!contained(root, actual)) {
          throw domainError("invalid_reference", "Source symlink resolves outside the selected project");
        }
        if (!(await stat(actual)).isFile()) {
          throw domainError("source_unavailable", `Source is not a regular file: ${sourcePath}`);
        }
      } catch (error) {
        if (error instanceof ExplorationMemoryError) throw error;
        /* c8 ignore next -- Node's realpath errors expose a filesystem code; the fallback is defensive only. */
        throw domainError("source_unavailable", `Cannot resolve source ${sourcePath} (${codeOf(error) ?? "filesystem error"})`, error);
      }
      let bytes: Uint8Array;
      try {
        bytes = await open(actual);
      } catch (error) {
        throw domainError("source_unavailable", `Cannot read source ${sourcePath} (${codeOf(error) ?? "filesystem error"})`, error);
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        throw domainError("source_unavailable", `Source is not valid UTF-8: ${sourcePath}`, error);
      }
      return { bytes: new Uint8Array(bytes), text };
    },
  };
}

