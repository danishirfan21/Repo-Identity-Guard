import { AgentRestriction, CapabilityResult, RepoMemory, StatusSummary, WorkspaceSafetyState } from "../types";

/** Fixed baseline rules that apply regardless of any specific finding this scan — never derived. */
const BASELINE_RESTRICTIONS: AgentRestriction[] = [
  { id: "no-push", description: "Do not run `git push`." },
  { id: "no-identity-change", description: "Do not change Git identity, remotes, SSH config, or credential settings." },
];

export interface SourcedText {
  sourceId: string;
  text: string;
}

export interface SourcedRestriction {
  restriction: AgentRestriction;
  sourceCapabilityIds: string[];
}

export interface AiContextModel {
  checkedAt: Date;
  repoName?: string;
  profileLabel?: string;
  status: StatusSummary["level"];
  branch?: string;
  confirmedFacts: SourcedText[];
  contradictions: SourcedText[];
  unverifiedFacts: SourcedText[];
  warnings: SourcedText[];
  /** Deduplicated agent restrictions derived from this scan's findings, each keeping track of which capability produced it. */
  derivedRestrictions: SourcedRestriction[];
  baselineRestrictions: AgentRestriction[];
  pinnedMemoryIncluded: boolean;
  pinnedMemoryText?: string;
}

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
 * Builds the structured model Copy Context for AI is rendered from — the
 * same `CapabilityResult` objects that drive Review Details, translated
 * into an operational format for an agent. `not_applicable` results are
 * omitted entirely (nothing to report). Every `blocksOverallSafety` result
 * is guaranteed to appear here, either as a contradiction/unverified/
 * warning entry or via a derived restriction — see the invariant test.
 */
export function buildAiContextModel(
  summary: StatusSummary,
  memory: RepoMemory,
  options: AiContextOptions,
): AiContextModel {
  const confirmedFacts: SourcedText[] = [];
  const contradictions: SourcedText[] = [];
  const unverifiedFacts: SourcedText[] = [];
  const warnings: SourcedText[] = [];
  const restrictionsById = new Map<string, SourcedRestriction>();

  for (const result of summary.capabilityResults) {
    const entry: SourcedText = { sourceId: result.id, text: result.title };
    switch (result.state) {
      case "confirmed":
        confirmedFacts.push(entry);
        break;
      case "contradicted":
        contradictions.push(entry);
        break;
      case "unverified":
        unverifiedFacts.push(entry);
        break;
      case "warning":
        warnings.push(entry);
        break;
      case "not_applicable":
        break;
    }

    for (const restriction of result.agentRestrictions ?? []) {
      const existing = restrictionsById.get(restriction.id);
      if (existing) {
        if (!existing.sourceCapabilityIds.includes(result.id)) {
          existing.sourceCapabilityIds.push(result.id);
        }
      } else {
        restrictionsById.set(restriction.id, { restriction, sourceCapabilityIds: [result.id] });
      }
    }
  }

  const pinnedNotes = memory.notes.filter((note) => note.pinned);
  const pinnedMemoryIncluded = options.includeMemory && pinnedNotes.length > 0;

  return {
    checkedAt: options.now ?? new Date(),
    repoName: summary.repoName,
    profileLabel: summary.matchedProfile?.label,
    status: summary.level,
    branch: summary.facts.currentBranch,
    confirmedFacts,
    contradictions,
    unverifiedFacts,
    warnings,
    derivedRestrictions: Array.from(restrictionsById.values()),
    baselineRestrictions: BASELINE_RESTRICTIONS,
    pinnedMemoryIncluded,
    pinnedMemoryText: pinnedMemoryIncluded ? pinnedNotes.map((note) => note.text).join(" / ") : undefined,
  };
}

/**
 * Renders the model to the text block that's actually copied/previewed.
 * Fields are an explicit allowlist — repo name, matched profile, status,
 * branch, capability titles, and (only when opted in) pinned memory text —
 * never raw remote URLs, tokens, secrets, `.env` values, SSH key contents,
 * or raw Git config.
 */
