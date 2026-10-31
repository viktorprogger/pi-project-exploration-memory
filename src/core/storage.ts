import { createHash, randomBytes } from "node:crypto";
import { isAlias, isMap, isNode, isSeq, parseDocument as parseYamlDocument, stringify } from "yaml";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { containedMemoryPath, resolveProject } from "./project-root.ts";
import { CATALOG_SCHEMA_VERSION, type Catalog, type CatalogEntry, type CurrentDocument, type HistoryEntry, type IntegrityWarning, type PublicationHook, type SourceCapture } from "./contracts.ts";
import { ExplorationMemoryError, invalidInput, notFound } from "./errors.ts";

export const documentSha256 = (bytes: Uint8Array | string) => createHash("sha256").update(typeof bytes === "string" ? Buffer.from(bytes) : bytes).digest("hex");
const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const safeSlug = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(v);
const text = (v: unknown) => typeof v === "string" && !!v.trim();
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const fail = (category: "malformed_state" | "incomplete_or_inconsistent_state" | "persistence", message: string, cause?: unknown) => new ExplorationMemoryError(category, message, cause === undefined ? undefined : { cause });
function strictJson(source: string, owner: string): unknown {
  const seen: Set<string>[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let i = 0; i < source.length; i++) {
    const character = source[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        inString = false;
        let next = i + 1;
        while (next < source.length && /\s/.test(source[next]!)) next++;
        if (source[next] === ":" && seen.length > 0) {
          const key = JSON.parse(source.slice(stringStart, i + 1)) as string;
          const fields = seen[seen.length - 1]!;
          if (fields.has(key)) throw fail("malformed_state", `Duplicate field in ${owner}`);
          fields.add(key);
        }
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      stringStart = i;
    } else if (character === "{") {
      seen.push(new Set());
    } else if (character === "}") {
      seen.pop();
    }
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw fail("malformed_state", `Cannot parse ${owner}`, error);
  }
}
function decode(bytes: Uint8Array, owner: string): string { try{return new TextDecoder("utf-8",{fatal:true}).decode(bytes)}catch(e){throw fail("incomplete_or_inconsistent_state",`Invalid UTF-8 in ${owner}`,e)} }
function validateCapture(v: unknown, owner: string): asserts v is SourceCapture { if(!obj(v)||!exactKeys(v,["path","startLine","endLine","sha256","content","originalLiteral"]) && !(obj(v)&&exactKeys(v,["path","startLine","endLine","sha256","content"]))) throw fail("malformed_state",`Malformed capture in ${owner}`); if(typeof v.path!=="string"||!v.path||v.path.startsWith("/")||v.path.includes("\\")||v.path.split("/").some(x=>!x||x==='.'||x==='..')||!Number.isSafeInteger(v.startLine)||!Number.isSafeInteger(v.endLine)||(v.startLine as number)<1||(v.endLine as number)<(v.startLine as number)||typeof v.sha256!=="string"||!/^[a-f0-9]{64}$/.test(v.sha256)||typeof v.content!=="string"||("originalLiteral" in v&&typeof v.originalLiteral!=="string")) throw fail("malformed_state",`Malformed capture in ${owner}`); }
function validateCatalog(v: unknown): Catalog { if(!obj(v)||v.schemaVersion!==2||!exactKeys(v,["schemaVersion","entries"])||!Array.isArray(v.entries)) { if(obj(v)&&"schemaVersion" in v&&v.schemaVersion!==2) throw new ExplorationMemoryError("unsupported_schema","Unsupported catalog schema version"); throw fail("malformed_state","Catalog is malformed"); } const out: CatalogEntry[]=[];let prev="";for(const e of v.entries){if(!obj(e)||!exactKeys(e,["slug","title","description","documentSha256","history"])||!safeSlug(e.slug)||!text(e.title)||!text(e.description)||typeof e.documentSha256!=="string"||!/^[a-f0-9]{64}$/.test(e.documentSha256)||!Array.isArray(e.history)||e.slug<=prev)throw fail("malformed_state","Catalog entry is malformed");prev=e.slug;const history:HistoryEntry[]=[];let last="";for(const h of e.history){if(!obj(h)||!exactKeys(h,["timestamp","reason"])||typeof h.timestamp!=="string"||Number.isNaN(Date.parse(h.timestamp))||!text(h.reason)||h.timestamp<last)throw fail("malformed_state",`History is malformed for ${e.slug}`);last=h.timestamp;history.push(h as unknown as HistoryEntry)}out.push({...e,history} as CatalogEntry)}return {schemaVersion:2,entries:out}; }
function rejectYamlFeatures(node: unknown, owner: string): void {
  if (isAlias(node) || (isNode(node) && ("anchor" in node || "tag" in node) && ((node as any).anchor !== undefined || (node as any).tag !== undefined))) throw fail("malformed_state", `Unsupported YAML feature in ${owner}`);
  const value = node as any;
  if (isMap(node) || isSeq(node)) for (const item of value.items) {
    if (isMap(node)) { rejectYamlFeatures(item.key, owner); rejectYamlFeatures(item.value, owner); }
    else rejectYamlFeatures(item, owner);
  }
}
function parseDocument(bytes: Uint8Array, slug: string): CurrentDocument {
  const s=decode(bytes,`${slug}.md`);
  const m=/^(\uFEFF)?---(\r\n|\n)([\s\S]*?)(\r\n|\n)---(\r\n|\n)([\s\S]*)$/.exec(s);
  if(!m) throw fail("malformed_state",`Malformed front matter for ${slug}`);
  const source=m[3]!;
  if (source.includes("\uFEFF")) throw fail("malformed_state",`Metadata BOM is unsupported for ${slug}`);
  const first=source.trimStart();
  if (first.startsWith("{") || first.startsWith("[")) throw fail("malformed_state",`JSON front matter is unsupported for ${slug}`);
  try {
    const document=parseYamlDocument(source,{schema:"core",uniqueKeys:true,stringKeys:true});
    if(document.errors.length || document.warnings.length || !isMap(document.contents)) throw fail("malformed_state",`Cannot parse ${slug}.md front matter`);
    rejectYamlFeatures(document.contents,`${slug}.md front matter`);
    const meta=document.toJSON() as unknown;
    if(!obj(meta)||meta.schemaVersion!==2){if(obj(meta)&&typeof meta.schemaVersion === "number"&&meta.schemaVersion!==2)throw new ExplorationMemoryError("unsupported_schema",`Unsupported document schema version for ${slug}`);throw fail("malformed_state",`Malformed front matter for ${slug}`)}
    if(!exactKeys(meta,["schemaVersion","slug","captures"])||meta.slug!==slug||!Array.isArray(meta.captures))throw fail("malformed_state",`Malformed front matter for ${slug}`);
    for(const c of meta.captures)validateCapture(c,slug);
    return {slug,content:m[6]!,captures:meta.captures as SourceCapture[]};
  } /* c8 ignore next -- parser diagnostics and validation normalize all expected failures above. */ catch(error) { if(error instanceof ExplorationMemoryError) throw error; throw fail("malformed_state",`Cannot parse ${slug}.md front matter`,error); }
}
export interface StorageOptions { beforeRename?: (target:string)=>void|Promise<void>; afterRename?: (target:string)=>void|Promise<void>; publicationHook?: PublicationHook }
export interface StoredProject { projectRoot:string; memoryRoot:string; catalog():Promise<Catalog>; read(slug:string):Promise<CurrentDocument>; replace(document:CurrentDocument,metadata:Pick<CatalogEntry,"title"|"description">,reason:string):Promise<{document:CurrentDocument;entry:CatalogEntry}>; history(slug:string):Promise<HistoryEntry[]> }
export function createStorage(cwd:string,project?:string,options:StorageOptions={}):StoredProject { const resolved=resolveProject(cwd,project);const memory=()=>containedMemoryPath(resolved.projectRoot);const file=(p:string)=>containedMemoryPath(resolved.projectRoot,p);const json=(v:unknown)=>JSON.stringify(v,null,2)+"\n";async function ensure(){await mkdir(file("documents"),{recursive:true})} async function artifacts(dir:string):Promise<boolean>{let es;try{es=await readdir(dir,{withFileTypes:true})}catch(e){/* c8 ignore next 2 -- a disappearing directory is a filesystem race outside the public deterministic contract. */ if(code(e)==="ENOENT")return false;throw e}for(const e of es){if(e.isFile()||e.isSymbolicLink()||await artifacts(`${dir}/${e.name}`))return true}return false} async function rawCatalog(){try{return validateCatalog(strictJson(decode(new Uint8Array(await readFile(file("catalog.json"))),"catalog.json"),"catalog.json"))}catch(e){if(code(e)==="ENOENT"){if(await artifacts(memory()))throw fail("incomplete_or_inconsistent_state","Catalog is missing while persisted memory files exist");await ensure();return {schemaVersion:2 as const,entries:[]}}if(e instanceof ExplorationMemoryError)throw e;throw fail("malformed_state","Cannot parse catalog",e)}} async function atomic(target:string,data:Uint8Array|string){const tmp=`${target}.${randomBytes(8).toString("hex")}.tmp`;try{await writeFile(tmp,data);await options.beforeRename?.(target);await rename(tmp,target);await options.afterRename?.(target)}finally{await rm(tmp,{force:true})}} async function read(slug:string){if(!safeSlug(slug))throw invalidInput("Slug must be a safe lowercase path segment");const c=await rawCatalog();const e=c.entries.find(x=>x.slug===slug);if(!e)throw notFound(`Unknown memory document: ${slug}`);try{const bytes=new Uint8Array(await readFile(file(`documents/${slug}.md`)));const d=parseDocument(bytes,slug);if(documentSha256(bytes)!==e.documentSha256)d.warnings=[{kind:"document_hash_mismatch",slug,expectedDocumentSha256:e.documentSha256,observedDocumentSha256:documentSha256(bytes)}];return d}catch(err){if(err instanceof ExplorationMemoryError)throw err;throw fail("incomplete_or_inconsistent_state",`Missing current document for ${slug}`,err)}} async function replace(doc:CurrentDocument,metadata:Pick<CatalogEntry,"title"|"description">,reason:string){if(!safeSlug(doc.slug))throw invalidInput("Slug must be a safe lowercase path segment");if(!text(metadata.title)||!text(metadata.description)||!text(reason))throw invalidInput("Title, description, and reason are required");if(!Array.isArray(doc.captures))throw fail("malformed_state",`Malformed captures in ${doc.slug}`);for(const capture of doc.captures)validateCapture(capture,doc.slug);const c=await rawCatalog(),old=c.entries.find(e=>e.slug===doc.slug);if(old)await read(doc.slug);const entryBase={slug:doc.slug,title:metadata.title,description:metadata.description,history:[...(old?.history??[]),{timestamp:new Date().toISOString(),reason}]};const markdown=`---\n${stringify({schemaVersion:2,slug:doc.slug,captures:doc.captures},{schema:"core",indent:2,lineWidth:0,aliasDuplicateObjects:false})}---\n${doc.content}`;const bytes=Buffer.from(markdown);const entry={...entryBase,documentSha256:documentSha256(bytes)};const next={schemaVersion:2 as const,entries:[...c.entries.filter(e=>e.slug!==doc.slug),entry].sort((a,b)=>a.slug.localeCompare(b.slug))};await atomic(file(`documents/${doc.slug}.md`),bytes);await atomic(file("catalog.json"),json(next));const clean: CurrentDocument={slug:doc.slug,content:doc.content,captures:doc.captures};await options.publicationHook?.published(clean,next);return {document:clean,entry}} async function history(slug:string){const c=await rawCatalog();const e=c.entries.find(x=>x.slug===slug);if(!e)throw notFound(`Unknown memory document: ${slug}`);await read(slug);return e.history} return {projectRoot:resolved.projectRoot,memoryRoot:memory(),catalog:rawCatalog,read,replace,history}; }
export { validateCatalog, parseDocument };
