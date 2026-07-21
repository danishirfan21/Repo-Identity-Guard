import { IdentityEvaluation, IdentityState } from "./types";

export function toWebviewState(evaluation: IdentityEvaluation | undefined) {
  const current = evaluation?.current;
  const rule = evaluation?.rule;

  const localName = current?.localName ?? null;
  const localEmail = current?.localEmail ?? null;
  const localMissing = !localName || !localEmail;
  const localMatches = doesIdentityMatch(localName, localEmail, rule);
  const isLocallyPinnedSafe = evaluation?.state === "safe" && localMatches;

  const effectiveIndicator = indicatorForEffective(evaluation);
  const localIndicator = indicatorForLocal(evaluation);
  const globalIndicator = indicatorForGlobal(evaluation, isLocallyPinnedSafe);
  const primaryAction = primaryActionForEvaluation(evaluation);

  return {
    state: evaluation?.state ?? "unknown",
    statusLabel: evaluation ? statusLabel(evaluation.state) : "Not Scanned",
    statusMessage: evaluation
      ? statusMessage(evaluation)
      : "Repo ID has not scanned this workspace yet.",

    normalizedRemote: evaluation?.normalizedRemote ?? "Not set",
    rawRemote: current?.remoteUrl ?? "Not set",
    repoRoot: current?.repoRoot ?? "Not in a Git repo",

    ruleLabel: rule?.label ?? "No matched rule",
    ruleMatch: rule?.match ?? "None",
    expectedName: rule?.name ?? "Not set",
    expectedEmail: rule?.email ?? "Not set",

    effectiveName: current?.effectiveName ?? "Not set",
    effectiveEmail: current?.effectiveEmail ?? "Not set",

    localName: localMissing ? "Not pinned" : localName,
    localEmail: localMissing
      ? "Not set locally. Using global Git config"
      : localEmail,

    globalName: current?.globalName ?? "Not set",
    globalEmail: isLocallyPinnedSafe
      ? "Fallback only — not used while this repo has local identity"
      : (current?.globalEmail ?? "Not set"),

    effectiveIndicator,
    localIndicator,
    globalIndicator,

    primaryAction,

    canSetLocal:
      !!current &&
      !!rule &&
      (evaluation?.state === "localNeeded" || evaluation?.state === "wrong"),
    canAddRule: !!current && evaluation?.state === "unknown",
  };
}

function statusLabel(state: IdentityState): string {
  switch (state) {
    case "safe":
      return "Safe";
    case "wrong":
      return "Wrong Identity";
    case "localNeeded":
      return "Local Needed";
    case "unknown":
      return "Unknown";
    case "notGitRepo":
      return "Not a Git Repo";
    case "error":
      return "Error";
  }
}

function statusMessage(evaluation: IdentityEvaluation): string {
  switch (evaluation.state) {
    case "safe":
      return "Git commits will use the expected author identity for this repo.";
    case "wrong":
      return "Git commits would use an author identity that does not match this repo's rule.";
    case "localNeeded":
      return "Commits are using the expected author identity now, but this repo is not pinned locally. If global Git config changes, future commits may use the wrong author.";
    case "unknown":
      return "No matching identity rule was found for this repo.";
    default:
      return evaluation.message;
  }
}

function indicatorForEffective(evaluation: IdentityEvaluation | undefined): string {
  if (!evaluation?.rule || !evaluation.current) {
    return "neutral";
  }

  return evaluation.state === "wrong" ? "bad" : "good";
}

function indicatorForLocal(evaluation: IdentityEvaluation | undefined): string {
  if (!evaluation?.rule || !evaluation.current) {
    return "neutral";
  }

  return doesIdentityMatch(
    evaluation.current.localName,
    evaluation.current.localEmail,
    evaluation.rule,
  )
    ? "good"
    : "warn";
}

function indicatorForGlobal(
  evaluation: IdentityEvaluation | undefined,
  isLocallyPinnedSafe = false,
): string {
  if (!evaluation?.rule || !evaluation.current) {
    return "neutral";
  }

  if (isLocallyPinnedSafe) {
    return "neutral";
  }

  return doesIdentityMatch(
    evaluation.current.globalName,
    evaluation.current.globalEmail,
    evaluation.rule,
  )
    ? "good"
    : "warn";
}

function doesIdentityMatch(
  name: string | null | undefined,
  email: string | null | undefined,
  rule: IdentityEvaluation["rule"],
): boolean {
  if (!rule) {
    return false;
  }

  return (
    name?.trim() === rule.name.trim() &&
    email?.trim().toLocaleLowerCase() === rule.email.trim().toLocaleLowerCase()
  );
}

function primaryActionForEvaluation(
  evaluation: IdentityEvaluation | undefined,
): string | null {
  switch (evaluation?.state) {
    case "wrong":
      return "Fix Local Identity";
    case "localNeeded":
      return "Set Local Identity";
    case "unknown":
      return evaluation.current ? "Add Rule" : null;
    default:
      return null;
  }
}
