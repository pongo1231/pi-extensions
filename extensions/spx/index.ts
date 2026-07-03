/**
 * SPX Extension for pi (self-contained, no CLI dependency)
 *
 * Spec-driven development: explore → propose → validate → apply → verify → archive.
 *
 * Commands:
 *   /spx:explore    — Investigate the codebase before proposing (read-only thinking)
 *   /spx:propose    — Create a change with planning artifacts
 *   /spx:validate   — Check artifact format BEFORE implementing
 *   /spx:apply      — Implement unchecked tasks from a change
 *   /spx:verify     — Compare implementation against proposal + spec, resolve drift
 *   /spx:archive    — Merge spec deltas into source-of-truth, archive change
 *   /spx:revert     — Abandon an active change (delete artifacts, undo code)
 *   /spx:unarchive  — Move an archived change back to active
 *   /spx:list       — Show active changes with task progress and existing specs
 *
 * Every command accepts an optional trailing note: /spx:propose add-foo focus on auth
 *
 * Lazy bootstrap: first command auto-creates .spx/ directories if missing.
 *
 * Defense:
 *   Warns on `git add` of .spx/changes/ files (ephemeral workspace).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROOT = ".spx";
const CHANGES_DIR = `${ROOT}/changes`;
const SPECS_DIR = `${ROOT}/specs`;
const CONFIG_PATH = `${ROOT}/config.yaml`;
const PROJECT_PATH = `${ROOT}/project.md`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escaped version of ROOT for use in regex patterns. */
const ROOT_RE = ROOT.replace(/\./g, "\\.");

// Cached list of active changes (refreshed on session_start + agent_end).
let cachedChanges: string[] = [];

/** Split raw args into primary arg and optional trailing note. */
function splitArgs(raw: string): { first: string; note?: string } {
  const trimmed = raw.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1 || !trimmed) return { first: trimmed };
  return {
    first: trimmed.slice(0, spaceIdx),
    note: trimmed.slice(spaceIdx + 1).trim() || undefined,
  };
}

/** Bootstrap the .spx directory tree if it doesn't exist. */
async function bootstrap(pi: ExtensionAPI): Promise<void> {
  try {
    const { stdout } = await pi.exec("bash", [
      "-c",
      `test -d ${ROOT} && echo "ok"`,
    ]);
    if (stdout.trim() === "ok") return;
  } catch {
    // doesn't exist
  }

  await pi.exec("mkdir", ["-p", CHANGES_DIR, SPECS_DIR]);

  // Write config.yaml if missing
  try {
    const { stdout } = await pi.exec("bash", [
      "-c",
      `test -f ${CONFIG_PATH} && echo "ok"`,
    ]);
    if (stdout.trim() !== "ok") {
      await pi.exec("bash", [
        "-c",
        `cat > ${CONFIG_PATH} << 'EOF'
schema: spec-driven
context: |
  Project conventions and patterns go here.
  The model reads this on every change.
EOF`,
      ]);
    }
  } catch {
    // proceed
  }

  // Write project.md if missing
  try {
    const { stdout } = await pi.exec("bash", [
      "-c",
      `test -f ${PROJECT_PATH} && echo "ok"`,
    ]);
    if (stdout.trim() !== "ok") {
      await pi.exec("bash", [
        "-c",
        `cat > ${PROJECT_PATH} << 'EOF'
# Project Conventions

[Describe your project's tech stack, patterns, naming conventions,
and architecture decisions here. The model reads this on every change.]
EOF`,
      ]);
    }
  } catch {
    // proceed
  }
}

/** Ensure a line exists as an anchored entry in .gitignore. */
async function ensureGitignore(pi: ExtensionAPI, line: string): Promise<boolean> {
  try {
    const { stdout } = await pi.exec("bash", [
      "-c",
      `grep -qxF "${line}" .gitignore 2>/dev/null && echo "present" || echo "missing"`,
    ]);
    return stdout.trim() === "present";
  } catch {
    return false;
  }
}

/** Append a line to .gitignore with a leading newline. */
async function appendGitignore(pi: ExtensionAPI, line: string): Promise<void> {
  await pi.exec("bash", ["-c", `printf '\\n%s\\n' '${line}' >> .gitignore`]);
}

