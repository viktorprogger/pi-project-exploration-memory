/** Current-state domain contracts. */

export const CATALOG_SCHEMA_VERSION = 2 as const;
export type SchemaVersion = typeof CATALOG_SCHEMA_VERSION;
export type LifecycleStatus = "actual" | "archived";
export type RetireMode = "archive" | "supersede";
export interface ProjectSelection {
  project?: string;
}
export interface HistoryEntry {
  timestamp: string;
  reason: string;
}
export interface CatalogEntry {
  slug: string;
  title: string;
  description: string;
  documentSha256: string;
  history: HistoryEntry[];
  status: LifecycleStatus;
}
export interface Catalog {
  schemaVersion: SchemaVersion;
  entries: CatalogEntry[];
}
export interface SourceCapture {
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
  originalLiteral?: string;
  content: string;
}
export interface IntegrityWarning {
  kind: "document_hash_mismatch";
  slug: string;
  expectedDocumentSha256: string;
  observedDocumentSha256: string;
}
export interface CurrentDocument {
  slug: string;
  content: string;
  captures: SourceCapture[];
  status: LifecycleStatus;
  warnings?: IntegrityWarning[];
}
export interface ExpandedDocument {
  content: string;
  captures: SourceCapture[];
}
export interface CollapsedDocument {
  content: string;
}
export type FreshnessStatus = "valid" | "changed" | "missing" | "unreadable" | "not_applicable";
export interface OccurrenceFreshness {
  capture: SourceCapture;
  status: FreshnessStatus;
}
export interface FreshnessSummary {
  status: FreshnessStatus;
  occurrences: OccurrenceFreshness[];
}
export type DetailsView = "expanded" | "editable";
export interface CatalogRequest extends ProjectSelection {
  query?: string;
}
export interface CatalogResult {
  project: string;
  schemaVersion: SchemaVersion;
  entries: CatalogEntry[];
  warnings?: IntegrityWarning[];
}
export interface DetailsRequest extends ProjectSelection {
  slugs: string[];
  view?: DetailsView;
}
export interface DocumentDetails {
  entry: CatalogEntry;
  document: CurrentDocument;
  content: string;
  freshness: FreshnessSummary;
}
export interface DetailsResult {
  project: string;
  view: DetailsView;
  documents: DocumentDetails[];
  summary: FreshnessSummary;
  warnings?: IntegrityWarning[];
}
export interface WriteRequest extends ProjectSelection {
  [key: string]: unknown;
  slug: string;
  title: string;
  description: string;
  content: string;
  reason: string;
}
export interface EditOperation {
  oldText: string;
  newText: string;
}
export interface EditRequest extends ProjectSelection {
  [key: string]: unknown;
  slug: string;
  edits: EditOperation[];
  title?: string;
  description?: string;
  reason: string;
}
export interface MutationResult {
  project: string;
  entry: CatalogEntry;
  document: CurrentDocument;
}
export interface HistoryRequest extends ProjectSelection {
  slug: string;
  limit?: number;
  cursor?: string;
}
export interface HistoryResult {
  project: string;
  slug: string;
  entries: HistoryEntry[];
  nextCursor?: string;
  warnings?: IntegrityWarning[];
}
export interface RetireRequest extends ProjectSelection {
  slug: string;
  mode: RetireMode;
  reason: string;
  replacements?: string[];
}
export type PresenceState = "present" | "absent" | "unknown";
export interface RetireTargetState {
  document: PresenceState;
  catalogEntry: PresenceState;
}
export interface RetireOutcome {
  target: RetireTargetState;
}
export interface RetireResult {
  project: string;
  slug: string;
  mode: RetireMode;
  status?: LifecycleStatus;
  entry?: CatalogEntry;
  document?: CurrentDocument;
  removed?: boolean;
  replacements?: string[];
  outcome?: RetireOutcome;
}
export interface SourceReader {
  read(path: string): Promise<{
    bytes: Uint8Array;
    text: string;
  }>;
}
export interface PublicationHook {
  published(document: CurrentDocument, catalog: Catalog): Promise<void> | void;
}
export interface ExplorationMemoryService {
  catalog(request: CatalogRequest): Promise<CatalogResult>;
  details(request: DetailsRequest): Promise<DetailsResult>;
  write(request: WriteRequest): Promise<MutationResult>;
  edit(request: EditRequest): Promise<MutationResult>;
  history(request: HistoryRequest): Promise<HistoryResult>;
  retire(request: RetireRequest): Promise<RetireResult>;
}
