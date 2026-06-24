export interface IdentityRule {
  match: string;
  label: string;
  name: string;
  email: string;
}

export interface CurrentIdentity {
  repoRoot: string;
  remoteUrl: string | null;
  effectiveName: string | null;
  effectiveEmail: string | null;
  localName: string | null;
  localEmail: string | null;
  globalName: string | null;
  globalEmail: string | null;
}

export type IdentityState =
  | "safe"
  | "localNeeded"
  | "wrong"
  | "unknown"
  | "notGitRepo"
  | "error";

export interface IdentityEvaluationOptions {
  requireLocalIdentity: boolean;
}

export interface IdentityEvaluation {
  state: IdentityState;
  rule?: IdentityRule;
  current?: CurrentIdentity;
  normalizedRemote?: string;
  requireLocalIdentity: boolean;
  message: string;
}
