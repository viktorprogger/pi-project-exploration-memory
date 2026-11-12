# Prompt macro reference

`[[pem:<slug>]]` is an extension-supported prompt reference. Slugs are lowercase ASCII: `[a-z0-9][a-z0-9_-]{0,127}`. A single backslash escapes a macro. Macros are protected in ordinary inline code and fenced Markdown. Inline code requires a matching backtick run of the same length. Macros expand once in source order, and repeated slugs are retrieved once in first-occurrence order.

Expansion applies only to interactive and RPC input, uses the input event's `ctx.cwd`, preserves retrieval parity (content, source/freshness occurrences, integrity warnings, and newest-five history reasons), preserves images, and has a 64 KiB UTF-8 transformed-input limit. Malformed syntax, retrieval/rendering errors, or overflow fail closed. The extension remains provider-free; the six public tools include `project_memory_retire`, while macro behavior remains unchanged.

This is reference material for documentation and prompt construction, not a request to change macro runtime behavior.

## Delegation compatibility

The runner constructs the child prompt without expanding PEM macros itself. A child may receive and expand real, unprotected `[[pem:slug]]` macros only when its PEM extension is actually loaded, its chosen input source supports the input hook, the correct project/worktree context is present, and expansion stays within limits. The current explorer configuration can meet this route; extension-disabled implementer/verifier sessions cannot. Unsupported or unverified child routes must receive the equivalent full expanded-details snapshot: project/worktree identity, selected content and generated source evidence, truthful status/freshness/integrity, unknowns, and newest-five history reasons. Never substitute a guessed slug, bare macro, or context reference. The 64 KiB transformed-input limit applies to macro expansion, not explicit snapshots; narrow or split assignments when launcher/context limits require it.
