export interface IdentityRule {
  match: string;
  label: string;
  name: string;
  email: string;
}

export interface CurrentIdentity {
  repoRoot: string;
  remoteUrl: string | null;
  name: string | null;
  email: string | null;
}

export type IdentityState =
  | "safe"
  | "wrong"
  | "unknown"
  | "notGitRepo"
  | "error";

export interface IdentityEvaluation {
  state: IdentityState;
  rule?: IdentityRule;
  current?: CurrentIdentity;
  message: string;
}
