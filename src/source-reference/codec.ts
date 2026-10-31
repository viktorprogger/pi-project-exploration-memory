import { createHash } from "node:crypto";
import type { CollapsedDocument, ExpandedDocument, FreshnessStatus, FreshnessSummary, SourceCapture, SourceReader } from "../core/contracts.ts";
import { ExplorationMemoryError, invalidInput } from "../core/errors.ts";

const MAX_LITERAL = 4096;
const MAX_METADATA = 8192;
const MAX_FENCE = 128;
const START = "<!-- pem:v1:";
const END = "<!-- /pem:v1:";

export interface ParsedReference { path: string; startLine: number; endLine: number; originalLiteral: string }

function reject(message: string): never { throw new ExplorationMemoryError("invalid_reference", message); }
function validatePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.includes("://") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) reject("Source reference must be project-relative");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) reject("Source reference contains traversal or empty segments");
  if (/[?#]/.test(path)) reject("Source reference has an unsupported query or fragment");
}

/** Parse a supported project-relative path#Lstart[-Lend] literal. */
export function parseReference(literal: string): ParsedReference | undefined {
  if (literal.length === 0 || literal.length > MAX_LITERAL) return undefined;
  const labeled = literal.match(/^\[[^\]\n]{1,512}\]\(([^()\s]+)\)$/);
  const target = labeled?.[1] ?? literal;
  const match = target.match(/^(.+)#L(\d+)(?:-L(\d+))?$/);
  if (!match) return undefined;
  const path = match[1];
  const startLine = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : startLine;
  if (!path || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) reject("Invalid source line range");
  validatePath(path);
  return { path, startLine, endLine, originalLiteral: literal };
}

function protectedMask(content: string): Uint8Array {
  const mask = new Uint8Array(content.length);
  const lines = content.split(/\n/);
  let offset = 0;
  let fence: { char: string; length: number } | undefined;
  let inline: string | undefined;
  for (const line of lines) {
    const opening = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      for (let i = offset; i < offset + line.length; i++) mask[i] = 1;
      const close = line.match(new RegExp(`^\\s*${fence.char}{${fence.length},}\\s*$`));
      if (close) fence = undefined;
      offset += line.length + 1;
      continue;
    }
    if (opening) {
      const run = opening[1]!;
      fence = { char: run[0]!, length: run.length };
      for (let i = offset; i < offset + line.length; i++) mask[i] = 1;
      offset += line.length + 1;
      continue;
    }
    let i = 0;
    while (i < line.length) {
      if (line[i] === "`") {
        const run = line.slice(i).match(/^`+/)![0];
        if (!inline) inline = run;
        else if (inline === run) inline = undefined;
        for (let j = i; j < i + run.length; j++) mask[offset + j] = 1;
        i += run.length;
      } else { if (inline) mask[offset + i] = 1; i++; }
    }
    offset += line.length + 1;
  }
  return mask;
}

function embeddedReference(literal: string): ParsedReference | undefined {
  const direct = parseReference(literal);
  if (direct) return direct;
  const inline = literal.match(/^`([^`\n]+)`$/);
  const parsed = inline ? parseReference(inline[1]!) : undefined;
  return parsed ? { ...parsed, originalLiteral: literal } : undefined;
}

function listItemReferences(content: string, mask: Uint8Array): { start: number; end: number; ref: ParsedReference }[] {
  const found: { start: number; end: number; ref: ParsedReference }[] = [];
  const re = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(`[^`\n]+`)[ \t]*$/gm;
  for (const match of content.matchAll(re)) {
    const token = match[1]!;
    const start = match.index! + match[0].indexOf(token); const end = start + token.length;
    // A fenced-code line is masked in its entirety; ordinary inline code is
    // masked only for the token, which is the list syntax we intentionally allow.
    if (mask[match.index!]) continue;
    const ref = embeddedReference(token);
    if (ref) found.push({ start, end, ref });
  }
  return found;
}

function references(content: string): ParsedReference[] {
  const mask = protectedMask(content);
  const found = listItemReferences(content, mask);
  const link = /\[[^\]\n]{1,512}\]\([^()\s]+\)/g;
  const bare = /(?:[A-Za-z][A-Za-z0-9+.-]*:)?[A-Za-z0-9_.~/-]+#L\d+(?:-L\d+)?/g;
  for (const re of [link, bare]) {
    for (const match of content.matchAll(re)) {
      const start = match.index!; const end = start + match[0].length;
      if ([...Array(end - start)].some((_, i) => mask[start + i])) continue;
      const ref = parseReference(match[0]);
      if (!ref || found.some((item) => start >= item.start && end <= item.end)) continue;
      found.push({ start, end, ref });
    }
  }
  return found.sort((a, b) => a.start - b.start).map((item) => item.ref);
}

function b64(value: string): string { return Buffer.from(value, "utf8").toString("base64url"); }
function unb64(value: string): string { return Buffer.from(value, "base64url").toString("utf8"); }
function checksum(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
function metadata(ref: ParsedReference): string {
  const value = JSON.stringify({ p: ref.path, s: ref.startLine, e: ref.endLine, o: ref.originalLiteral });
  if (value.length > MAX_METADATA || ref.originalLiteral.length > MAX_LITERAL) throw invalidInput("Source reference metadata exceeds codec bounds");
  return b64(value);
}
function fenceFor(source: string): string {
  let best = "";
  for (const char of ["`", "~"]) {
    let max = 0;
    for (const m of source.matchAll(new RegExp(`${char}+`, "g"))) max = Math.max(max, m[0].length);
    const candidate = char.repeat(max + 1);
    if (candidate.length <= MAX_FENCE && (!best || candidate.length < best.length)) best = candidate;
  }
  if (!best) throw invalidInput("Source evidence fence exceeds codec bounds");
  return best;
}

interface Block { start: number; end: number; literal: string }
function validBlocks(content: string): Block[] {
  const lines = content.split("\n"); const blocks: Block[] = []; let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith(START)) { if (line.includes(START) || line.startsWith(END)) reject("Malformed source evidence block"); offset += line.length + (i < lines.length - 1 ? 1 : 0); continue; }
    const startMatch = line.match(/^<!-- pem:v1:([A-Za-z0-9_-]+):([0-9a-f]{16}) -->$/);
    if (!startMatch) reject("Malformed source evidence block");
    const encodedStart = startMatch[1]!; const startChecksum = startMatch[2]!;
    let j = i + 1;
    const visible = lines[j++]; const vm = visible?.match(/^Source: (.+)#L(\d+)(?:-L(\d+))?$/); if (!vm) reject("Malformed source evidence block");
    const fence = lines[j++]; if (!fence || !/^(`+|~+)$/.test(fence) || fence.length > MAX_FENCE) reject("Malformed source evidence block");
    const sourceStart = j; while (j < lines.length && lines[j] !== fence) j++;
    if (j >= lines.length) reject("Unterminated source evidence block");
    const endLine = lines[j + 1]; if (!endLine) reject("Unterminated source evidence block");
    const em = endLine.match(/^<!-- \/pem:v1:([0-9a-f]{16}) -->$/); if (!em || em[1] !== startChecksum) reject("Invalid source evidence checksum");
    let meta: { p: string; s: number; e: number; o: string };
    try { const encoded = encodedStart; if (encoded.length > MAX_METADATA * 2) reject("Source metadata exceeds bounds"); meta = JSON.parse(unb64(encoded)) as typeof meta; } catch { reject("Malformed source evidence metadata"); }
    if (!meta! || typeof meta.p !== "string" || typeof meta.o !== "string" || checksum(encodedStart) !== startChecksum) reject("Invalid source evidence metadata");
    const ref = embeddedReference(meta.o); if (!ref || ref.path !== meta.p || ref.startLine !== meta.s || ref.endLine !== meta.e) reject("Invalid source evidence metadata");
    const start = offset > 0 && content[offset - 1] === "\n" ? offset - 1 : offset; let end = offset; for (let k = i; k <= j; k++) end += lines[k]!.length + 1;
    end += em[0].length; if (end < content.length && content[end] === "\n") end++;
    blocks.push({ start, end, literal: meta.o }); i = j + 1; offset = end;
  }
  return blocks;
}

export function collapse(content: string): CollapsedDocument {
  const blocks = validBlocks(content); let result = content;
  for (let i = blocks.length - 1; i >= 0; i--) { const block = blocks[i]!; result = result.slice(0, block.start) + block.literal + result.slice(block.end); }
  return { content: result };
}

export async function expand(content: string, reader: SourceReader): Promise<ExpandedDocument> {
  const source = collapse(content).content;
  const refs = references(source); const captures: SourceCapture[] = []; const reads = new Map<string, { bytes: Uint8Array; text: string }>();
  for (const ref of refs) {
    let read = reads.get(ref.path); if (!read) { read = await reader.read(ref.path); reads.set(ref.path, read); }
    const lines = read.text.split(/\r?\n/); if (ref.endLine > lines.length) throw invalidInput(`Source range is outside ${ref.path}`);
    const captured = lines.slice(ref.startLine - 1, ref.endLine).join("\n");
    const capture: SourceCapture = { ...ref, sha256: createHash("sha256").update(read.bytes).digest("hex"), content: captured }; captures.push(capture);
  }
  let result = source; const matches = referencesWithPositions(source);
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i]!; const { start, end, ref } = match; const capture = captures[i]!; const fence = fenceFor(capture.content); const meta = metadata(ref);
    const block = `\n${START}${meta}:${checksum(meta)} -->\nSource: ${ref.path}#L${ref.startLine}${ref.endLine === ref.startLine ? "" : `-L${ref.endLine}`}\n${fence}\n${capture.content}\n${fence}\n${END}${checksum(meta)} -->\n`;
    result = result.slice(0, start) + block + result.slice(end);
  }
  return { content: result, captures };
}
function referencesWithPositions(content: string): { start: number; end: number; ref: ParsedReference }[] {
  const mask = protectedMask(content); const all = listItemReferences(content, mask);
  const re = /\[[^\]\n]{1,512}\]\([^()\s]+\)|(?:[A-Za-z][A-Za-z0-9+.-]*:)?[A-Za-z0-9_.~/-]+#L\d+(?:-L\d+)?/g;
  for (const m of content.matchAll(re)) {
    const start = m.index!; const end = start + m[0].length;
    if ([...Array(end-start)].some((_,i)=>mask[start+i])) continue;
    const ref = parseReference(m[0]);
    if (ref && !all.some((item) => start >= item.start && end <= item.end)) all.push({start,end,ref});
  }
  return all.sort((a, b) => a.start - b.start);
}

export async function checkFreshness(captures: SourceCapture[], reader: SourceReader): Promise<FreshnessSummary> {
  const reads = new Map<string, { hash?: string; status?: FreshnessStatus }>(); const occurrences = [] as { capture: SourceCapture; status: FreshnessStatus }[];
  for (const capture of captures) {
    let entry = reads.get(capture.path);
    if (!entry) { entry = {}; reads.set(capture.path, entry); try { const read = await reader.read(capture.path); entry.hash = createHash("sha256").update(read.bytes).digest("hex"); } catch (error) { const code = (error as NodeJS.ErrnoException)?.cause && ((error as NodeJS.ErrnoException).cause as NodeJS.ErrnoException).code || (error as NodeJS.ErrnoException).code; entry.status = code === "ENOENT" ? "missing" : "unreadable"; } }
    const status = entry.status ?? (entry.hash === capture.sha256 ? "valid" : "changed"); occurrences.push({ capture, status });
  }
  const priority: FreshnessStatus[] = ["unreadable", "missing", "changed", "valid"]; const status = priority.find(s => occurrences.some(o => o.status === s)) ?? "valid";
  return { status, occurrences };
}
