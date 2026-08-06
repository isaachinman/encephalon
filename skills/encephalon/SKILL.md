---
name: encephalon
description: Use when working in a Git repository that has Encephalon installed, especially before making repository assumptions or when a durable decision, architecture change, convention, incident, workflow, pull request, or material technical change may need long-term agent knowledge.
---

# Encephalon

Use Encephalon as the repository's durable, append-only memory. Query it before relying on assumptions; update it only when future agents would materially benefit.

## Start with active knowledge

Before planning or changing unfamiliar repository behaviour, search for the relevant subject:

```bash
npx --no-install encephalon search --compact "authentication deployment"
npx --no-install encephalon show --id "<relevant-id>" --active-only
```

Prefer compact search or one batched `gather` call before loading full records. Treat missing results as missing stored knowledge, not proof that a fact is false. Do not inspect or edit record JSON directly.

## Decide whether to record

Record only durable, high-signal knowledge:

- decisions and their rationale;
- architecture, boundaries, and conventions;
- repeatable development, release, or operational workflows;
- incidents with lasting diagnosis or prevention guidance;
- material technical or pull-request changes that reverse or invalidate prior knowledge;
- stable repository context that cannot be cheaply rediscovered.

Do not record routine edits, status updates, chat or log dumps, temporary debugging state, speculative ideas, source-code summaries, generated output, secrets, credentials, personal data, or local absolute paths.

## Preserve append-only history

Search the intended subject first. If active knowledge changes, add a replacement that supersedes every active head for the same `kind` and `subject`; never rewrite or delete the earlier record.

```bash
npx --no-install encephalon search --compact "api authentication strategy"
npx --no-install encephalon add \
  --kind decision \
  --subject api.authentication \
  --source agent \
  --supersedes "<active-id>" \
  --data '{"summary":"Use signed bearer tokens","rationale":["Supports non-browser clients"],"consequences":["Deploy token verification before clients"]}' \
  --text "authentication bearer token deployment"
npx --no-install encephalon validate
```

Use a recommended kind (`decision`, `architecture`, `convention`, `workflow`, `incident`, or `context`) when it fits. Keep subjects stable and payloads concise, structured, factual, and portable. Use `--artifact` only for an existing immutable supporting file beneath `_artifacts/<kind>/<id>/`; choose `--id` first when creating artifacts before their record.

Include new records and artifacts with the Git change that made them true. Do not stage, commit, push, or open a pull request automatically.

## Enrich an initial baseline

After `encephalon init`, read the active generated baseline and inspect the repository semantically. Add only durable facts the safe scanner could not derive, such as architectural boundaries, non-obvious conventions, and the reasons behind essential workflows. Do not restate manifests, script keys, filenames, or language counts already captured by the generated records.

## Finish

Run:

```bash
npx --no-install encephalon validate
```

Resolve validation failures before presenting the related change. Mention the added or superseded record IDs in the handoff so the user can review them with the code.
