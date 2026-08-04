import { RepoMemory, StatusSummary } from "../types";

const AI_RULES = [
  "Do not run git push.",
  "Do not modify main/master.",
  "Ask before changing branch.",
  "Preserve existing uncommitted changes — do not reset, stash, or discard them.",
  "Do not change Git identity, remotes, SSH config, or credential settings.",
];

export interface AiContextOptions {
  /**
   * Off unless the user explicitly opts in (Settings). Pinned notes are
   * user-authored free text and may contain things the user typed for
   * themselves, not for export — never include them silently.
   */
  includeMemory: boolean;
  /** Injectable for tests; defaults to `new Date()`. */
  now?: Date;
}

/**
 * Builds a text block for pasting into an AI agent's context. Fields are an
 * explicit allowlist — repo name, matched profile, status, branch, issue
 * titles, and (only when opted in) pinned memory text — never raw remote
 * URLs, tokens, secrets, `.env` values, SSH key contents, or raw Git config.
 * Call sites should let the user preview this exact text before it's used.
 */
export function buildAiContext(
  summary: StatusSummary,
  memory: RepoMemory,
  options: AiContextOptions,
): string {
  const lines: string[] = ["[REPO CONTEXT]"];
  const checkedAt = options.now ?? new Date();

  lines.push(`Checked: ${checkedAt.toLocaleString()}`);
  lines.push(`Repo: ${summary.repoName ?? "Unknown"}`);
  lines.push(`Profile: ${summary.matchedProfile?.label ?? "Unknown"}`);
  lines.push(`Status: ${statusLabel(summary.level)}`);
  if (summary.facts.currentBranch) {
    lines.push(`Branch: ${summary.facts.currentBranch}`);
  }

  const blockingAndWarningIssues = summary.issues.filter(
    (issue) => issue.severity !== "info",
  );
  if (blockingAndWarningIssues.length > 0) {
    lines.push("", "Issues:");
    for (const issue of blockingAndWarningIssues) {
      lines.push(`- ${issue.title}`);
    }
  }

  const pinnedNotes = memory.notes.filter((note) => note.pinned);
  if (options.includeMemory && pinnedNotes.length > 0) {
    lines.push("", "User-approved pinned notes:");
    for (const note of pinnedNotes) {
      lines.push(`- ${note.text}`);
    }
  } else if (pinnedNotes.length > 0) {
    lines.push(
      "",
      "(Pinned memory omitted — enable \"Include Repo Memory in AI context\" in Settings to include it. Notes are free text you wrote and may contain sensitive info.)",
    );
  }

  lines.push("", "Rules for AI:");
  for (const rule of AI_RULES) {
    lines.push(`- ${rule}`);
  }

  return lines.join("\n");
}

function statusLabel(level: StatusSummary["level"]): string {
  switch (level) {
    case "safe":
      return "SAFE";
    case "not_safe":
      return "NOT SAFE";
    case "not_checked":
      return "NOT CHECKED";
  }
}
