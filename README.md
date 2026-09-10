<p align="center">
  <img src="./assets/encephalon.png" alt="Encephalon" width="240">
</p>

# Encephalon

Encephalon gives coding agents durable, repository-local knowledge. Small JSON records travel with your code in Git; a disposable SQLite full-text index makes them searchable through a CLI and synchronous JavaScript API.

Use it for decisions, architecture, conventions and repeatable workflows that would otherwise be lost between tasks. It has no accounts, hosted services, telemetry, embeddings, background daemon or runtime network access. It never runs Git commands for you.

## Install

This checkout documents unreleased work intended for 0.4.0. Registry installation currently gives the published release; development examples are verified against the exact packed candidate. The linked main-branch contract is development documentation.

Use Node.js **24.15.0 or later** on Linux, macOS or Windows. Install at the Git repository root, using a package-manager layout that exposes `node_modules/encephalon` there. Workspace-local or ephemeral installations and Yarn Plug'n'Play are unsupported. The installed package has zero runtime dependencies, no installation lifecycle scripts and no Bun requirement.

```bash
npm install --save-dev encephalon
npx --no-install encephalon init
```

`init` creates up to three baseline records, prepares the cache and adds a reversible managed block to root `AGENTS.md` and `CLAUDE.md`. The block directs agents to the installed skill. Commit the records and instruction changes with the project.

The baseline contains bounded package metadata, package-manager evidence, workspace patterns, script entry points, top-level layout and workflow filenames. It does not walk source directories or count languages or files. An agent can inspect the project and add useful context separately.

## Add and find knowledge

Run these examples from the initialised repository root. The explicit record ID makes the walkthrough reproducible; use a new ID or omit `--id` when recording your own knowledge.

```bash
npx --no-install encephalon add --id auth-tokens --kind decision --subject api.authentication --source agent --data '{"summary":"Use signed bearer tokens","rationale":["Support non-browser clients"]}' --text 'authentication tokens'
npx --no-install encephalon search --compact 'authentication tokens'
npx --no-install encephalon show --id auth-tokens --active-only
npx --no-install encephalon list --kind decision
npx --no-install encephalon gather --search authentication --search tokens --show auth-tokens
```

Start with compact search, then inspect a record with `show`. Search is literal Unicode text: terms are combined with AND, and punctuation cannot introduce query operators. Payload and `searchText` content remain searchable. Snippets come from a bounded metadata/summary preview; matches elsewhere use a stable fallback. Full `search` returns complete records.

`gather` batches searches and shows while preserving their order and duplicate occurrences. Duplicate results remain independent mutable values. Reads prepare the disposable cache automatically when needed. Missing `show` results are `null`; empty searches return `[]`.

Search the subject before adding a replacement. A replacement must supersede **every active head with the same kind and subject**:

```bash
npx --no-install encephalon add --id auth-tokens-v2 --kind decision --subject api.authentication --source agent --supersedes auth-tokens --data '{"summary":"Use short-lived signed bearer tokens"}' --text 'authentication tokens'
npx --no-install encephalon search --compact --include-superseded authentication
```

Recommended kinds are `decision`, `architecture`, `convention`, `workflow`, `incident` and `context`. Existing records are append-only: preserve their bytes and represent changed knowledge with a new record.

## Storage and Git

```text
encephalon/
  <kind>/<id>.json
  _artifacts/<kind>/<id>/...
```

Commit canonical records and referenced artifacts. Keep the disposable cache at `node_modules/.cache/encephalon/` out of Git. To attach an immutable supporting file, choose the record ID first, place the file under its matching `_artifacts/<kind>/<id>/` directory, then pass the brain-relative path with `add --artifact`. Encephalon validates the file; it does not copy arbitrary source files into the archive.

After merging knowledge from another branch, run `validate`. If multiple active heads conflict, add a resolving record that supersedes them all. Never delete history to repair a conflict.

## Limits

- List and search return 20 results by default; `--limit` accepts **1–1,000**.
- One gather accepts **16 searches and 64 shows**.
- Search input accepts **1,024 UTF-8 bytes and 32 literal terms**.
- A canonical corpus accepts **1,000 records and 8 MiB of record JSON**, with at most **1 MiB per record**.
- Full, compact and complete gather responses each have an independent **4 MiB** budget. Duplicates count on every occurrence. Oversized results fail instead of being silently truncated.

