import {
  CurrentIdentity,
  IdentityEvaluation,
  IdentityEvaluationOptions,
  IdentityRule,
} from "./types";

export function loadRules(): IdentityRule[] {
  // Load VS Code only when reading settings so the pure matching logic remains
  // usable in regular Node tests.
  const vscode = require("vscode") as typeof import("vscode");
  const configured = vscode.workspace
    .getConfiguration("repoIdentityGuard")
    .get<IdentityRule[]>("rules", []);

  return configured.filter(
    (rule) =>
      typeof rule?.match === "string" &&
      typeof rule?.label === "string" &&
      typeof rule?.name === "string" &&
      typeof rule?.email === "string",
  );
}

export function loadRequireLocalIdentity(): boolean {
  const vscode = require("vscode") as typeof import("vscode");
  return vscode.workspace
    .getConfiguration("repoIdentityGuard")
    .get<boolean>("requireLocalIdentity", false);
}

export function normalizeRemoteUrl(remoteUrl: string): string {
  let normalized = remoteUrl.trim().replace(/\\/g, "/");

  const scpLike = normalized.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scpLike && !/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    normalized = `${scpLike[1]}/${scpLike[2]}`;
  } else {
    try {
      const parsed = new URL(normalized);
      normalized = `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
    } catch {
      normalized = normalized
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
        .replace(/^[^@/\s]+@/, "");
    }
  }

  return normalized
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = normalizeRemoteUrl(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");

  return new RegExp(`^${escaped}$`);
}

export function matchRule(
  remoteUrl: string | null,
  rules: IdentityRule[],
): IdentityRule | undefined {
  if (!remoteUrl) {
    return undefined;
  }

  const normalizedRemote = normalizeRemoteUrl(remoteUrl);
  return rules.find((rule) => wildcardToRegExp(rule.match).test(normalizedRemote));
}

export function buildExactRuleMatch(remoteUrl: string): string {
  return normalizeRemoteUrl(remoteUrl);
}

export function evaluateIdentity(
  current: CurrentIdentity | null,
  rules: IdentityRule[],
  options: IdentityEvaluationOptions = { requireLocalIdentity: false },
): IdentityEvaluation {
  if (!current) {
    return {
      state: "notGitRepo",
      requireLocalIdentity: options.requireLocalIdentity,
      message: "The active workspace is not inside a Git repository.",
    };
  }

  if (!current.remoteUrl) {
    return {
      state: "unknown",
      current,
      requireLocalIdentity: options.requireLocalIdentity,
      message: "This repository has no origin remote.",
    };
  }

  const normalizedRemote = normalizeRemoteUrl(current.remoteUrl);
  const rule = matchRule(current.remoteUrl, rules);
  if (!rule) {
    return {
      state: "unknown",
      current,
      normalizedRemote,
      requireLocalIdentity: options.requireLocalIdentity,
      message: "No identity rule matched this repository.",
    };
  }

  const nameMatches = current.effectiveName?.trim() === rule.name.trim();
  const emailMatches =
    current.effectiveEmail?.trim().toLocaleLowerCase() ===
    rule.email.trim().toLocaleLowerCase();

  if (nameMatches && emailMatches) {
    const localNameMatches = current.localName?.trim() === rule.name.trim();
    const localEmailMatches =
      current.localEmail?.trim().toLocaleLowerCase() ===
      rule.email.trim().toLocaleLowerCase();

    if (
      options.requireLocalIdentity &&
      (!localNameMatches || !localEmailMatches)
    ) {
      return {
        state: "localNeeded",
        current,
        rule,
        normalizedRemote,
        requireLocalIdentity: options.requireLocalIdentity,
        message:
          "Commits are using the expected author identity now, but this repo is not pinned locally. If global Git config changes, future commits may use the wrong author.",
      };
    }

    return {
      state: "safe",
      current,
      rule,
      normalizedRemote,
      requireLocalIdentity: options.requireLocalIdentity,
      message: `Repo identity is safe for ${rule.label}.`,
    };
  }

  return {
    state: "wrong",
    current,
    rule,
    normalizedRemote,
    requireLocalIdentity: options.requireLocalIdentity,
    message:
      "Git commits would use an author identity that does not match this repo's rule.",
  };
}
