import type { RetireOutcome } from "./contracts.ts";
export type DomainErrorCategory = "invalid_input" | "unsupported_schema" | "not_found" | "invalid_reference" | "source_unavailable" | "malformed_state" | "incomplete_or_inconsistent_state" | "persistence" | "conflict";
export class ExplorationMemoryError extends Error {
  readonly category: DomainErrorCategory;
  readonly details?: RetireOutcome | undefined;
  constructor(category: DomainErrorCategory, message: string, options?: ErrorOptions & {
    details?: RetireOutcome | undefined;
  }) {
    super(message, options);
    this.name = "ExplorationMemoryError";
    this.category = category;
    this.details = options?.details;
  }
}
export const invalidInput = (message: string) => new ExplorationMemoryError("invalid_input", message);
export const notFound = (message: string) => new ExplorationMemoryError("not_found", message);