Use narrower queries, compact search or smaller limits when a response exceeds its budget. The [Public contract](https://github.com/isaachinman/encephalon/blob/main/docs/contract.md) defines all field, payload, corpus, path and response limits and their accounting rules.

## Validate and recover

```bash
npx --no-install encephalon validate
npx --no-install encephalon prepare
npx --no-install encephalon hydrate
```

`validate` checks canonical records, supersession and referenced artifacts without trusting the cache. `prepare` reuses a valid fresh cache or rebuilds it; `hydrate` forces a rebuild. Recoverable cache corruption or an obsolete cache format normally rebuilds automatically. A foreign-repository cache or unsafe filesystem layout fails closed.

For canonical validation failures, inspect the reported records or artifacts and reconcile the cause before rebuilding. For an unsafe cache layout, correct links, permissions or unexpected file types, then restart the process and retry. Do not blindly remove cache files while another process is using the repository; cache recovery never justifies deleting canonical records or artifacts.

Initialisation can commit some records or instruction changes before another step fails. Follow `details.initProgress.recoveryAction`: inspect committed work when requested, run `prepare` and `validate` after a cache failure, then repeat the **same init options**. If an add error reports `canonicalCommitted: true`, inspect its `recordId` and validate; do not blindly add it again. Only reported recovery paths are identified as belonging to that failed operation. See the contract for commit and recovery guarantees.

Refresh generated facts after changing package tooling or top-level layout:

```bash
npx --no-install encephalon init --refresh-baseline
```

Refresh appends changed generated records and supersedes their old heads. Unchanged facts add nothing; older records remain readable. To remove only the managed instruction blocks:

```bash
npx --no-install encephalon init --remove
```

Removal preserves canonical records, artifacts, cache and the installed package. Existing instruction files must be regular non-symlink files containing valid UTF-8 without NUL bytes, at most 1 MiB each. Unrelated instruction bytes are preserved.

## Synchronous API

```javascript
import { searchCompactRecords } from 'encephalon';

const decisions = searchCompactRecords({
  root: process.cwd(),
  kind: 'decision',
  query: 'authentication',
});
console.log(decisions);
```

The root package exports `initEncephalon`, `addRecord`, `prepare`, `hydrate`, `validateRecords`, `listRecords`, `showRecord`, `searchRecords`, `searchCompactRecords`, `gatherRecords`, `EncephalonError` and their public TypeScript types. Importing it does not discover a repository, touch the filesystem or open SQLite. Calls return values and never print or exit; expected failures throw `EncephalonError` with a stable `code` and bounded `details`.

An explicit `root` is exact. Without it, calls discover the nearest Git repository from the current directory. The executing package must match the root installation. See the public contract for complete inputs, result shapes, ordering, CLI flags and errors.

## Privacy and compatibility

Encephalon stores only the knowledge you add and the bounded baseline described above. Initialisation does not semantically inspect source bodies, README content, environment files, registry configuration, Git history, Git remotes or workflow contents. It reads `AGENTS.md` and `CLAUDE.md` only to manage its block; unrelated instruction text is not stored, indexed or printed.

Anything you deliberately put in records or artifacts can travel with Git. Keep secrets, credentials, personal data and temporary logs out of them. Encephalon is not an encryption or access-control system.

The upcoming lean runtime retains valid 0.3 canonical records, artifacts and managed instructions. Generated baselines no longer include source-file inventories, and compact snippets/ranking may differ while payload terms remain searchable. Disposable caches rebuild when incompatible.

## Contributing

Build and test Encephalon with Bun; runtime consumers use Node. The repository's [contributor checks and performance guide](https://github.com/isaachinman/encephalon/blob/main/docs/performance.md#contributor-checks) lists local commands, CI selection, exact-candidate handling and the manual publication boundary.

The [Public contract](https://github.com/isaachinman/encephalon/blob/main/docs/contract.md) is the normative behaviour reference. The [Changelog](https://github.com/isaachinman/encephalon/blob/main/CHANGELOG.md) preserves release history. Historical designs and old benchmark reports are retained as immutable Encephalon artifacts, not current requirements.

## Licence

MIT
