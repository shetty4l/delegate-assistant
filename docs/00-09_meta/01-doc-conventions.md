# Documentation Conventions

## Purpose
Keep documentation easy to navigate, stable to reference, and simple to evolve.

## Johnny Decimal Structure
- Use bucket folders in tens: `00-09`, `10-19`, `20-29`, `30-39`.
- Use file prefixes matching the bucket, for example:
  - `docs/10-19_product/10-v0-requirements.md`
  - `docs/30-39_execution/31-v0-implementation-blueprint.md`
- Prefer one primary concept per file.

## Status Tags
Use a short status line near the top of each doc:
- `Status: active` - current source of truth.
- `Status: draft` - work in progress, not yet authoritative.
- `Status: superseded by <path>` - replaced by another doc.

## Naming Rules
- Keep names short and descriptive.
- Use lowercase kebab-case after the numeric prefix.
- Avoid version suffixes in filenames unless multiple versions must coexist.

## Change Log Rules
- For active execution docs, keep a lightweight "Progress Log" section with dated entries.
- Capture only: completed work, decisions, files touched, blockers.
- Keep entries concise and factual.

## Adding New Docs
1. Pick the correct bucket by topic.
2. Choose the next available number in that bucket.
3. Add the file to `docs/00-09_meta/00-index.md`.
4. If replacing an existing doc, mark old file `superseded` and add a forward link.