export function renderAiContext(model: AiContextModel): string {
  const lines: string[] = ["[REPO CONTEXT]"];

  lines.push(`Checked: ${model.checkedAt.toLocaleString()}`);
  lines.push(`Repo: ${model.repoName ?? "Unknown"}`);
  lines.push(`Profile: ${model.profileLabel ?? "Unknown"}`);
  lines.push(`Status: ${statusLabel(model.status)}`);
  if (model.branch) {
    lines.push(`Branch: ${model.branch}`);
  }

  if (model.contradictions.length > 0) {
    lines.push("", "Contradictions:");
    for (const item of model.contradictions) lines.push(`- ${item.text}`);
  }
  if (model.unverifiedFacts.length > 0) {
    lines.push("", "Unverified facts:");
    for (const item of model.unverifiedFacts) lines.push(`- ${item.text}`);
  }
  if (model.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const item of model.warnings) lines.push(`- ${item.text}`);
  }
  if (model.confirmedFacts.length > 0) {
    lines.push("", "Confirmed facts:");
    for (const item of model.confirmedFacts) lines.push(`- ${item.text}`);
  }

  if (model.pinnedMemoryIncluded && model.pinnedMemoryText) {
    lines.push("", "User-approved pinned notes:");
    lines.push(`- ${model.pinnedMemoryText}`);
  } else if (!model.pinnedMemoryIncluded) {
    lines.push(
      "",
      "(Pinned memory omitted — enable \"Include Repo Memory in AI context\" in Settings to include it. Notes are free text you wrote and may contain sensitive info.)",
    );
  }

  lines.push("", "Rules for AI:");
  for (const restriction of model.baselineRestrictions) {
    lines.push(`- ${restriction.description}`);
  }
  for (const sourced of model.derivedRestrictions) {
    lines.push(`- ${sourced.restriction.description}`);
  }

  return lines.join("\n");
}

export function buildAiContext(
  summary: StatusSummary,
  memory: RepoMemory,
  options: AiContextOptions,
): string {
  return renderAiContext(buildAiContextModel(summary, memory, options));
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

/**
 * Compact multi-repo status for pasting into an AI agent's context in a
 * multi-root workspace — every repo's SAFE/NOT SAFE verdict and its blocking
 * reasons, one line each. Deliberately not a combined dump of every repo's
 * full capability checklist or Repo Memory notes; use `buildAiContext` for a
 * single repo's full detail.
 */
export function buildWorkspaceSafetySummary(workspace: WorkspaceSafetyState, now: Date = new Date()): string {
  const lines: string[] = [];
  lines.push(`Workspace safety summary — checked ${now.toISOString()}`);
  lines.push(
    `Overall: ${statusLabel(workspace.level)} (${workspace.safeCount} safe, ${workspace.notSafeCount} not safe, ${workspace.uncheckedCount} unchecked of ${workspace.repos.length} repositories)`,
  );
  lines.push("");

  if (workspace.repos.length === 0) {
    lines.push("No Git repositories detected in this workspace.");
    return lines.join("\n");
  }

  for (const repo of workspace.repos) {
    const { summary } = repo;
    const label = summary.repoName ?? repo.workspaceFolderName ?? "(unnamed repo)";
    const profileNote = summary.matchedProfile ? ` — ${summary.matchedProfile.label}` : "";
    lines.push(`- ${label}: ${statusLabel(summary.level)}${profileNote}`);

    for (const result of summary.capabilityResults.filter((r) => r.blocksOverallSafety)) {
      lines.push(`    - ${result.title}`);
      if (result.agentRestrictions?.length) {
        for (const restriction of result.agentRestrictions) {
          lines.push(`        - Restriction: ${restriction.description}`);
        }
      }
    }
  }

  lines.push("");
  lines.push("Rules for AI: treat any repository above marked NOT SAFE as off-limits for commits, pushes, or identity/remote changes until its own Review Details are resolved.");

  return lines.join("\n");
}

/** Exported for the invariant test: every capability result that blocks overall safety must be representable in the AI context. */
export function isCapabilityRepresentedInModel(result: CapabilityResult, model: AiContextModel): boolean {
  const inTextSection = [...model.contradictions, ...model.unverifiedFacts, ...model.warnings].some(
    (entry) => entry.sourceId === result.id,
  );
  const inRestrictions = model.derivedRestrictions.some((sourced) =>
    sourced.sourceCapabilityIds.includes(result.id),
  );
  return inTextSection || inRestrictions;
}
