---
name: spx
description: Spec-driven development with SPX. Use when creating or implementing a feature, refactor, or change that needs spec artifacts (proposal, spec deltas, design, tasks). Triggered by /spx:explore, /spx:propose, /spx:validate, /spx:apply, /spx:verify, /spx:archive, /spx:revert, /spx:unarchive, or any request to "spec out", "create a proposal", "investigate before building", "verify my changes", "revert a change", or "write a spec".
---
# SPX

Spec-driven development: explore → propose → validate → apply → verify → archive.

## Workflow (in order)

| # | Command | What happens |
|---|---|---|
| 1 | `/spx:explore [topic] [note]` | Read code, map architecture, compare options — no artifacts, read-only. Pass a topic to focus: `/spx:explore auth flow` |
| 2 | `/spx:propose <id> [note]` | Write proposal + specs + design + tasks. Add a tail note: `/spx:propose add-dark-mode prioritize a11y` |
| 3 | `/spx:validate [id] [note]` | Check artifact format BEFORE implementing — scenarios, headers, checkboxes |
| 4 | `/spx:apply [id] [note]` | Implement unchecked tasks in order, mark done in tasks.md |
| 5 | `/spx:verify [id] [note]` | Compare implementation against proposal + spec. Update proposal if scope drifted. |
| 6 | `/spx:archive [id] [note]` | Merge spec deltas into `.spx/specs/`, move change to archive/ |

**All commands accept an optional trailing note** after the ID/topic. The note is appended to the prompt: e.g., `/spx:apply add-dark-mode don't touch settings.py`.

**The change-level spec deltas (in `changes/<id>/specs/`) are the contract for this change.** They don't change during apply. They're only merged into the permanent source-of-truth at archive, once the change is verified and done.

**On brownfield codebases:** always `/spx:explore` before `/spx:propose`.

## Where am I? — suggesting the next step

When the user is mid-change, check the change state and suggest what's next:

| What exists | Next step |
|---|---|
| No artifacts | `/spx:explore` or `/spx:propose` |
| Artifacts exist, tasks unchecked | `/spx:validate` (format check), then `/spx:apply` |
| All tasks `[x]` | `/spx:verify` |
| Verify passed | `/spx:archive` |

**When the user asks for a non-trivial change without using a command:** suggest starting with `/spx:explore` or `/spx:propose`.

## Undo / fix commands

| Command | What happens |
|---|---|
| `/spx:revert [id]` | Abandon an active change — delete artifacts, then offer to undo source code |
| `/spx:unarchive [id]` | Move an archived change back to active |

## Directory structure

```
.spx/
├── project.md              # Project conventions (committed)
├── config.yaml             # Schema, context, rules (committed)
├── specs/                  # Current truth — what IS built (committed)
│   └── <capability>/
│       └── spec.md
└── changes/                # Ephemeral workspace (NOT committed)
    ├── <change-id>/        # One logical change
    │   ├── proposal.md
    │   ├── design.md       # Optional — skip for trivial changes
    │   ├── tasks.md
    │   └── specs/<capability>/spec.md   # Delta from current truth
    └── archive/            # Completed changes (optional to commit)
```

## Git rules

- `.spx/specs/` and `.spx/project.md` ARE committed — shared source of truth.
- `.spx/changes/<id>/` is NEVER committed — ephemeral workspace.
- Ensure `.gitignore` contains `.spx/`.

## Artifact formats

### proposal.md — Why + scope

```markdown
## Why
[Problem and motivation]

## What Changes
- [Concrete change 1]
- [Concrete change 2]

## Out of Scope
- [Explicit exclusion]

## Impact
- Affected files: `path/...`
- [Any new dependencies, migrations, risks]
```

### spec.md — Behavior contract (delta format)

Always use delta headers relative to current truth. Every requirement MUST have at least one `#### Scenario:` block.

```markdown
## ADDED Requirements

### Requirement: [Short name]
[The system SHALL ...]

#### Scenario: [Success case]
- **WHEN** [condition]
- **THEN** [expected outcome]

#### Scenario: [Edge case]
- **WHEN** [condition]
- **THEN** [expected outcome]

## MODIFIED Requirements

### Requirement: [Existing requirement name]
[Complete updated requirement text — not a diff]

#### Scenario: [Updated scenario]
- **WHEN** [condition]
- **THEN** [expected outcome]

## REMOVED Requirements

### Requirement: [Old requirement name]
**Reason**: [Why removing]
**Migration**: [How callers should adapt]
```

### design.md — Technical decisions

Use only when the change involves non-obvious choices: architecture boundaries, dependency selection, migration strategy, or security/performance trade-offs.

```markdown
## Decisions
- [Decision]: [Why this approach]

## Risks / Trade-offs
- [Risk]: [Mitigation]
```

### tasks.md — Execution checklist

Numbered sections. Every item is a `- [ ]` checkbox. Include verification steps.

```markdown
## 1. Implementation
- [ ] 1.1 [Concrete step with target file]
- [ ] 1.2 [Next step]

## 2. Validation
- [ ] 2.1 Run `npm run lint`
- [ ] 2.2 Run `npm run build`
- [ ] 2.3 Manual check: [specific behavior to verify]
```

## Archive — merging deltas into source-of-truth

On `/spx:archive`, the model moves the change to archive/ (creating the archive dir if needed) then merges each spec delta file into `.spx/specs/`:

```
For each .spx/changes/<id>/specs/<capability>/spec.md:

  1. If .spx/specs/<capability>/spec.md exists, read it.
     Otherwise this is a new capability — create the directory and write fresh.

  2. Apply ADDED requirements: append to end of the existing spec.

  3. Apply MODIFIED requirements: find the matching `### Requirement: [name]`
     block and replace its entire content (heading + body + scenarios).

  4. Apply REMOVED requirements: delete the matching `### Requirement: [name]`
     block. Preserve the Reason and Migration as a `> **Removed:** ...` note.

  5. Write the updated spec.md.
```

## Self-validation checklist

Before archiving, check every spec delta file:

- [ ] Every requirement has at least one `#### Scenario:` block
- [ ] Every scenario has `- **WHEN**` and `- **THEN**` (AND optional)
- [ ] Delta headers are exactly `## ADDED Requirements`, `## MODIFIED Requirements`, or `## REMOVED Requirements`
- [ ] MODIFIED requirements show the **full updated text**, not a diff
- [ ] REMOVED requirements have `**Reason**` and `**Migration**`
- [ ] design.md (if present) has `## Decisions` and `## Risks / Trade-offs`

## Hard rules

0. **Suggest the workflow.** When the user asks for a non-trivial change without using a /spx: command, suggest starting with `/spx:explore` or `/spx:propose`.
1. **Explore first on unfamiliar code.** Always `/spx:explore` before proposing on brownfield code.
2. **Proposal first.** Never start implementation before the proposal is approved.
3. **One change per proposal.** If it does two unrelated things, split it.
4. **Verb-led change IDs:** `add-`, `update-`, `remove-`, `refactor-`.
5. **Every requirement needs a Scenario.** No requirement without at least one `#### Scenario:` block.
6. **Validate before apply.** Run `/spx:validate` BEFORE `/spx:apply` — catch broken format before you spend time implementing.
7. **Verify after apply.** Run `/spx:verify` — compare implementation against proposal and spec. Update `proposal.md` if scope drifted during development.
8. **Archive after verify.** Run `/spx:archive` — merge spec deltas into `.spx/specs/`, move change to archive/.
9. **Check for conflicts.** Run `/spx:list` before creating a new change to see active changes and existing specs.
