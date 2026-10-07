import { isNonEmptyString } from "../validation";

/** Result of a note mutation the webview must react to (clear a draft / leave edit mode only on success). */
export interface NoteMutationResult {
  ok: boolean;
  error?: string;
}

/**
 * Everything the webview can ask the extension host to do. Every handler
 * re-validates its own preconditions (selected repository, Workspace Trust
 * for anything that mutates Git hooks/config, user confirmation) — the
 * webview is never trusted to have done so.
 */
export interface SidebarActions {
  selectRepo(id: string): Promise<void>;
  assignIdentity(identityId: string): Promise<void>;
  changeIdentity(identityId: string): Promise<void>;
  unlockRepository(): Promise<void>;
  repairLock(): Promise<void>;
  checkLock(): Promise<void>;
  applyIdentityToGitConfig(): Promise<void>;
  editIdentities(): Promise<void>;

  addNote(text: string): Promise<NoteMutationResult>;
  updateNote(id: string, text: string): Promise<NoteMutationResult>;
  removeNote(id: string): Promise<void>;
  togglePinNote(id: string): Promise<void>;
  copyNote(id: string): Promise<void>;
  exportNotes(): Promise<void>;
  exportAllNotes(): Promise<void>;
  importNotes(): Promise<void>;
}

/**
 * Validates and dispatches one webview message. Pure with respect to
 * `vscode` (exported for tests). The webview is a trust boundary: a
 * message whose required fields are missing or malformed is dropped — never
 * coerced, never partially actioned with a guessed default. In particular
 * nothing here can create an assignment without an explicit, non-empty
 * identity id, and the action itself re-checks trust and confirmation.
 */
export async function dispatchSidebarMessage(
  actions: SidebarActions,
  message: { type?: unknown; [key: string]: unknown },
  reply: (requestId: unknown, result: NoteMutationResult) => void,
): Promise<void> {
  switch (message.type) {
    case "selectRepo":
      if (isNonEmptyString(message.id)) await actions.selectRepo(message.id);
      break;
    case "assignIdentity":
      if (isNonEmptyString(message.identityId)) await actions.assignIdentity(message.identityId);
      break;
    case "changeIdentity":
      if (isNonEmptyString(message.identityId)) await actions.changeIdentity(message.identityId);
      break;
    case "unlockRepository":
      await actions.unlockRepository();
      break;
    case "repairLock":
      await actions.repairLock();
      break;
    case "checkLock":
      await actions.checkLock();
      break;
    case "applyIdentityToGitConfig":
      await actions.applyIdentityToGitConfig();
      break;
    case "editIdentities":
      await actions.editIdentities();
      break;
    case "addNote":
      reply(message.requestId, isNonEmptyString(message.text) ? await actions.addNote(message.text) : { ok: false, error: "A note can't be empty." });
      break;
    case "updateNote":
      reply(
        message.requestId,
        isNonEmptyString(message.id) && typeof message.text === "string"
          ? await actions.updateNote(message.id, message.text)
          : { ok: false, error: "A note can't be empty." },
      );
      break;
    case "removeNote":
      if (isNonEmptyString(message.id)) await actions.removeNote(message.id);
      break;
    case "togglePinNote":
      if (isNonEmptyString(message.id)) await actions.togglePinNote(message.id);
      break;
    case "copyNote":
      if (isNonEmptyString(message.id)) await actions.copyNote(message.id);
      break;
    case "exportNotes":
      await actions.exportNotes();
      break;
    case "exportAllNotes":
      await actions.exportAllNotes();
      break;
    case "importNotes":
      await actions.importNotes();
      break;
  }
}
