import { IdentityDraft } from "../identity/identityCrud";
import { isNonEmptyString, sanitizeStringArray } from "../validation";
import { RepoIdentityUiState } from "./productionState";

/**
 * The production webview message protocol — see "GENERIC REQUEST/ACK
 * PROTOCOL" in the task spec. This generalizes the existing
 * `noteResult`/`requestId` design (see `src/ui/sidebarMessages.ts`, still
 * in production use by the placeholder webview and left untouched by this
 * phase) into ONE typed operation acknowledgement covering every mutation,
 * not just notes.
 *
 * There is NO `selectRepo` message, and never will be one here — Repo
 * Identity Guard has no repository picker (see FROZEN PRODUCT RULES); the
 * webview always renders whatever repository `state.payload.repo` names,
 * decided by `src/identity/currentRepo.ts`.
 *
 * `ExtensionMessage.state` pushes are never, on their own, evidence that a
 * mutation succeeded — see "OPERATION RESULT RULE": a state push can
 * arrive for reasons unrelated to any particular pending request (another
 * window changed something, a file watcher fired), so the webview must
 * wait for the `operationResult` carrying the SAME `requestId` before
 * treating a submitted draft as safely gone.
 */

// ==================== webview -> extension ====================

export type WebviewMessage =
  | { type: "ready" }
  | { type: "assignIdentity"; identityId: string; requestId: string }
  | { type: "changeIdentity"; identityId: string; requestId: string }
  | { type: "unlockRepository"; requestId: string }
  | { type: "repairLock"; requestId: string }
  | { type: "verifyLock"; requestId: string }
  | { type: "applyAssignedIdentity"; requestId: string }
  | { type: "saveIdentity"; identity: IdentityDraft; requestId: string }
  | { type: "deleteIdentity"; identityId: string; requestId: string }
  | { type: "addNote"; text: string; requestId: string }
  | { type: "updateNote"; noteId: string; text: string; requestId: string }
  | { type: "deleteNote"; noteId: string; requestId: string }
  | { type: "togglePinNote"; noteId: string; requestId: string }
  | { type: "copyNote"; noteId: string }
  | { type: "importNotes" }
  | { type: "exportNotes" };

/** Every `WebviewMessage` variant's own `type` literal — used to keep the runtime validator exhaustive with the type union (see the `satisfies`-style check in `protocol.test.ts`). */
export const WEBVIEW_MESSAGE_TYPES = [
  "ready",
  "assignIdentity",
  "changeIdentity",
  "unlockRepository",
  "repairLock",
  "verifyLock",
  "applyAssignedIdentity",
  "saveIdentity",
  "deleteIdentity",
  "addNote",
  "updateNote",
  "deleteNote",
  "togglePinNote",
  "copyNote",
  "importNotes",
  "exportNotes",
] as const;

/** Operations that mutate Git (hooks/config) and therefore require Workspace Trust — see "WORKSPACE TRUST" in the task spec. Everything else (notes; identity SETTINGS edits, which execute no repository code) does not. */
const TRUST_REQUIRED_TYPES: ReadonlySet<WebviewMessage["type"]> = new Set([
  "assignIdentity",
  "changeIdentity",
  "unlockRepository",
  "repairLock",
  "applyAssignedIdentity",
]);

export function operationRequiresTrust(type: WebviewMessage["type"]): boolean {
  return TRUST_REQUIRED_TYPES.has(type);
}

function readIdentityDraft(raw: unknown): IdentityDraft | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r.label) || !isNonEmptyString(r.gitEmail)) return undefined;
  const draft: IdentityDraft = {
    label: r.label,
    gitEmail: r.gitEmail,
    sshAliases: sanitizeStringArray(r.sshAliases),
  };
  if (isNonEmptyString(r.id)) draft.id = r.id;
  if (isNonEmptyString(r.gitName)) draft.gitName = r.gitName;
  if (isNonEmptyString(r.githubUsername)) draft.githubUsername = r.githubUsername;
  return draft;
}

/**
 * Validates and narrows one untrusted webview payload. Total: never
 * throws, and a message whose required fields are missing or malformed
 * (wrong type, empty string where a non-empty one is required) is dropped
 * — returns `undefined` — never coerced or partially accepted. Mirrors
 * `dispatchSidebarMessage`'s own trust-boundary discipline.
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as { type?: unknown; [key: string]: unknown };

  switch (m.type) {
    case "ready":
    case "copyNote":
    case "importNotes":
    case "exportNotes":
      if (m.type === "copyNote") return isNonEmptyString(m.noteId) ? { type: "copyNote", noteId: m.noteId } : undefined;
      return { type: m.type };

    case "assignIdentity":
    case "changeIdentity":
    case "deleteIdentity":
      return isNonEmptyString(m.identityId) && isNonEmptyString(m.requestId)
        ? { type: m.type, identityId: m.identityId, requestId: m.requestId }
        : undefined;

    case "unlockRepository":
    case "repairLock":
    case "verifyLock":
    case "applyAssignedIdentity":
      return isNonEmptyString(m.requestId) ? { type: m.type, requestId: m.requestId } : undefined;

    case "saveIdentity": {
      if (!isNonEmptyString(m.requestId)) return undefined;
      const identity = readIdentityDraft(m.identity);
      return identity ? { type: "saveIdentity", identity, requestId: m.requestId } : undefined;
    }

    case "addNote":
      return isNonEmptyString(m.text) && isNonEmptyString(m.requestId) ? { type: "addNote", text: m.text, requestId: m.requestId } : undefined;

    case "updateNote":
      return isNonEmptyString(m.noteId) && typeof m.text === "string" && isNonEmptyString(m.requestId)
        ? { type: "updateNote", noteId: m.noteId, text: m.text, requestId: m.requestId }
        : undefined;

    case "deleteNote":
    case "togglePinNote":
      return isNonEmptyString(m.noteId) && isNonEmptyString(m.requestId) ? { type: m.type, noteId: m.noteId, requestId: m.requestId } : undefined;

    default:
      // In particular: no "selectRepo" case, deliberately — see this
      // module's doc comment. An unrecognized `type` (including
      // "selectRepo", were a stale/compromised webview to send it) is
      // dropped, never dispatched.
      return undefined;
  }
}

// ==================== extension -> webview ====================

/**
 * One typed operation acknowledgement, correlated by `requestId` — see
 * "OPERATION RESULT RULE": `ok: true` means the backend operation
 * succeeded and the authoritative state has already been refreshed (a
 * `state` message is pushed separately); `ok: false` means the backend
 * changed nothing (or rolled back), the state push (if any) reflects
 * reality as it already was, and the webview's own draft/input may stay
 * exactly as the user left it. `code` is a stable machine-readable reason
 * (e.g. `"identity_in_use"`) for responses that need one; `details` are
 * safe, display-ready strings (e.g. the repository names from a blocked
 * identity delete) — never a filesystem path unless genuinely required.
 */
export interface OperationResult {
  ok: boolean;
  message?: string;
  code?: string;
  details?: string[];
}

export type ExtensionMessage =
  | { type: "state"; payload: RepoIdentityUiState }
  | ({ type: "operationResult"; requestId: string } & OperationResult);
