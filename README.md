<p align="center">
  <img src="./assets/encephalon.png" alt="Encephalon" width="240">
</p>

# Encephalon

Encephalon gives coding agents durable, repository-local knowledge. Canonical records are small, structured JSON files that travel with the code; a disposable SQLite full-text index makes them quick to query through the CLI or synchronous API.

Encephalon is general-purpose. It does not include hosted services, accounts, telemetry, network access, automatic Git operations, embeddings, daemons, or project records.

## Requirements

- Node.js 24.15.0 or later
- A Git repository using a package-manager layout that exposes `node_modules/encephalon` at the repository root

Bun is used to build and test Encephalon itself. Installed projects run the bundled ESM distribution with Node and do not need Bun. The package has zero runtime dependencies and no installation lifecycle scripts.

Yarn Plug'n'Play is not supported in v0.1.0.

## Install

Install Encephalon at the root of the Git repository:

```bash
npm install --save-dev encephalon
npx --no-install encephalon init
```

`init` safely scans derived repository metadata, creates up to three baseline records, builds the local cache, and adds a reversible managed block to root `AGENTS.md` and `CLAUDE.md`. It never reads source bodies, instruction-file text, README content, environment files, registry configuration, Git history, Git remotes, or CI workflow contents.

The result includes a `nextAction` asking an agent to read the installed skill and optionally enrich the baseline semantically.

Refresh derived facts after meaningful tooling or layout changes:

```bash
npx --no-install encephalon init --refresh-baseline
```

Remove only the managed instruction blocks:

```bash
npx --no-install encephalon init --remove
```

Removal does not delete records, artifacts, the cache, or the package.

## Query knowledge

Compact search is the quickest exploration path:

```bash
npx --no-install encephalon search --compact "authentication deployment"
npx --no-install encephalon show --id "<record-id>" --active-only
```

Batch searches and record reads while preserving caller order:

```bash
npx --no-install encephalon gather \
  --search "authentication architecture" \
  --search "deployment workflow" \
  --show "<record-id>"
```

Every `list`, `show`, `search`, and `gather` call prepares the cache automatically. `prepare` rebuilds only when canonical inputs changed; `hydrate` forces a transactional rebuild.

```bash
npx --no-install encephalon list --kind decision
npx --no-install encephalon prepare
npx --no-install encephalon validate
```

Active records are returned by default. Add `--include-superseded` to `list`, `search`, or `gather` when historical records are needed. Missing `show` results are `null`, and empty searches are `[]`.

## Add durable knowledge

Search the stable subject first. If the new record replaces active knowledge, repeat `--supersedes` for every active head:

```bash
npx --no-install encephalon add \
  --kind decision \
  --subject api.authentication \
  --source agent \
  --supersedes "<active-record-id>" \
  --data '{"summary":"Use signed bearer tokens","rationale":["Supports non-browser clients"]}' \
  --text "authentication bearer tokens"
```

Recommended kinds are `decision`, `architecture`, `convention`, `workflow`, `incident`, and `context`. Other kinds may use lowercase letters, digits, underscores, and hyphens. Leading underscores are reserved.

Encephalon is append-only: changes are represented by a replacement record, not by editing or deleting an earlier record. A replacement must supersede every active head with the same kind and subject.

## Storage

The consuming repository's durable data has one top-level directory:

```text
encephalon/
  <kind>/<id>.json
  _artifacts/<kind>/<id>/...
```

The runtime-only `path` field is not written to record files. Optional fields are omitted rather than written as `null`.

```ts
type BrainRecordFile = {
  id: string;
  kind: string;
  subject: string;
  source: string;
  createdAt: string;
  confidence?: number;
  supersedes?: string[];
  artifacts?: string[];
  payload: JsonValue;
  searchText?: string;
};

type BrainRecord = BrainRecordFile & { path: string };
```

The v0.x canonical corpus may contain at most 1,000 records, 8 MiB of aggregate record JSON, 1,000 supersession edges, and 1,000 artifact references. Validation returns at most 100 issues; when more issues exist, the result sets `truncated: true` and ends with a `VALIDATION_ISSUES_TRUNCATED` sentinel.

The disposable cache lives at `node_modules/.cache/encephalon/brain.sqlite` and should not be committed. It uses SQLite WAL mode, FTS5, a repository-scoped operation lock, manifest-based freshness, and transactional table rebuilds. Canonical records remain the source of truth.

Artifacts must be regular, non-symlink files beneath `_artifacts/<kind>/<id>/`. Record IDs and artifact paths are checked for traversal, platform portability, Windows-reserved names, case collisions, size limits, and containment.

## Synchronous API

Importing the package does not discover a repository, touch the filesystem, or open SQLite.

```ts
import {
  addRecord,
  gatherRecords,
  initEncephalon,
  listRecords,
  prepare,
  searchCompactRecords,
  showRecord,
  validateRecords,
} from "encephalon";

const decisions = searchCompactRecords({
  root: process.cwd(),
  kind: "decision",
  query: "authentication",
});
```

The package exports `initEncephalon`, `addRecord`, `prepare`, `hydrate`, `validateRecords`, `listRecords`, `showRecord`, `searchRecords`, `searchCompactRecords`, `gatherRecords`, their input/result types, record types, and `EncephalonError`.

API calls return values and never print or exit. Expected failures throw `EncephalonError` with one of these stable codes:

```text
UNSUPPORTED_RUNTIME
REPOSITORY_NOT_FOUND
INVALID_REPOSITORY
ROOT_INSTALL_REQUIRED
INVALID_ARGUMENT
VALIDATION_FAILED
RECORD_EXISTS
CACHE_BUSY
CACHE_SCOPE_MISMATCH
REPOSITORY_CHANGED
IO_ERROR
INTERNAL_ERROR
```

Without `root`, Encephalon walks upward to the nearest valid Git repository marker. With `root`, that canonical path is exact and no upward search occurs. Commands also verify that the executing package is the installation exposed at the repository root, rejecting ephemeral execution and workspace-local installations.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun run check:package
bun run check:publish
```

`check:package` inspects the npm tarball, installs it with lifecycle scripts disabled, imports the public API, and runs the bundled CLI using Node. `check:publish` exercises npm's publish-time manifest normalisation without uploading anything.

## Licence

MIT
