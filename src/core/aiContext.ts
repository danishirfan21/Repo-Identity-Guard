import { RepoMemory, StatusSummary } from "../types";

const AI_RULES = [
  "Do not run git push.",
  "Do not modify main/master.",
  "Ask before changing branch.",
  "Do not change Git identity, remotes, SSH config, or credential settings.",
];

/**
 * Builds a privacy-safe text block for pasting into an AI agent's context.
 * Deliberately excludes secrets, tokens, .env values, SSH key contents, raw
 * Git config, and any private file contents — only status labels, issue
 * titles, and pinned memory text ever go in.
 */
export function buildAiContext(summary: StatusSummary, memory: RepoMemory): string {
  const lines: string[] = ["[REPO CONTEXT]"];

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
  if (pinnedNotes.length > 0) {
    lines.push("", "Pinned memory:");
    for (const note of pinnedNotes) {
      lines.push(`- ${note.text}`);
    }
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