/** List active change names from the filesystem. */
async function activeChanges(pi: ExtensionAPI): Promise<string[]> {
  try {
    const { stdout } = await pi.exec("bash", [
      "-c",
      `ls -d ${CHANGES_DIR}/*/ 2>/dev/null | grep -v '/archive/' | xargs -n1 basename`,
    ]);
    return stdout
      .trim()
      .split("\n")
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/** List spec directories. */
async function listSpecs(pi: ExtensionAPI): Promise<string[]> {
  try {
    const { stdout } = await pi.exec("bash", [
      "-c",
      `find ${SPECS_DIR} -name "spec.md" 2>/dev/null`,
    ]);
    return stdout
      .trim()
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => s.replace(`${SPECS_DIR}/`, "").replace("/spec.md", ""));
  } catch {
    return [];
  }
}

/** Count completed and total tasks in a change's tasks.md. */
async function taskStatus(
  pi: ExtensionAPI,
  changeId: string,
): Promise<{ done: number; total: number } | null> {
  try {
    const { stdout } = await pi.exec("bash", [
      "-c",
      `cat ${CHANGES_DIR}/${changeId}/tasks.md 2>/dev/null`,
    ]);
    const total = (stdout.match(/^[-*]\s*\[.\]/gm) || []).length;
    const done = (stdout.match(/^[-*]\s*\[[xX]\]/gm) || []).length;
    if (total === 0) return null;
    return { done, total };
  } catch {
    return null;
  }
}

/** List archived change names from the filesystem. */
async function archivedChanges(pi: ExtensionAPI): Promise<string[]> {
  try {
    const { stdout } = await pi.exec("bash", [
      "-c",
      `ls -d ${CHANGES_DIR}/archive/*/ 2>/dev/null | xargs -n1 basename`,
    ]);
    return stdout
      .trim()
      .split("\n")
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/** Generate today's date as YYYY-MM-DD. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

function msgExplore(topic?: string): string {
  const header = topic
    ? `## SPX: Explore \`${topic}\`\n`
    : "## SPX: Explore\n";
  const focus = topic ? `Focus area: ${topic}.\n` : "";
  return (
    header +
    "\n" +
    focus +
    "You are in exploration mode. Your job is to investigate, not to build.\n" +
    "\n" +
    "**Do this:**\n" +
    "- Read source files to map the area the user wants to change\n" +
    "- Trace how data flows through relevant modules\n" +
    "- Identify existing patterns, abstractions, and extension points\n" +
    "- Surface constraints: dependencies, performance, coupling\n" +
    "- Compare approaches and name the tradeoffs of each\n" +
    "- Ask clarifying questions when requirements are fuzzy\n" +
    "- Narrow a vague idea into a concrete, buildable scope\n" +
    "\n" +
    "**Do NOT:**\n" +
    "- Create any files or modify code\n" +
    "- Write SPX artifacts (proposal, spec, design, tasks)\n" +
    "- Jump to a solution before understanding the problem\n" +
    "\n" +
    "**Output:** a summary of what you found — current architecture,\n" +
    "options ranked with tradeoffs, recommended approach,\n" +
    "and what's in/out of scope.\n" +
    "\n" +
    "When the picture is clear, tell the user they're ready for\n" +
    "`/spx:propose <change-id>`."
  );
}

function msgPropose(changeId: string, note?: string): string {
  return (
    `## SPX: Propose \`${changeId}\`\n` +
    "\n" +
    "Load the **spx skill** then follow these steps:\n" +
    "\n" +
    `1. Read \`${PROJECT_PATH}\` for project conventions\n` +
    `2. List existing specs (run: ls ${SPECS_DIR}/) to understand current capabilities\n` +
    `3. Write \`${CHANGES_DIR}/${changeId}/proposal.md\` — Why, What Changes, Out of Scope, Impact\n` +
    `4. Write \`${CHANGES_DIR}/${changeId}/specs/<capability>/spec.md\` — delta-formatted spec with ADDED/MODIFIED/REMOVED requirements and WHEN/THEN scenarios\n` +
    "5. Write `design.md` if the change involves non-obvious technical decisions (otherwise skip)\n" +
    `6. Write \`${CHANGES_DIR}/${changeId}/tasks.md\` — numbered checklist with implementation + validation steps\n` +
    "\n" +
    "Use the exact artifact formats from the skill.\n" +
    "Every requirement MUST have at least one Scenario block.\n" +
    "\n" +
    "After writing all files, self-check: does every requirement have\n" +
    "at least one `#### Scenario:` block? Are all delta headers correct?\n" +
    "\n" +
    "**Then stop.** Report what you created and ask the user to review.\n" +
    "Do NOT start implementing until the user explicitly approves." +
    (note ? `\n\n---\nUser note: ${note}` : "")
  );
}

function msgApply(changeId: string, tasksPath: string, proposalPath: string, note?: string): string {
  return (
    `## SPX: Apply \`${changeId}\`\n` +
    "\n" +
    "Load the **spx skill**, then:\n" +
    "\n" +
    `1. Read \`${proposalPath}\` — understand scope and intent\n` +
    `2. Read \`${tasksPath}\` — this is the implementation checklist\n` +
    "3. Implement every unchecked task (`- [ ]`) in order\n" +
    "4. After completing each task, mark it `- [x]` in tasks.md\n" +
    "5. After all implementation tasks, run the validation steps from tasks.md\n" +
    "\n" +
    "Do NOT change behavior beyond what the proposal and spec define.\n" +
    "If a task is ambiguous, ask before implementing." +
    (note ? `\n\n---\nUser note: ${note}` : "")
  );
}

function msgValidate(changeId: string, changeDir: string, note?: string): string {
  return (
    `## SPX: Validate \`${changeId}\`\n` +
    "\n" +
    "Read the change files and check them against the SPX format rules:\n" +
    "\n" +
    `1. Read \`${changeDir}/proposal.md\` — check for: ## Why, ## What Changes, ## Out of Scope, ## Impact\n` +
    `2. Read \`${changeDir}/tasks.md\` — check: numbered sections, all items are \`- [ ]\` checkboxes\n` +
    `3. Read all files under \`${changeDir}/specs/\` — check:\n` +
    "   - Delta headers are exactly `## ADDED Requirements`, `## MODIFIED Requirements`, or `## REMOVED Requirements`\n" +
    "   - Every requirement starts with `### Requirement:`\n" +
    "   - Every requirement has at least one `#### Scenario:` block\n" +
    "   - Every scenario has `- **WHEN**` and `- **THEN**` clauses\n" +
    "   - MODIFIED requirements show the full updated text (not a diff)\n" +
    "   - REMOVED requirements have **Reason** and **Migration**\n" +
    `4. If \`${changeDir}/design.md\` exists check it has ## Decisions and ## Risks / Trade-offs\n` +
    "\n" +
    "Report: ✓ what's correct, ✗ what needs fixing, with specific file:line references." +
    (note ? `\n\n---\nUser note: ${note}` : "")
  );
}

function msgVerify(changeId: string, changeDir: string, note?: string): string {
  return (
    `## SPX: Verify \`${changeId}\`\n` +
    "\n" +
    "Load the **spx skill**, then compare what was proposed against what was built:\n" +
    "\n" +
    "### Step 1: Read the artifacts\n" +
    `- Read \`${changeDir}/proposal.md\` — what was planned\n` +
    `- Read \`${changeDir}/specs/\` — the behavior contract\n` +
    `- Read \`${changeDir}/tasks.md\` — what tasks were completed\n` +
    "\n" +
    "### Step 2: Read the implementation\n" +
    "Use bash to find changed files (git diff, git log, find by mtime) and read them.\n" +
    "\n" +
    "### Step 3: Compare and report\n" +
    "For each requirement in the spec: does the code satisfy it?\n" +
    "For each change in the proposal: is it present in the code?\n" +
    "For anything extra in the code: flag it as unplanned.\n" +
    "\n" +
    "Report each item as:\n" +
    "- ✓ requirement satisfied\n" +
    "- ⚠ requirement not found in code\n" +
    "- ✗ extra change not in proposal or spec\n" +
    "\n" +
    "### Step 4: Resolve mismatches\n" +
    "For each ⚠ or ✗, ask the user. Do NOT decide unilaterally:\n" +
    `- \"⚠ Requirement X not found in code.\" → Mark incomplete / remove from spec / skip?\n` +
    `- \"✗ Extra change Y not in proposal.\" → Add to proposal + spec / leave out?\n` +
    "\n" +
    "### Step 5: Update artifacts if needed\n" +
    "If user chose to add/remove anything, edit proposal.md and/or spec deltas.\n" +
    "\n" +
    "After resolution, report: 'Verified: <changeId>' with alignment summary." +
    (note ? `\n\n---\nUser note: ${note}` : "")
  );
}

function msgArchive(changeId: string, changeDir: string, archiveDir: string, note?: string): string {
  return (
    `## SPX: Archive \`${changeId}\`\n` +
    "\n" +
    "Load the **spx skill**, then complete these steps in order:\n" +
    "\n" +
    "### Step 1: Self-validate\n" +
    `Read all files under \`${changeDir}/specs/\` and check:\n` +
    "- Every requirement has at least one `#### Scenario:` block\n" +
    "- Delta headers are correct (ADDED/MODIFIED/REMOVED)\n" +
    "- Scenarios have WHEN/THEN clauses\n" +
    `- Check that \`${changeDir}/tasks.md\` has no unchecked items (all \`[x]\`)\n` +
    `- Remind: has \`/spx:verify\` been run on this change?\n` +
    "\n" +
    "### Step 2: Confirm with user\n" +
    "Ask: 'Archive and merge spec deltas into source-of-truth?'\n" +
    "If the change was tooling-only with no spec deltas, offer to skip the merge.\n" +
    "\n" +
    "### Step 3: Move to archive\n" +
    `Run: mkdir -p ${CHANGES_DIR}/archive && mv ${changeDir} ${archiveDir}\n` +
    "\n" +
    `### Step 4: Merge deltas into ${SPECS_DIR}/\n` +
    `For each spec file under \`${archiveDir}/specs/<capability>/spec.md\`:\n` +
    "\n" +
    `- Read the corresponding file in \`${SPECS_DIR}/<capability>/spec.md\` (or note it's new)\n` +
    "- Apply ADDED requirements (append to end)\n" +
    "- Apply MODIFIED requirements (replace the matching `### Requirement:` block)\n" +
    "- Apply REMOVED requirements (delete the block, preserving Reason + Migration as a note)\n" +
    "- Write the updated spec.md\n" +
    `- If the capability is new, create \`${SPECS_DIR}/<capability>/\` and write spec.md\n` +
    "\n" +
    "After merging, report: 'Archived: <changeId>' with a summary of merged deltas." +
    (note ? `\n\n---\nUser note: ${note}` : "")
  );
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ── /spx:explore ───────────────────────────────────────────────────────

  pi.registerCommand("spx:explore", {
    description:
      "Investigate the codebase before proposing — read-only thinking, no artifacts",
    handler: async (args, ctx) => {
      await bootstrap(pi);
      const topic = args.trim() || undefined;
      pi.sendMessage(
        {
          customType: "spx-explore",
          content: msgExplore(topic),
          display: true,
        },
        { triggerTurn: true },
      );
    },
  });

  // ── /spx:propose ───────────────────────────────────────────────────────

  pi.registerCommand("spx:propose", {
    description: "Create a new SPX change (proposal + specs + tasks)",
    getArgumentCompletions: async (_prefix) => null,
    handler: async (args, ctx) => {
      let { first: changeId, note } = splitArgs(args);

      if (!changeId) {
        const prompted =
          (
            await ctx.ui.input(
              "Change ID (verb-led: add-, update-, refactor-, remove-):",
            )
          )?.trim() ?? "";
        if (!prompted) {
          ctx.ui.notify("Change ID is required", "error");
          return;
        }
        // Re-parse: the user might have typed "add-foo extra note"
        const re = splitArgs(prompted);
        changeId = re.first;
        note = re.note;
      }

      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(changeId)) {
        ctx.ui.notify(
          "Change ID must be kebab-case, verb-led (e.g. add-user-auth, refactor-parser). No spaces or special chars.",
          "error",
        );
        return;
      }

      await bootstrap(pi);

      // Check for conflicting active changes
      const existing = await activeChanges(pi);
      if (existing.length > 0) {
        ctx.ui.notify(`Active changes: ${existing.join(", ")}`, "info");
      }

      // Suggest .gitignore if not set
      const gitignoreLine = `${ROOT}/`;
      const hasGitignore = await ensureGitignore(pi, gitignoreLine);
      if (!hasGitignore) {
        const add = await ctx.ui.confirm(
          "SPX",
          `Add "${gitignoreLine}" to .gitignore?\nChange files are ephemeral workspace — never committed.`,
        );
        if (add) {
          await appendGitignore(pi, gitignoreLine);
          ctx.ui.notify(`Added ${gitignoreLine} to .gitignore`, "info");
        }
      }

      // Scaffold the change directory
      await pi.exec("mkdir", ["-p", `${CHANGES_DIR}/${changeId}/specs`]);

      pi.sendMessage(
        {
          customType: "spx-propose",
          content: msgPropose(changeId, note),
          display: true,
        },
        { triggerTurn: true },
      );
    },
  });

  // ── /spx:apply ─────────────────────────────────────────────────────────

  pi.registerCommand("spx:apply", {
    description: "Implement all unchecked tasks in a change",
    getArgumentCompletions: (_prefix) =>
      cachedChanges.length > 0
        ? cachedChanges.map((c) => ({ value: c, label: c }))
        : null,
    handler: async (args, ctx) => {
      const { first, note } = splitArgs(args);
      let changeId = first;

      if (!changeId) {
        if (cachedChanges.length === 0) {
          ctx.ui.notify(
            "No active changes. Create one with /spx:propose.",
            "info",
          );
          return;
        }
        changeId =
          (await ctx.ui.select("Apply which change?", cachedChanges)) ?? "";
      }

      if (!changeId) {
        ctx.ui.notify("No change selected", "info");
        return;
      }

      const tasksPath = `${CHANGES_DIR}/${changeId}/tasks.md`;
      const proposalPath = `${CHANGES_DIR}/${changeId}/proposal.md`;

      try {
        const { stdout } = await pi.exec("bash", [
          "-c",
          `test -f ${tasksPath} && echo "ok"`,
        ]);
        if (stdout.trim() !== "ok") {
          ctx.ui.notify(
            `Change '${changeId}' not found or missing tasks.md`,
            "error",
          );
          return;
        }
      } catch {
        ctx.ui.notify(`Change '${changeId}' not found`, "error");
        return;
      }

      pi.sendMessage(
        {
          customType: "spx-apply",
          content: msgApply(changeId, tasksPath, proposalPath, note),
          display: true,
        },
        { triggerTurn: true },
      );
    },
  });

  // ── /spx:validate ──────────────────────────────────────────────────────

  pi.registerCommand("spx:validate", {
    description: "Check a change against the SPX format rules",
    getArgumentCompletions: (_prefix) =>
      cachedChanges.length > 0
        ? cachedChanges.map((c) => ({ value: c, label: c }))
        : null,
    handler: async (args, ctx) => {
      const { first, note } = splitArgs(args);
      let changeId = first;

      if (!changeId) {
        if (cachedChanges.length === 0) {
          ctx.ui.notify("No active changes to validate.", "info");
          return;
        }
        changeId =
          (await ctx.ui.select("Validate which change?", cachedChanges)) ?? "";
      }

      if (!changeId) return;

      const changeDir = `${CHANGES_DIR}/${changeId}`;

      pi.sendMessage(
        {
          customType: "spx-validate",
          content: msgValidate(changeId, changeDir, note),
          display: true,
        },
        { triggerTurn: true },
      );
    },
  });

  // ── /spx:verify ──────────────────────────────────────────────────────

  pi.registerCommand("spx:verify", {
    description:
      "Compare implementation against proposal + spec — find drift, resolve mismatches",
    getArgumentCompletions: (_prefix) =>
      cachedChanges.length > 0
        ? cachedChanges.map((c) => ({ value: c, label: c }))
        : null,
    handler: async (args, ctx) => {
      const { first, note } = splitArgs(args);
      let changeId = first;

      if (!changeId) {
        if (cachedChanges.length === 0) {
          ctx.ui.notify(
            "No active changes. Create one with /spx:propose.",
            "info",
          );
          return;
        }
        changeId =
          (await ctx.ui.select("Verify which change?", cachedChanges)) ?? "";
      }

      if (!changeId) return;

      const changeDir = `${CHANGES_DIR}/${changeId}`;

      pi.sendMessage(
        {
          customType: "spx-verify",
          content: msgVerify(changeId, changeDir, note),
          display: true,
        },
        { triggerTurn: true },
      );
    },
  });

  // ── /spx:list ──────────────────────────────────────────────────────────

  pi.registerCommand("spx:list", {
    description: "List active SPX changes (with task progress) and existing specs",
    handler: async (_args, ctx) => {
      const changes = await activeChanges(pi);
      const specs = await listSpecs(pi);

      const lines: string[] = [];

      if (changes.length > 0) {
        lines.push("## Active changes");
        for (const c of changes) {
          const ts = await taskStatus(pi, c);
          if (ts) {
            const pct = ts.total > 0 ? `${ts.done}/${ts.total}` : "?/?";
            const stale = ts.done === ts.total ? " ⚠ done, not archived" : "";
            lines.push(`- ${c} (${pct} tasks)${stale}`);
          } else {
            lines.push(`- ${c}`);
          }
        }
        lines.push("");
      }

      if (specs.length > 0) {
        lines.push("## Specs (source of truth)");
        for (const s of specs) lines.push(`- ${s}`);
        lines.push("");
      }

      if (lines.length === 0) {
        ctx.ui.notify(
          "No active changes or specs. Create one with /spx:propose.",
          "info",
        );
      } else {
        ctx.ui.notify(lines.join("\n"), "info");
      }
    },
  });

  // ── /spx:archive ───────────────────────────────────────────────────────

  pi.registerCommand("spx:archive", {
    description: "Merge spec deltas into source-of-truth, archive a completed change",
    getArgumentCompletions: (_prefix) =>
      cachedChanges.length > 0
        ? cachedChanges.map((c) => ({ value: c, label: c }))
        : null,
    handler: async (args, ctx) => {
      const { first, note } = splitArgs(args);
      let changeId = first;

      if (!changeId) {
        if (cachedChanges.length === 0) {
          ctx.ui.notify("No active changes to archive.", "info");
          return;
        }
        changeId =
          (await ctx.ui.select("Archive which change?", cachedChanges)) ?? "";
      }

      if (!changeId) return;

      const changeDir = `${CHANGES_DIR}/${changeId}`;
      const archiveDir = `${CHANGES_DIR}/archive/${today()}-${changeId}`;

      ctx.ui.notify(`Archiving ${changeId}...`, "info");

      pi.sendMessage(
        {
          customType: "spx-archive",
          content: msgArchive(changeId, changeDir, archiveDir, note),
          display: true,
        },
        { triggerTurn: true },
      );
    },
  });

  // ── /spx:revert ──────────────────────────────────────────────────────

  pi.registerCommand("spx:revert", {
    description: "Abandon an active change — delete artifacts, optionally undo code",
    getArgumentCompletions: (_prefix) =>
      cachedChanges.length > 0
        ? cachedChanges.map((c) => ({ value: c, label: c }))
        : null,
    handler: async (args, ctx) => {
      const { first, note } = splitArgs(args);
      let changeId = first;

      if (!changeId) {
        if (cachedChanges.length === 0) {
          ctx.ui.notify("No active changes to revert.", "info");
          return;
        }
        changeId =
          (await ctx.ui.select("Revert which change?", cachedChanges)) ?? "";
      }

      if (!changeId) return;

      const changeDir = `${CHANGES_DIR}/${changeId}`;

      let confirmMsg = `Delete ${changeDir}/ and all its artifacts?`;
      if (note) confirmMsg += `\n\nNote: ${note}`;

      const ok = await ctx.ui.confirm("Revert change", confirmMsg);
      if (!ok) return;

      await pi.exec("rm", ["-rf", changeDir]);
      await refreshCache();

      // Offer to undo source code changes
      pi.sendMessage(
        {
          customType: "spx-revert",
          content:
            `## SPX: Revert \`${changeId}\` — undo code changes\n` +
            `\n` +
            `The spec artifacts have been deleted. Now undo the source code changes:\n` +
            `\n` +
            `1. Find files changed as part of this change (git diff, git status)\n` +
            `2. Ask the user: "Revert these source files?" (show the list)\n` +
            `3. If yes: \`git checkout -- <files>\` to undo unstaged changes,\n` +
            `   AND/OR \`git reset\` / \`git restore --staged\` if changes were staged\n` +
            `4. If the user says skip, stop — leave the code as-is\n` +
            `\n` +
            `Report: 'Reverted: <changeId>' with summary of what was undone.`,
          display: true,
        },
        { triggerTurn: true },
      );
    },
  });

  // ── /spx:unarchive ───────────────────────────────────────────────────

  pi.registerCommand("spx:unarchive", {
    description: "Move an archived change back to active",
    getArgumentCompletions: async (_prefix) => {
      const archived = await archivedChanges(pi);
      return archived.length > 0
        ? archived.map((c) => ({ value: c, label: c }))
        : null;
    },
    handler: async (args, ctx) => {
      const { first, note } = splitArgs(args);
      let archivedId = first;

      if (!archivedId) {
        const archived = await archivedChanges(pi);
        if (archived.length === 0) {
          ctx.ui.notify("No archived changes to restore.", "info");
          return;
        }
        archivedId =
          (await ctx.ui.select("Restore which archived change?", archived)) ?? "";
      }

      if (!archivedId) return;

      const archiveDir = `${CHANGES_DIR}/archive/${archivedId}`;
      const originalId = archivedId.replace(/^\d{4}-\d{2}-\d{2}-/, "");
      const restoreDir = `${CHANGES_DIR}/${originalId}`;

      let confirmMsg = `Move ${archivedId} back to active as '${originalId}'?`;
      if (note) confirmMsg += `\n\nNote: ${note}`;

      const ok = await ctx.ui.confirm("Restore archived change", confirmMsg);
      if (!ok) return;

      await pi.exec("mkdir", ["-p", CHANGES_DIR]);
      await pi.exec("mv", [archiveDir, restoreDir]);
      await refreshCache();
      ctx.ui.notify(`Restored: ${originalId} (from archive)`, "info");
    },
  });

  // ── Lifecycle: refresh cache + one-shot nudge ──────────────────────────

  const refreshCache = async () => {
    cachedChanges = await activeChanges(pi);
  };

  let nudgedThisSession = false;

  pi.on("session_start", async () => {
    await refreshCache();
    nudgedThisSession = false;
  });

  pi.on("agent_end", async () => {
    await refreshCache();
  });

  // ── Nudge: suggest SPX workflow for feature-like requests ─────────

  pi.on("before_agent_start", async () => {
    if (nudgedThisSession) return;
    if (cachedChanges.length > 0) return;

    try {
      const { stdout } = await pi.exec("bash", [
        "-c",
        `test -d ${ROOT} && echo ok`,
      ]);
      if (stdout.trim() !== "ok") return;
    } catch {
      return;
    }

    nudgedThisSession = true;

    return {
      message: {
        customType: "spx-nudge",
        content: [
          "If the user is asking for a non-trivial feature, refactor, or change,",
          "suggest starting with `/spx:explore` to investigate the codebase",
          "or `/spx:propose <change-id>` to create a spec before implementing.",
          "For quick questions, small bug fixes, or trivial edits, proceed normally.",
        ].join(" "),
        display: false,
      },
    };
  });

  // ── Defense: guard git-add of ephemeral change files ───────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = (event.input.command as string) ?? "";

    // Explicit paths to .spx/changes/<not-archive>
    const explicitPattern = new RegExp(
      `git\\s+add\\s+.*${ROOT_RE}/changes\\/(?!archive)`,
    );
    if (explicitPattern.test(command)) {
      const ok = await ctx.ui.confirm(
        "SPX workspace files",
        `${CHANGES_DIR}/ files are ephemeral workspace — never committed.\n\nStage them anyway?`,
      );
      if (!ok) {
        return {
          block: true,
          reason:
            "SPX change files are ephemeral and should not be committed.",
        };
      }
      return;
    }

    // Broad git-add — warn if active changes exist
    if (
      /git\s+(add\s+(?:-A|--all|\.|\*)|commit\s+-a)/.test(command) &&
      cachedChanges.length > 0
    ) {
      ctx.ui.notify(
        `⚠ Active SPX changes (${cachedChanges.join(", ")}) may be staged.\n` +
          `${CHANGES_DIR}/ files are ephemeral — ensure .gitignore includes "${ROOT}/".`,
        "warning",
      );
    }
  });
}
