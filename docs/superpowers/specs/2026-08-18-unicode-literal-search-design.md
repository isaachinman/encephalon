# Unicode Literal Search Design

**Ticket:** MAR-2559
**Date:** 2026-08-18
**Status:** Implemented

## Goal

Preserve Unicode search terms when Encephalon converts user text into an FTS5 `MATCH` expression, while retaining literal-only injection safety, existing request budgets, and current result ordering.

## Existing guarantees

- Search input is public text, never raw FTS5 syntax.
- Each accepted term is double-quoted and combined with `AND`.
- A query contains at most 1,024 original UTF-8 bytes and 32 literal terms.
- Full and compact search validate the query before repository/cache work; gather validates every query before repository resolution.
- SQLite FTS5 uses its built-in `unicode61` tokenizer and the existing rank/order rules.

## Design

One internal search-text module owns shared NFC normalization, query validation, tokenization, and FTS expression construction.

1. Require a string and enforce the existing 1,024-byte budget against the original UTF-8 input. Normalization cannot make an oversized request admissible.
2. Normalize the accepted input to Unicode NFC.
3. Extract terms that begin with a Unicode letter or number and continue with Unicode letters, numbers, or combining marks. Preserve one or more underscores only when they join such text, retaining the established ASCII `snake_case` adjacency behaviour while treating underscore-only input as punctuation.
4. Ignore isolated or leading combining marks, punctuation, symbols, controls, and isolated underscores. Combining marks that follow a letter or number remain part of that term. Rejected characters cannot enter FTS syntax.
5. Enforce the existing 32-term budget after normalized tokenization.
6. Double-quote each complete term, escape a quote defensively, preserve duplicates and input order, and join terms with `AND`.

The derived search document is also normalized to NFC before cache insertion and exact FTS-text integrity comparison. This makes canonically equivalent query and indexed text deterministic without changing canonical record bytes. An older cache containing the prior derived bytes fails the existing semantic cache check and follows the existing exact-generation quarantine, one-rebuild, one-retry path.

The bounded FTS projection combines the existing twofold allowance for duplicated searchable fields with NFC's maximum threefold UTF-8 expansion. The resulting sixfold derived-cache ceilings are 6,316,032 bytes per row and 74,907,648 bytes in aggregate; canonical record and corpus budgets remain unchanged.

The produced query remains input to FTS5's own `unicode61` tokenizer. A quoted term may therefore contain more than one adjacent FTS token for scripts that use combining marks or for underscore-joined ASCII text, but users cannot author raw phrase grammar and operators, wildcards, quotes, punctuation, and controls never become syntax.

## Search orchestration

- Full search computes the literal expression before opening the prepared cache read.
- Compact search performs the same pre-I/O validation and passes the computed expression into its prepared statement reader.
- Gather computes every expression once before repository resolution and passes those expressions into its shared prepared statement reader.
- Standalone full/compact searches with zero normalized terms return `[]` after required repository discovery and root-installation validation but before cache inspection or SQLite access.
- A gather containing only zero-term searches, no shows, and no hydration request returns its empty search envelopes after required repository/root-installation validation but before cache work. Mixed gathers still perform requested shows, hydration, and non-empty searches while skipping `MATCH` execution for each empty query.

No result shape, response budget, limit, supersession, cache-recovery, or error-code behaviour changes. Existing BM25 ordering, tie-breakers, and snippet construction remain unchanged; newly matched or NFC-normalized Unicode text can necessarily change affected result membership, rank values, and snippet code-point bytes.

## Compatibility boundaries

- NFC on both the derived search document and query makes canonically equivalent composed and decomposed text deterministic. FTS5 remains responsible for case folding and its default diacritic behaviour.
- Existing ASCII words, numbers, repeated terms, and underscore-joined phrases retain their literal semantics.
- No NFKC compatibility folding, transliteration, stemming, locale-specific segmentation, fuzzy matching, user-authored phrase API, raw FTS syntax, ICU dependency, or schema migration is introduced.
- CJK text follows the existing `unicode61` token boundary rather than adding language-specific segmentation.

## Acceptance coverage

- A pure parser table covers accented Latin, Greek, Cyrillic, Arabic, Hebrew, CJK, combining-mark scripts, composed/decomposed input, underscore compatibility, duplicates, operators, wildcards, quotes, punctuation, controls, and empty normalized output.
- One integration fixture proves Unicode matches through full search, compact search, and gather without changing ASCII ordering or snippets.
- One public fast-path test proves punctuation/control-only input retains repository/root-installation validation while returning empty results before cache hooks.
- One public add, prepare, list, and search regression proves a valid record using NFC's threefold UTF-8 expansion remains readable after cache rebuilding.
- Packed CLI validation proves a Unicode query reaches the same public search path.
- Existing exact byte/term budget tests remain the budget authority and are not duplicated.

## Reviewed implementation provenance

The exact implementation and behavioural-test snapshot is `3b468b264e227ec1cd9cdd6913b036368a13c076`. Documentation does not change the public API, package exports, cache schema, canonical record format, or operation budgets.
