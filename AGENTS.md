# nano-team

A `pi.dev` extension that lets the main `pi` agent spawn a roster of pre-defined subagents.

## Idea

The smallest possible agent-team extension that's still useful. Three tools, one widget, one YAML schema — nothing more.

## Goal

Every line of code, every token in the system prompt, every dependency is on a budget. The less code, the better. Refuse abstractions that don't pay for themselves.

## Stack

- TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`)
- jiti — extension loads as `.ts` source, no build step
- Deps: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, `typebox`, `yaml`. Nothing else.

## Standards

- No `any`. Prefer `unknown` and narrow.
- Functional by default: pure functions, immutable data (`Readonly<>` / `readonly`), closures over classes. Deviate only when it would significantly violate performance.
- Self-explanatory names. No abbreviations.
- No comments unless the WHY is non-obvious. Never narrate WHAT.
- Validate at system boundaries only. Trust internal code.
- Edit existing files; don't add new ones unless required.
