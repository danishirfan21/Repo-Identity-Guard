/**
 * Router + event wiring. Assembled last in the client script since it calls
 * into every view module's render function and starts the app.
 *
 * First-run onboarding: shown whenever the current repo has no usable
 * profile ({@link shouldShowOnboarding}, from onboardingView.ts) and the
 * user hasn't deliberately navigated to Details/Memory/Settings — i.e. only
 * while sitting on Main or already on Onboarding. That is the entire rule;
 * there's no separate "have I onboarded" flag stored anywhere.
 */
export const NAVIGATION_JS = `
const app = document.getElementById("app");
const headerTitle = document.getElementById("headerTitle");
const headerSubtitle = document.getElementById("headerSubtitle");
const backButton = document.getElementById("backButton");

let state = null;
let view = "main";

// ---- Repo Memory mutation acks ----
// Each in-flight addMemoryNote/updateMemoryNote/addSavedCommand carries a
// client-generated requestId; the draft it was built from is deliberately
// NOT cleared until the extension host acks it (see
// handleMemoryMutationResult below) — sending a message is not the same
// as the backend having accepted it, and clearing a draft optimistically
// would lose the user's text on a rejected over-limit/empty/invalid
// mutation. Keyed by requestId rather than assuming only one is ever in
// flight, since a fast typist could in principle fire more than one
// before either resolves.
let memoryRequestSeq = 0;
const memoryPendingRequests = {};

function nextMemoryRequestId() {
  memoryRequestSeq += 1;
  return "mem-" + memoryRequestSeq;
}

function handleMemoryMutationResult(message) {
  const pending = memoryPendingRequests[message.requestId];
  if (!pending) return;
  delete memoryPendingRequests[message.requestId];
  if (message.ok) {
    if (pending.kind === "addNote") {
      memoryNewNoteDraft = "";
    } else if (pending.kind === "editNote" && memoryEditingNoteId === pending.noteId) {
      memoryEditingNoteId = null;
      memoryEditDraft = "";
    } else if (pending.kind === "addCommand") {
      memoryNewCommandLabelDraft = "";
      memoryNewCommandDraft = "";
    }
  }
  // On failure, everything (draft text, edit mode) is already exactly as
  // the user left it — nothing was cleared optimistically — so there's
  // nothing to restore here; a native warning dialog from the extension
  // host already explains what went wrong. Re-render either way so a
  // successful add/edit/save is reflected immediately rather than waiting
  // for the next unrelated state push.
  render();
}

function headerFor(v) {
  if (v === "onboarding") return ["Repo Identity Guard", "Quick setup"];
  if (v === "shieldDiscovery") return ["Repo Identity Guard", "Quick setup"];
  if (v === "main") return ["Repo Identity Guard", "Safe to work, commit, push?"];
  if (v === "details") return ["Review Details", "Full issue list"];
  if (v === "memory") return ["Repo Memory", "Notes and saved commands"];
  if (v === "shield") return ["Shield", "Local Git enforcement"];
  if (v === "shieldEnable") return ["Enable Shield", "Confirm before enforcing"];
  return ["Settings", "Profiles and safety rules"];
}

function render() {
  if (!state) { app.innerHTML = '<p class="p-1 text-[12px] text-on-surface-variant">Loading…</p>'; return; }

  if ((view === "main" || view === "onboarding")) {
    view = shouldShowOnboarding() ? "onboarding" : (view === "onboarding" ? "main" : view);
  }

  const [title, subtitle] = headerFor(view);
  headerTitle.textContent = title;
  headerSubtitle.textContent = subtitle;
  backButton.classList.toggle("hidden", view === "main" || view === "onboarding" || view === "shieldDiscovery");

  if (view === "onboarding") app.innerHTML = renderOnboarding();
  else if (view === "shieldDiscovery") app.innerHTML = renderShieldDiscovery();
  else if (view === "main") app.innerHTML = renderMain();
  else if (view === "details") app.innerHTML = renderDetails();
  else if (view === "memory") app.innerHTML = renderMemory();
  else if (view === "shield") app.innerHTML = renderShield();
  else if (view === "shieldEnable") app.innerHTML = renderShieldEnable();
  else app.innerHTML = renderSettings();
}

function navigate(next) {
  // Reset the hook-chaining choice only when actually ENTERING the Enable
  // Shield confirmation screen, not on every re-render of it: render() also
  // runs on every backend state push (rescan, settings change, etc.) while
  // already sitting on this screen, and resetting there silently discarded
  // whatever the user had just selected before they could click Confirm.
  if (next === "shieldEnable" && view !== "shieldEnable") { shieldChainChoice = "leave"; }
  view = next;
  render();
}

backButton.addEventListener("click", () => navigate("main"));
document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-nav]");
  if (el) { navigate(el.dataset.nav); return; }
});
document.getElementById("rescanButton").addEventListener("click", () => send("rescan"));

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const issueAction = target.closest("[data-issue-action]");
  if (issueAction) { handleSuggestedAction(issueAction.dataset.issueAction); return; }

  if (target.closest("#copyContextButton")) { send("copyContextForAI"); return; }
  if (target.closest("#copyWorkspaceSummaryButton")) { send("copyWorkspaceSafetySummary"); return; }

  const selectRepoBtn = target.closest("[data-select-repo]");
  if (selectRepoBtn) { send("selectRepo", { id: selectRepoBtn.dataset.selectRepo }); navigate("details"); return; }

  // ---- Repo Memory ----
  // Drafts are updated live by the "input" listener below; these handlers
  // only ever READ the current draft and send it — they never clear it
  // themselves. Clearing happens exclusively in handleMemoryMutationResult
  // once the extension host confirms the mutation actually succeeded, so
  // a rejected (over-limit/empty) submission always leaves the user's
  // text exactly where they left it.
  if (target.closest("#addNoteButton")) { document.getElementById("newNoteText").focus(); return; }
  if (target.closest("#addNoteSubmit")) {
    const text = memoryNewNoteDraft.trim();
    if (text) {
      const requestId = nextMemoryRequestId();
      memoryPendingRequests[requestId] = { kind: "addNote" };
      send("addMemoryNote", { text, pinned: false, requestId });
    }
    return;
  }
  const editBtn = target.closest("[data-edit-note]");
  if (editBtn) {
    const id = editBtn.dataset.editNote;
    memoryEditingNoteId = id;
    const note = (state.memory.notes || []).find((n) => n.id === id);
    memoryEditDraft = note ? note.text : "";
    render();
    return;
  }
  if (target.closest("#editNoteCancel")) { memoryEditingNoteId = null; memoryEditDraft = ""; render(); return; }
  const saveBtn = target.closest("[data-save-note]");
  if (saveBtn) {
    const noteId = saveBtn.dataset.saveNote;
    const text = memoryEditDraft;
    const requestId = nextMemoryRequestId();
    memoryPendingRequests[requestId] = { kind: "editNote", noteId };
    send("updateMemoryNote", { id: noteId, text, requestId });
    return;
  }
  const pinBtn = target.closest("[data-pin-note]");
  if (pinBtn) { send("togglePinMemoryNote", { id: pinBtn.dataset.pinNote }); return; }
  const removeNoteBtn = target.closest("[data-remove-note]");
  if (removeNoteBtn) { send("removeMemoryNote", { id: removeNoteBtn.dataset.removeNote }); return; }

  if (target.closest("#exportMemoryButton")) { send("exportMemory"); return; }
  if (target.closest("#exportAllMemoryButton")) { send("exportAllMemory"); return; }
  if (target.closest("#importMemoryButton")) { send("importMemory"); return; }

  if (target.closest("#addCommandToggle")) { document.getElementById("newCommandLabel").focus(); return; }
  if (target.closest("#addCommandButton")) {
    const label = memoryNewCommandLabelDraft.trim();
    const command = memoryNewCommandDraft.trim();
    if (label && command) {
      const requestId = nextMemoryRequestId();
      memoryPendingRequests[requestId] = { kind: "addCommand" };
      send("addSavedCommand", { label, command, requestId });
    }
    return;
  }
  const runBtn = target.closest("[data-run-command]");
  if (runBtn) { send("runSavedCommand", { id: runBtn.dataset.runCommand }); return; }
  const copyBtn = target.closest("[data-copy-command]");
  if (copyBtn) { send("copySavedCommand", { id: copyBtn.dataset.copyCommand }); return; }
  const removeCmdBtn = target.closest("[data-remove-command]");
  if (removeCmdBtn) { send("removeSavedCommand", { id: removeCmdBtn.dataset.removeCommand }); return; }

  // ---- Settings: profiles ----
  const selectProfileBtn = target.closest("[data-select-profile]");
  if (selectProfileBtn) { selectedProfileId = selectProfileBtn.dataset.selectProfile; render(); return; }

  if (target.closest("#addProfileButton")) {
    const profile = { id: "profile-" + Date.now().toString(36), label: "New Profile", gitEmail: "", expectedRemoteOwners: [], exactRepos: [], expectedBranchPatterns: [], strictPushSetup: false, trustedSshHostAliases: [] };
    selectedProfileId = profile.id;
    send("saveProfile", { profile });
    return;
  }

  const removeChipBtn = target.closest("[data-remove-chip]");
  if (removeChipBtn) {
    const profile = currentProfile();
    if (profile) removeChip(profile.id, removeChipBtn.dataset.removeChip, removeChipBtn.dataset.removeChipValue);
    return;
  }

  if (target.closest("#detectFromRepoButton")) {
    const profile = currentProfile();
    const facts = state.facts || {};
    if (profile) {
      const container = document.querySelector('[data-profile-id="' + CSS.escape(profile.id) + '"]');
      if (container) {
        if (facts.effectiveGitName) container.querySelector('[data-field="gitName"]').value = facts.effectiveGitName;
        if (facts.effectiveGitEmail) container.querySelector('[data-field="gitEmail"]').value = facts.effectiveGitEmail;
      }
      if (facts.remoteOwner && !(profile.expectedRemoteOwners || []).includes(facts.remoteOwner)) {
        patchProfile(profile.id, { expectedRemoteOwners: [...(profile.expectedRemoteOwners || []), facts.remoteOwner] });
      }
    }
    return;
  }

  const saveProfileBtn = target.closest("[data-save-profile]");
  if (saveProfileBtn) {
    const id = saveProfileBtn.dataset.saveProfile;
    const profile = state.profiles.find((p) => p.id === id);
    const container = document.querySelector('[data-profile-id="' + CSS.escape(id) + '"]');
    const field = (name) => container.querySelector('[data-field="' + name + '"]');
    // Object.assign over the STORED profile, never over a fresh object:
    // every field this editor does not render (exactRepos,
    // expectedRemoteOwners, expectedBranchPatterns, trustedSshHostAliases,
    // and anything a future version adds) must survive a save untouched.
    // Chip fields are edited through patchProfile, which uses the same rule.
    //
    // expectedGitHubLogin is normalized empty-string -> undefined: leaving
    // the input blank must produce an ABSENT field, not "". A stored ""
    // would differ from the undefined a policy built before this field
    // existed baked in, and ShieldManager's profile-drift check would then
    // report permanent drift on a profile nobody actually changed.
    const expectedGitHubLogin = field("expectedGitHubLogin").value.trim();
    send("saveProfile", {
      profile: Object.assign({}, profile, {
        id,
        label: field("label").value.trim(),
        gitName: field("gitName").value.trim(),
        gitEmail: field("gitEmail").value.trim(),
        strictPushSetup: field("strictPushSetup").checked,
        expectedGitHubLogin: expectedGitHubLogin === "" ? undefined : expectedGitHubLogin,
      }),
    });
    return;
  }
  const deleteProfileBtn = target.closest("[data-delete-profile]");
  if (deleteProfileBtn) {
    selectedProfileId = null;
    send("deleteProfile", { id: deleteProfileBtn.dataset.deleteProfile });
    return;
  }

  if (target.closest("#saveBranchesButton")) {
    const branches = document.getElementById("protectedBranchesInput").value.split(",").map((s) => s.trim()).filter(Boolean);
    send("saveProtectedBranches", { branches });
    return;
  }
  if (target.closest("#openSettingsJsonButton")) { send("openSettingsJson"); return; }

  // ---- Shield ----
  if (target.closest("#shieldGoToEnableButton")) { navigate("shieldEnable"); return; }
  if (target.closest("#shieldEnableConfirmButton")) { send("enableShield", { chainForeignHooks: shieldChainChoice === "chain" }); navigate("main"); return; }
  if (target.closest("#shieldDisableButton")) { send("disableShield"); return; }
  if (target.closest("#shieldRepairButton")) { send("repairShield"); return; }
  if (target.closest("#shieldCheckHealthButton")) { send("checkShieldHealth"); return; }

  // ---- Onboarding ----
  const obLabelBtn = target.closest("[data-ob-label]");
  if (obLabelBtn) { obLabel = obLabelBtn.dataset.obLabel; render(); if (obLabel === "Other") document.getElementById("obCustomLabelInput").focus(); return; }
  if (target.closest("#obCreateButton")) { submitOnboarding(); return; }
  if (target.closest("#obEnableShieldButton")) { navigate("shieldEnable"); return; }
  if (target.closest("#obNotNowButton")) { navigate("main"); return; }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  // Ordinary Enter in these multiline textareas inserts a newline, like any
  // other text editor — only Ctrl/Cmd+Enter submits, so a multiline note
  // never gets cut short by an unexpectedly "helpful" Enter-to-save.
  if (target.id === "newNoteText" && (event.metaKey || event.ctrlKey)) { document.getElementById("addNoteSubmit").click(); return; }
  if (target.id === "editNoteText" && (event.metaKey || event.ctrlKey)) { document.getElementById("editNoteSave").click(); return; }
  const chipInput = target.closest("[data-add-chip]");
  if (chipInput) {
    const profile = currentProfile();
    if (profile) addChipFromInput(profile.id, chipInput.dataset.addChip, chipInput);
    event.preventDefault();
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.id === "requireLocalIdentityCheckbox") { send("saveRequireLocalIdentity", { value: target.checked }); return; }
  if (target.id === "includeMemoryCheckbox") { send("saveIncludeMemoryInAiContext", { value: target.checked }); return; }
  if (target.id === "obCustomLabelInput") { obCustomLabel = target.value; return; }
  if (target.name === "obScope") { obScope = target.value; return; }
  if (target.name === "shieldChain") { shieldChainChoice = target.value; render(); return; }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.id === "memorySearchInput") {
    // Refreshes ONLY the notes list container, not the whole Memory
    // screen (a full render() would replace this very input element and
    // lose focus/cursor position on every keystroke) — entirely local,
    // client-side filtering; nothing is sent to the extension and nothing
    // is persisted.
    memorySearchQuery = target.value;
    document.getElementById("notesListContainer").innerHTML = renderNotesList();
    return;
  }
  // These four just update the in-memory draft variable that renderMemory()
  // reads from — deliberately NOT re-rendering here (a full render() on
  // every keystroke would replace the very textarea/input being typed
  // into, same focus-loss problem as the search box above). The draft
  // survives any LATER unrelated re-render precisely because renderMemory()
  // always reads these variables rather than note.text/empty-string.
  if (target.id === "newNoteText") { memoryNewNoteDraft = target.value; return; }
  if (target.id === "editNoteText") { memoryEditDraft = target.value; return; }
  if (target.id === "newCommandLabel") { memoryNewCommandLabelDraft = target.value; return; }
  if (target.id === "newCommandText") { memoryNewCommandDraft = target.value; return; }
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "state") {
    const hadNoState = !state;
    state = message.payload;
    if (hadNoState && shouldShowOnboarding()) view = "onboarding";
    render();
  } else if (message.type === "memoryMutationResult") {
    handleMemoryMutationResult(message);
  }
});

render();
`;
