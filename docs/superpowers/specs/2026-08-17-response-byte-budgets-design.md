# Response Byte Budgets Design

## Goal

Bound compact-search and complete gather responses to 4 MiB before unbounded JavaScript materialisation, while preserving public result types, ordering, ranking, cache snapshot semantics, and existing full-record response behaviour.

## Accounting authority

`src/operation-budgets.ts` remains the dependency-free authority for the fixed maximum and exposes three internal response-budget entries: `fullResponseBytes`, `compactResponseBytes`, and `gatherResponseBytes`. Each uses `field: 'response'` and `maximum: 4 * 1024 * 1024`.

`src/response-budget.ts` owns deterministic logical response accounting. It counts:

- every string value by `Buffer.byteLength(value, 'utf8')`;
- every object key by its UTF-8 byte length;
- every number, boolean, null, array, and object with a fixed eight-byte semantic-node allowance;
- every nested value recursively.

This model deliberately does not use `JSON.stringify`: whitespace, escaping, and property insertion order are transport details rather than API-budget authority. Reordered objects therefore have the same cost. The response values are already schema-validated and JSON-compatible; an unsupported internal value is an `INTERNAL_ERROR`.

One mutable ledger is contained within each database read attempt. Charging a complete fragment either returns the fragment for composition or fails with `INVALID_ARGUMENT` and the existing bounded details `{ field, budget, maximum }`. The stable response-budget keys are `fullResponseBytes`, `compactResponseBytes`, and `gatherResponseBytes`; all use `field: 'response'`. A total equal to the maximum succeeds; the first fragment that would make the total larger fails before it is retained.

The helper also centralises raw-byte charging for existing full-record readers. Their accounting remains the exact cached canonical JSON byte count, so this refactor does not change list, show, or full-search limits.

## Compact search

The compact reader receives a response ledger. It charges the result-array container once, prepares one statement, and consumes `statement.iterate(...)` inside the existing read transaction. Every row is first converted through the existing compact cache validators, then charged, then retained. Cache corruption therefore remains disposable-cache recovery rather than being misclassified as a caller budget error.

A standalone compact search creates a fresh `compactResponseBytes` ledger inside the `withPreparedDatabase` callback. A discarded cache generation and retry cannot leak earlier charges into the successful attempt. The existing post-read hook runs only after the iterator has been consumed successfully.

## Gather

`readGatherFromDatabase` creates one `gatherResponseBytes` ledger for the complete result. It first charges the root result skeleton containing `hydrated`, `records`, and `searches`. Each requested show then charges its `{ id, record }` envelope and returned full record or null. Each requested search charges its `{ kind, query, results: [] }` envelope, after which the compact reader charges the results array and every compact record against the same ledger.

Repeated show IDs and repeated queries are charged on every occurrence. Shows remain evaluated before searches, request order and result shapes remain unchanged, and all reads and accounting stay inside one SQLite transaction snapshot. There is no truncation or partial response.

## Component boundaries

- `src/operation-budgets.ts` owns immutable numeric limits and stable budget names.
- `src/response-budget.ts` owns logical-value and raw-byte accounting plus bounded budget failure.
- `src/cache.ts` owns SQLite iteration, cache-row validation, and composition of public read results.
- `src/errors.ts` retains the stable public error projection.

No public type, `src/index.ts` export, package dependency, CLI option, ranking rule, or cache schema changes.

## Verification

The minimal behavioural matrix covers:

- pure logical accounting for ASCII, multibyte strings, object keys, reordered objects, every fixed-cost node, exact 4 MiB, and one byte over for both new budget keys;
- compact search at the exact logical boundary and one byte over, with a throwing `.all()` sentinel proving lazy iteration;
- one gather whose repeated shows and repeated compact searches are individually safe but exactly fill the shared response budget, followed by a one-byte-over request;
- the existing full-record response limit, compact shapes, ordering, ranking, duplicate order, statement reuse, and one-snapshot gather regressions.

The complete lint, four-project typecheck, full test, benchmark, build, package, publish-contract, frozen-install, declaration, Bun configuration, diff, and documentation-provenance gates remain required.

## Scope exclusions

Pagination, silent truncation, query/result-count budgets, CLI transport newlines, JSON serialization formatting, ranking changes, and configurable response ceilings remain out of scope.

## Reviewed implementation provenance

The exact reviewed code and behavioural-test snapshot implementing this design is `71cec5b639c89dd328087546e3053cd72847e1d5`. Documentation changes do not alter the runtime API, package exports, cache schema, or generated declarations.
