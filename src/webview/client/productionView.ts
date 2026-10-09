/**
 * PRODUCTION webview client — the real Repo Identity Guard sidebar UI.
 *
 * This replaces the placeholder client (formerly
 * `src/webview/client/placeholderView.ts`, now removed). It implements the
 * screens and interactions approved in `ui-prototype/` (a disposable,
 * frozen React+Vite visual/interaction reference — never imported, never
 * compiled, never packaged here) against the REAL backend contract built in
 * the prior "backend/UI bridge" phase: `RepoIdentityUiState`
 * (`src/ui/productionState.ts`) and the typed `WebviewMessage`/
 * `ExtensionMessage` protocol (`src/ui/protocol.ts`).
 *
 * Architecture (see "DEPENDENCIES" in the task spec): plain TypeScript/DOM,
 * no framework, no bundler — the smallest approach that can faithfully
 * reproduce the frozen UI. This file is authored as ordinary application
 * code but, like its placeholder predecessor, is embedded in the extension
 * as a single inline `<script nonce="...">` body (see
 * `src/ui/SidebarProvider.ts`): a webview has no module loader, and an
 * inline nonce'd script keeps the existing strict CSP (no `unsafe-inline`,
 * no external script origins) with zero added build tooling. It has no
 * `import`/`export` of its own; everything lives in one IIFE-free top-level
 * scope exactly like the placeholder did. The exported constant below is
 * read by `SidebarProvider.ts` and, in tests, executed directly inside a
 * `node:vm` sandbox against a fake DOM (see `src/test/productionWebview.test.ts`,
 * which follows the same pattern `src/test/placeholderWebview.test.ts` used) —
 * so this is tested as the REAL client code, not a reimplementation of it.
 *
 * Safety properties that matter and are tested:
 *  - XSS: every piece of user/repository data (note text, identity labels,
 *    repo names, reasons, emails) is inserted with `textContent` / `value`
 *    — never `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, or
 *    `new Function`. There is no `innerHTML` setter anywhere here.
 *  - No lost drafts: a note/identity draft lives on its own navigation
 *    stack frame, survives every `state` push untouched, and is cleared
 *    only once the matching `operationResult` ACK reports success — never
 *    merely because a `state` push arrived (see "OPERATION RESULT RULE").
 *  - No repository-picker: there is no `selectRepo` message anywhere in
 *    this file (there is no such message in the protocol at all) — the
 *    webview always renders whichever repository `state.payload.repo`
 *    names.
 *  - Repo-scoped screens (Identity Lock, Assign Identity, the assignment
 *    confirmation, Repo Notes, the note editor) are each bound to the
 *    repository id that was current when they were opened. If the
 *    CURRENT repository (`state.payload.repo.id`) changes while one of
 *    those screens is on top of the navigation stack, the app returns to
 *    the main screen — EXCEPT a dirty (unsaved) note editor, which is
 *    never silently discarded NOR silently re-targeted at the new
 *    repository: it stays open, bound to the ORIGINAL repository, with
 *    Save disabled and an explanatory notice, until the user explicitly
 *    discards or cancels. Global identity editing (Add/Edit/Manage
 *    Identities) is not repo-scoped and is never affected by a repository
 *    change. See `isRepoScopedStale()`.
 */
export const PRODUCTION_VIEW_JS = `
"use strict";
const vscodeApi = acquireVsCodeApi();

// ==================== wire helpers ====================

function post(message) {
  vscodeApi.postMessage(message);
}

let requestCounter = 0;
function nextRequestId() {
  requestCounter += 1;
  return "req-" + requestCounter + "-" + Date.now();
}

/** requestId -> { kind, repoId?, identityId?, noteId?, onSuccess(msg), onFailure(msg) }. Cleared on teardown (page unload) and as each ACK is correlated — see "REQUEST LIFECYCLE" in the task spec. */
const pending = new Map();

function sendRequest(base, handlers) {
  const requestId = nextRequestId();
  pending.set(requestId, handlers || {});
  const message = Object.assign({}, base, { requestId });
  post(message);
  render();
  return requestId;
}

/** True when some in-flight request matches \`match\` — used to disable only the ONE control a specific pending operation belongs to, never the whole extension. */
function isPending(match) {
  for (const handlers of pending.values()) {
    if (match(handlers)) return true;
  }
  return false;
}

window.addEventListener("unload", () => {
  pending.clear();
});

// ==================== dom helpers (no innerHTML, ever) ====================

function h(tag, props, children) {
  const node = document.createElement(tag);
  const p = props || {};
  if (p.className) node.className = p.className;
  if (p.id) node.id = p.id;
  if (p.title !== undefined) node.title = p.title;
  if (p.type) node.type = p.type;
  if (p.value !== undefined) node.value = p.value;
  if (p.placeholder !== undefined) node.placeholder = p.placeholder;
  if (p.rows !== undefined) node.rows = p.rows;
  if (p.disabled) {
    node.disabled = true;
    node.setAttribute("aria-disabled", "true");
  }
  if (p.autofocus) node.setAttribute("data-autofocus", "true");
  if (p.tabIndex !== undefined) node.tabIndex = p.tabIndex;
  if (p.attrs) {
    for (const key of Object.keys(p.attrs)) {
      const v = p.attrs[key];
      if (v === undefined || v === null || v === false) continue;
      node.setAttribute(key, v === true ? "true" : String(v));
    }
  }
  if (p.dataset) {
    for (const key of Object.keys(p.dataset)) node.dataset[key] = String(p.dataset[key]);
  }
  if (p.on) {
    // A falsy handler (e.g. a submit-type Button passed no onClick,
    // relying on the enclosing <form>'s native submit) must never reach
    // addEventListener — real browsers throw on addEventListener(type,
    // undefined), which would otherwise crash rendering outright.
    for (const type of Object.keys(p.on)) {
      const listener = p.on[type];
      if (typeof listener === "function") node.addEventListener(type, listener);
    }
  }
  for (const child of children || []) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function text(className, value, extra) {
  return h("span", Object.assign({ className: className, text: undefined }, extra), [String(value)]);
}

// Small helper so \`h()\`'s textContent-only leaf nodes read naturally.
function leaf(tag, className, value, extra) {
  const node = h(tag, Object.assign({ className: className }, extra), []);
  node.textContent = String(value);
  return node;
}

function frag(children) {
  const f = document.createDocumentFragment();
  for (const child of children || []) {
    if (child === null || child === undefined || child === false) continue;
    f.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return f;
}

// ==================== buttons / primitives ====================

const VARIANT_CLASS = {
  primary: "bg-primary-container text-on-primary-container hover:brightness-110",
  secondary: "bg-surface-container-high text-on-surface border border-outline-variant hover:bg-surface-container-highest",
  ghost: "text-primary hover:bg-surface-container-high",
  danger: "bg-error-container text-on-error-container hover:brightness-110",
  attention: "bg-tertiary/15 text-tertiary border border-tertiary/30 hover:bg-tertiary/25",
};

function Button(label, onClick, opts) {
  const o = opts || {};
  const variant = o.variant || "secondary";
  const size = o.size || "md";
  const sizeClass = size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]";
  const disabled = !!(o.disabled || o.loading);
  const children = [];
  if (o.loading) children.push(h("span", { className: "rig-spinner", attrs: { "aria-hidden": "true" } }, []));
  children.push(o.loading && o.loadingLabel ? o.loadingLabel : label);
  return h(
    "button",
    {
      type: o.type || "button",
      className:
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-primary transition-colors " +
        sizeClass +
        " " +
        VARIANT_CLASS[variant] +
        (o.block ? " w-full" : "") +
        (o.className ? " " + o.className : ""),
      disabled: disabled,
      attrs: o.ariaLabel ? { "aria-label": o.ariaLabel } : o.ariaExpanded !== undefined ? { "aria-expanded": o.ariaExpanded } : undefined,
      dataset: o.dataset,
      on: { click: onClick },
    },
    children,
  );
}

function LinkButton(label, onClick, extraClass) {
  return h(
    "button",
    {
      type: "button",
      className:
        "inline-flex items-center gap-1 font-body-sm text-body-sm text-primary hover:underline underline-offset-2 rounded focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-primary " +
        (extraClass || ""),
      on: { click: onClick },
    },
    [label],
  );
}

function InlineAction(label, onClick, ariaLabel) {
  return h(
    "button",
    {
      type: "button",
      className:
        "inline-flex items-center gap-1 h-7 px-1.5 rounded-lg font-label-sm text-label-sm text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-primary",
      attrs: { "aria-label": ariaLabel || label },
      on: { click: onClick },
    },
    [label],
  );
}

function Card(children, extraClass) {
  return h("section", { className: "rounded-xl bg-surface-container border border-outline-variant/40 p-space-md " + (extraClass || "") }, children);
}

function ListGroup(children) {
  return h("div", { className: "rounded-xl bg-surface-container border border-outline-variant/40 overflow-hidden divide-y divide-outline-variant/40" }, children);
}

const TONE_DOT = {
  success: "bg-secondary",
  warning: "bg-tertiary",
  error: "bg-error",
  neutral: "bg-outline",
  info: "bg-primary",
};

const TONE_BADGE = {
  success: "bg-secondary/10 text-secondary border-secondary/20",
  warning: "bg-tertiary/10 text-tertiary border-tertiary/25",
  error: "bg-error/10 text-error border-error/25",
  neutral: "bg-surface-container-highest text-on-surface-variant border-outline-variant",
  info: "bg-primary/10 text-primary border-primary/20",
};

const TONE_TILE = {
  success: "bg-secondary/10 text-secondary",
  warning: "bg-tertiary/10 text-tertiary",
  error: "bg-error/10 text-error",
  neutral: "bg-surface-container-highest text-on-surface-variant",
  info: "bg-primary/10 text-primary",
};

/** Status is NEVER conveyed by color alone: every badge/dot always carries the word too (see "ACCESSIBILITY"). */
function StatusBadge(tone, label) {
  return h("span", { className: "inline-flex items-center gap-1.5 h-5 px-2 rounded-full border whitespace-nowrap font-label-sm text-label-sm " + TONE_BADGE[tone] }, [
    h("span", { className: "h-1.5 w-1.5 rounded-full shrink-0 " + TONE_DOT[tone], attrs: { "aria-hidden": "true" } }, []),
    label,
  ]);
}

function IconTile(tone) {
  return h("span", { className: "h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-lg " + TONE_TILE[tone], attrs: { "aria-hidden": "true" } }, []);
}

function SectionLabel(labelText, action) {
  return h("div", { className: "flex items-center justify-between px-0.5 -mb-1" }, [
    leaf("h2", "font-label-sm text-label-sm uppercase tracking-wider text-outline", labelText),
    action || null,
  ]);
}

/** Label + chevron row for drill-down navigation. */
function NavRow(opts) {
  const large = !!opts.large;
  const quiet = !!opts.quiet;
  const chevron = opts.chevron !== false;
  const children = [];
  if (large) children.push(IconTile(opts.tone || "neutral"));
  const labelWrap = h("span", { className: "min-w-0 flex-1" }, []);
  const labelEl = leaf("span", "block truncate " + (large ? "font-title-md text-title-md" : "font-body-md text-body-md") + " " + (quiet ? "text-on-surface-variant" : "text-on-surface"), opts.label, { title: opts.label });
  labelWrap.appendChild(labelEl);
  if (opts.subtitle) {
    if (typeof opts.subtitle === "string") {
      labelWrap.appendChild(leaf("span", "block truncate font-body-sm text-body-sm text-on-surface-variant", opts.subtitle, { title: opts.subtitle }));
    } else {
      const sub = h("span", { className: "block truncate font-body-sm text-body-sm text-on-surface-variant" }, []);
      sub.appendChild(opts.subtitle);
      labelWrap.appendChild(sub);
    }
  }
  children.push(labelWrap);
  if (chevron) children.push(leaf("span", "text-outline shrink-0", "\\u203A", { attrs: { "aria-hidden": "true" } }));
  return h(
    "button",
    {
      type: "button",
      className:
        "w-full flex items-center gap-2.5 px-space-md text-left hover:bg-surface-container-high transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primary " +
        (large ? "py-2.5" : "py-2"),
      attrs: opts.ariaLabel ? { "aria-label": opts.ariaLabel } : undefined,
      on: { click: opts.onClick },
    },
    children,
  );
}

function AddRow(labelText, onClick) {
  return h(
    "button",
    {
      type: "button",
      className:
        "w-full h-9 flex items-center justify-center gap-1.5 rounded-xl rig-dashed border border-outline-variant text-on-surface-variant font-body-md text-body-md hover:bg-surface-container hover:text-on-surface hover:border-outline",
      on: { click: onClick },
    },
    ["+ " + labelText],
  );
}

function KeyValueList(rows, stacked) {
  const dl = h("dl", { className: "rounded-lg bg-surface-container-lowest border border-outline-variant/30 px-2.5 py-1.5" }, []);
  for (const row of rows) {
    const rowEl = h("div", { className: stacked ? "flex flex-col gap-0.5 py-1" : "flex items-baseline justify-between gap-3 py-1" }, []);
    rowEl.appendChild(leaf("dt", "shrink-0 font-label-sm text-label-sm text-outline", row.k));
    const dd = h("dd", { className: "min-w-0 break-words text-on-surface " + (stacked ? "" : "text-right ") + (row.mono ? "font-code-sm text-code-sm" : "font-body-sm text-body-sm") }, []);
    dd.textContent = String(row.v);
    rowEl.appendChild(dd);
    dl.appendChild(rowEl);
  }
  return dl;
}

/** Collapsed-by-default "Details" drawer. \`open\` is a plain object ref (\`{value:false}\`) the caller owns, so re-renders preserve the open/closed state across repaints. */
function Collapsible(openRef, children, labelText) {
  const body = openRef.value ? h("div", { className: "px-2.5 pb-2.5 flex flex-col gap-2" }, children) : null;
  const toggle = h(
    "button",
    {
      type: "button",
      className: "w-full h-8 flex items-center gap-1.5 px-2.5 font-body-sm text-body-sm text-on-surface-variant hover:text-on-surface",
      attrs: { "aria-expanded": openRef.value },
      on: {
        click: () => {
          openRef.value = !openRef.value;
          render();
        },
      },
    },
    [h("span", { className: "flex-1 text-left" }, [labelText || "Details"]), leaf("span", "text-outline", openRef.value ? "\\u25B4" : "\\u25BE", { attrs: { "aria-hidden": "true" } })],
  );
  return h("div", { className: "rounded-lg border border-outline-variant/40 bg-surface-container-low" }, [toggle, body]);
}

// ==================== identity card ====================

function identityAvatar(identity, size) {
  const s = size || 32;
  const el = h("span", { className: "shrink-0 inline-flex items-center justify-center rounded-full bg-surface-container-highest text-primary font-title-md text-title-md", attrs: { "aria-hidden": "true" } }, []);
  el.style.width = s + "px";
  el.style.height = s + "px";
  el.textContent = (identity.label.trim().charAt(0) || "?").toUpperCase();
  return el;
}

function IdentityCard(identity, opts) {
  const o = opts || {};
  const compact = !!o.compact;
  const body = [identityAvatar(identity, compact ? 26 : 32)];
  const info = h("span", { className: "min-w-0 flex-1" }, []);
  info.appendChild(leaf("span", "block truncate font-title-md text-title-md text-on-surface", identity.label, { title: identity.label }));
  if (o.showGitName && identity.gitName) {
    info.appendChild(leaf("span", "block truncate font-body-sm text-body-sm text-on-surface-variant", identity.gitName, { title: identity.gitName }));
  }
  info.appendChild(leaf("span", "block truncate font-code-sm text-code-sm text-on-surface-variant", identity.gitEmail, { title: identity.gitEmail }));
  if (!compact) {
    const ghLabel = "GitHub \\u00B7 " + (identity.githubUsername || "not set");
    info.appendChild(leaf("span", "block truncate font-label-sm text-label-sm text-outline", ghLabel, { title: ghLabel }));
  }
  body.push(info);
  if (o.trailing) body.push(o.trailing);
  else if (o.onClick) body.push(leaf("span", "text-outline shrink-0", "\\u203A", { attrs: { "aria-hidden": "true" } }));
  const cls =
    "w-full flex items-center gap-2.5 text-left rounded-xl border border-outline-variant/40 " + (compact ? "px-2.5 py-2 bg-surface-container-low" : "p-space-md bg-surface-container");
  if (!o.onClick) return h("div", { className: cls }, body);
  return h(
    "button",
    { type: "button", className: cls + " hover:bg-surface-container-high hover:border-outline-variant transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary", on: { click: o.onClick } },
    body,
  );
}

// ==================== header / screen shell ====================

function Header(opts) {
  const left = opts.onBack
    ? h("button", { type: "button", className: "h-7 w-7 inline-flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface", attrs: { "aria-label": "Back" }, on: { click: opts.onBack } }, [
        leaf("span", "", "\\u2039", { attrs: { "aria-hidden": "true" } }),
      ])
    : h("span", { className: "w-1" }, []);
  const titleWrap = h("div", { className: "min-w-0 flex-1 px-1" }, []);
  titleWrap.appendChild(leaf("h1", "font-headline-sm text-headline-sm text-on-surface truncate", opts.title, { title: opts.title }));
  if (opts.subtitle) titleWrap.appendChild(leaf("p", "font-label-sm text-label-sm text-on-surface-variant truncate", opts.subtitle, { title: opts.subtitle }));
  const children = [left, titleWrap];
  if (opts.actions) children.push(h("div", { className: "flex items-center gap-0.5" }, opts.actions));
  return h("header", { className: "h-12 shrink-0 flex items-center gap-1 px-1.5 border-b border-outline-variant/50 bg-surface-container-low" }, children);
}

function IconButton(labelText, onClick, active, glyph) {
  return h(
    "button",
    {
      type: "button",
      className:
        "h-7 w-7 inline-flex items-center justify-center rounded-lg transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary " +
        (active ? "bg-surface-container-highest text-on-surface" : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"),
      attrs: { "aria-label": labelText, title: labelText },
      on: { click: onClick },
    },
    [glyph || "\\u22EF"],
  );
}

/** Overflow ("more actions") menu — a plain button + absolutely positioned list, closed on outside click, Escape, or item selection. */
function OverflowMenu(items, ariaLabel) {
  const wrap = h("div", { className: "relative" }, []);
  let open = false;
  let menuEl = null;
  function close() {
    open = false;
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
    document.removeEventListener("mousedown", onDocDown);
    document.removeEventListener("keydown", onDocKey);
  }
  function onDocDown(e) {
    if (!wrap.contains(e.target)) close();
  }
  function onDocKey(e) {
    if (e.key === "Escape") close();
  }
  const trigger = IconButton(ariaLabel || "More actions", () => {
    if (open) {
      close();
      return;
    }
    open = true;
    menuEl = h("div", { className: "absolute right-0 top-8 z-30 min-w-[168px] py-1 rounded-lg bg-surface-container-highest border border-outline-variant shadow-xl shadow-black/40", attrs: { role: "menu" } }, []);
    for (const item of items) {
      menuEl.appendChild(
        h(
          "button",
          {
            type: "button",
            className: "w-full flex items-center gap-2 px-2.5 h-7 text-left font-body-sm text-body-sm hover:bg-surface-bright " + (item.danger ? "text-error" : "text-on-surface"),
            attrs: { role: "menuitem" },
            on: {
              click: () => {
                close();
                item.onSelect();
              },
            },
          },
          [item.label],
        ),
      );
    }
    wrap.appendChild(menuEl);
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onDocKey);
  });
  wrap.appendChild(trigger);
  return wrap;
}

function Screen(opts) {
  const root = h("div", { className: "flex flex-col h-full min-h-0" }, [opts.header]);
  if (opts.subheader) root.appendChild(h("div", { className: "shrink-0 px-margin pt-space-md" }, [opts.subheader]));
  const main = h("main", { className: "custom-scrollbar flex-1 min-h-0 overflow-y-auto px-margin py-space-md", attrs: { tabIndex: -1 } }, []);
  main.appendChild(h("div", { className: "flex flex-col gap-space-md pb-6" }, opts.children));
  root.appendChild(main);
  if (opts.footer) root.appendChild(h("footer", { className: "shrink-0 px-margin py-2 border-t border-outline-variant/40 font-label-sm text-label-sm text-outline" }, [opts.footer]));
  return root;
}

// ==================== app state ====================

/** \`state.payload\` from the extension host — see src/ui/productionState.ts's RepoIdentityUiState. */
let state = null;

const REPO_SCOPED = { identityLock: true, assignIdentity: true, assignmentConfirm: true, repoNotes: true, addNote: true, editNote: true };

let nav = [{ name: "menu" }];
/** A single modal overlay (delete identity / discard draft) — never more than one at a time, matching the frozen prototype. */
let overlay = null;
let toast = null;
let toastTimer = null;
/** noteId -> true while its "\\u2713 Copied" feedback is showing. */
const copiedNotes = new Map();

function currentRepoId() {
  return state && state.repo ? state.repo.id : undefined;
}

function top() {
  return nav[nav.length - 1];
}

function navPush(route) {
  nav.push(route);
  render();
}

function navPop() {
  if (nav.length > 1) nav.pop();
  render();
}

function navPopTo(name) {
  for (let i = nav.length - 1; i >= 0; i--) {
    if (nav[i].name === name) {
      nav.length = i + 1;
      render();
      return;
    }
  }
  nav = [{ name: "menu" }];
  render();
}

function navReset() {
  nav = [{ name: "menu" }];
  render();
}

function isNoteEditorDirty(route) {
  return route.text !== route.original;
}

/** See this file's top doc comment, "Repo-scoped screens...". Mutates \`nav\` in place when a frame must be discarded; a dirty note editor is left exactly as it is (its own render shows a stale-repo notice instead). Returns true when the top frame is a dirty note editor bound to a repository that is no longer current (the caller must not let it submit). */
function reconcileNavForCurrentRepo() {
  const frame = top();
  if (!frame || !REPO_SCOPED[frame.name]) return false;
  if (frame.repoId === undefined || frame.repoId === currentRepoId()) return false;
  if (frame.name === "addNote" || frame.name === "editNote") {
    return true; // stale but dirty-or-not, the editor's own render decides; signal staleness either way
  }
  nav = [{ name: "menu" }];
  return false;
}

function showToast(message, tone) {
  toast = { message: message, tone: tone || "success", id: Date.now() + Math.random() };
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast = null;
    render();
  }, 2600);
  render();
}

function openOverlay(data) {
  overlay = data;
  render();
}

function closeOverlay() {
  overlay = null;
  render();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && overlay) {
    closeOverlay();
  }
});

// ==================== field (form input) ====================

function Field(opts) {
  const inputId = opts.id || "field-" + opts.label.toLowerCase().replace(/\\s+/g, "-");
  const wrap = h("div", { className: "flex flex-col gap-1" }, []);
  const labelEl = h("label", { attrs: { for: inputId }, className: "font-label-sm text-label-sm text-on-surface-variant inline-flex items-center gap-1" }, [opts.label]);
  if (opts.required) labelEl.appendChild(leaf("span", "text-primary", "*", { attrs: { "aria-hidden": "true", title: "Required" } }));
  wrap.appendChild(labelEl);
  const describedBy = opts.error ? inputId + "-msg" : opts.note ? inputId + "-note" : opts.hint ? inputId + "-hint" : undefined;
  const input = h("input", {
    id: inputId,
    className:
      "w-full h-8 rounded-lg bg-surface-container-lowest border px-2.5 text-on-surface placeholder:text-outline/70 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 " +
      (opts.error ? "border-error" : opts.highlight ? "border-tertiary ring-1 ring-tertiary/40" : "border-outline-variant") +
      " " +
      (opts.mono ? "font-code-sm text-code-sm" : "font-body-md text-body-md"),
    type: opts.type || "text",
    value: opts.value,
    placeholder: opts.placeholder,
    attrs: Object.assign({ "aria-invalid": !!opts.error, "aria-required": opts.required || undefined, "aria-describedby": describedBy }, opts.spellCheck === false ? { spellcheck: "false" } : {}),
    autofocus: opts.autoFocus,
    on: Object.assign(
      {
        input: (e) => {
          opts.onChange(e.target.value);
        },
      },
      opts.onBlur ? { blur: opts.onBlur } : {},
    ),
  });
  wrap.appendChild(h("div", { className: "relative" }, [input]));
  if (opts.error) wrap.appendChild(leaf("p", "font-label-sm text-label-sm text-error", opts.error, { id: inputId + "-msg" }));
  else if (opts.note) wrap.appendChild(leaf("p", "font-label-sm text-label-sm text-tertiary", opts.note, { id: inputId + "-note" }));
  else if (opts.hint) wrap.appendChild(leaf("p", "font-label-sm text-label-sm text-outline", opts.hint, { id: inputId + "-hint" }));
  return wrap;
}

// ==================== formatting ====================

function formatTimestamp(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch (e) {
    return "";
  }
}

function relativeTime(ms, now) {
  const diff = Math.max(0, now - ms);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.round(hours / 24);
  if (days < 30) return days + "d ago";
  return formatTimestamp(ms);
}

function plural(n, singular, pluralWord) {
  return n + " " + (n === 1 ? singular : pluralWord);
}

const EMAIL_RE = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;

// ==================== main screen ====================

function renderMain() {
  if (!state || !state.repo) return renderNoRepo();
  const lock = state.lock;
  const tone = lock.state === "locked" ? "success" : lock.state === "needs_attention" ? "warning" : lock.state === "repair" ? "error" : "neutral";
  const word = lock.state === "locked" ? "Locked" : lock.state === "needs_attention" ? "Needs attention" : lock.state === "repair" ? "Needs repair" : "Unassigned";
  const label = lock.identity ? word + " \\u00B7 " + lock.identity.label : word;
  const summary = h("span", { className: "inline-flex items-center gap-1.5" }, [h("span", { className: "h-1.5 w-1.5 rounded-full shrink-0 " + TONE_DOT[tone], attrs: { "aria-hidden": "true" } }, []), label]);

  return Screen({
    header: Header({ title: "Repo Identity Guard", subtitle: state.repo.name }),
    children: [
      ListGroup([
        NavRow({ large: true, tone: tone, label: "Identity Lock", subtitle: summary, onClick: () => openIdentityLock() }),
        NavRow({ large: true, tone: "info", label: "Repo Notes", subtitle: plural(state.notes.length, "note", "notes"), onClick: () => openRepoNotes() }),
      ]),
    ],
  });
}

function renderNoRepo() {
  return Screen({
    header: Header({ title: "Repo Identity Guard" }),
    children: [
      h("div", { className: "mt-6 flex flex-col items-center text-center gap-2 px-space-sm" }, [
        leaf("h2", "font-title-md text-title-md text-on-surface", "No Git repository is open."),
        leaf("p", "font-body-sm text-body-sm text-on-surface-variant max-w-[240px]", "Open a Git repository to use Identity Lock and Repo Notes."),
        Button("Open Folder", () => post({ type: "openFolder" }), { variant: "primary", className: "mt-2" }),
      ]),
    ],
  });
}

function openIdentityLock() {
  navPush({ name: "identityLock", repoId: currentRepoId(), changingIdentity: false, confirmingUnlock: false, repairFailedMessage: null, detailsOpen: { value: false } });
}

function openRepoNotes() {
  navPush({ name: "repoNotes", repoId: currentRepoId(), searchQuery: "", searchOpen: false, confirmDeleteId: null });
}

// ==================== identity lock ====================

function findIdentity(id) {
  return (state.identities || []).find((i) => i.id === id);
}

function renderIdentityLock(route) {
  const stale = route.repoId !== currentRepoId();
  const repoName = state && state.repo ? state.repo.name : "";
  const lock = state.lock;
  const actions = [];
  if (lock.state === "locked" && lock.identity) {
    actions.push(
      OverflowMenu(
        [
          {
            label: "Verify lock",
            onSelect: () => {
              sendRequest({ type: "verifyLock" }, {
                kind: "verifyLock",
                repoId: route.repoId,
                onSuccess: (msg) => showToast(msg.message || "Lock verified", "success"),
                onFailure: (msg) => showToast(msg.message || "Could not verify the lock.", "info"),
              });
            },
          },
        ],
        "More Identity Lock actions",
      ),
    );
  }
  const header = Header({ title: "Identity Lock", subtitle: repoName, onBack: navPop, actions: actions.length ? actions : undefined });

  let body;
  if (stale) {
    body = [Card([leaf("p", "font-body-sm text-body-sm text-on-surface-variant", "The current repository changed.")])];
  } else if (lock.state === "unassigned") {
    body = renderUnassigned();
  } else if (lock.state === "needs_attention") {
    body = renderNeedsAttention(route, lock, repoName);
  } else if (lock.state === "repair") {
    body = renderRepair(route, lock, repoName);
  } else {
    body = renderLocked(route, lock, repoName);
  }
  return Screen({ header: header, children: body });
}

function renderUnassigned() {
  return [
    Card([
      h("div", { className: "flex items-start gap-2.5" }, [
        IconTile("neutral"),
        h("div", { className: "min-w-0 flex-1" }, [
          leaf("h2", "font-title-md text-title-md text-on-surface", "No identity assigned"),
          leaf("div", "mt-0.5 font-body-sm text-body-sm text-on-surface-variant", "Git is unrestricted in this repository. Repo Identity Guard won't interfere with commits or pushes."),
        ]),
      ]),
      Button("Assign identity", () => navPush({ name: "assignIdentity", repoId: currentRepoId() }), { variant: "primary", block: true, className: "mt-space-md" }),
      h("div", { className: "mt-2.5 flex justify-center" }, [LinkButton("Manage identities", () => navPush({ name: "manageIdentities" }))]),
    ]),
  ];
}

function UnlockRow(route) {
  if (!route.confirmingUnlock) {
    return NavRow({ icon: "lock_open", label: "Unlock repository", quiet: true, chevron: false, onClick: () => { route.confirmingUnlock = true; render(); } });
  }
  const repoName = state.repo.name;
  const pendingUnlock = isPending((h) => h.kind === "unlockRepository" && h.repoId === route.repoId);
  return h("div", { className: "px-space-md py-2.5 bg-surface-container-low flex flex-col gap-0.5" }, [
    leaf("p", "font-title-md text-title-md text-on-surface", "Unlock this repository?"),
    leaf("p", "font-body-sm text-body-sm text-on-surface-variant", "Repo Identity Guard will stop restricting commits and pushes in " + repoName + "."),
    leaf("p", "font-body-sm text-body-sm text-on-surface-variant", "Your Repo Notes will be kept."),
    h("div", { className: "mt-2 flex flex-wrap justify-end gap-2" }, [
      Button("Cancel", () => { route.confirmingUnlock = false; render(); }, { size: "sm", variant: "secondary" }),
      Button(
        "Unlock repository",
        () => {
          sendRequest({ type: "unlockRepository" }, {
            kind: "unlockRepository",
            repoId: route.repoId,
            onSuccess: (msg) => {
              route.confirmingUnlock = false;
              showToast((state.repo ? state.repo.name : "Repository") + " unlocked", "info");
            },
            onFailure: (msg) => {
              route.confirmingUnlock = false;
              showToast(msg.message || "Couldn't unlock this repository.", "info");
            },
          });
        },
        { size: "sm", variant: "attention", loading: pendingUnlock },
      ),
    ]),
  ]);
}

function renderLocked(route, lock, repoName) {
  const identity = lock.identity;
  const others = (state.identities || []).filter((i) => i.id !== identity.id);
  const rows = [
    { k: "Name", v: identity.gitName || "\\u2014" },
    { k: "Git email", v: identity.gitEmail, mono: true },
    { k: "GitHub", v: identity.githubUsername || "Not set", mono: true },
  ];
  const pickerChildren = [];
  if (route.changingIdentity) {
    pickerChildren.push(leaf("p", "font-label-sm text-label-sm text-outline px-0.5", "Switch " + repoName + " to"));
    for (const o of others) {
      pickerChildren.push(IdentityCard(o, { compact: true, onClick: () => navPush({ name: "assignmentConfirm", repoId: route.repoId, identityId: o.id }) }));
    }
    if (others.length === 0) pickerChildren.push(leaf("p", "font-body-sm text-body-sm text-on-surface-variant px-0.5", "No other identities yet."));
    pickerChildren.push(h("div", { className: "px-0.5 pt-0.5" }, [LinkButton("+ Add identity", () => navPush({ name: "addIdentity", draft: emptyIdentityDraft(), touched: {}, submitted: false }))]));
  }
  return [
    Card(
      [
        h("div", { className: "flex items-start gap-2.5" }, [
          IconTile("success"),
          h("div", { className: "min-w-0 flex-1" }, [
            h("div", { className: "flex items-start justify-between gap-2 flex-wrap" }, [leaf("h2", "font-title-md text-title-md text-on-surface pt-[1px]", identity.label), StatusBadge("success", "Locked")]),
            leaf("div", "mt-0.5 font-body-sm text-body-sm text-on-surface-variant", "Commits and pushes in " + repoName + " must use this identity."),
          ]),
        ]),
        KeyValueList(rows, false, "mt-space-md"),
        Button(
          route.changingIdentity ? "Cancel" : "Change identity",
          () => { route.changingIdentity = !route.changingIdentity; render(); },
          { block: true, className: "mt-space-md", ariaExpanded: route.changingIdentity },
        ),
      ].concat(pickerChildren.length ? [h("div", { className: "mt-2 flex flex-col gap-1.5" }, pickerChildren)] : []),
    ),
    ListGroup([NavRow({ icon: "tune", label: "Manage identities", onClick: () => navPush({ name: "manageIdentities" }) }), UnlockRow(route)]),
  ];
}

function renderNeedsAttention(route, lock, repoName) {
  const identity = lock.identity;
  if (!identity) {
    return [
      Card([
        h("div", { className: "flex items-start gap-2.5" }, [IconTile("warning"), h("div", { className: "min-w-0 flex-1" }, [leaf("h2", "font-title-md text-title-md text-on-surface", "Needs attention"), StatusBadge("warning", "Needs attention")])]),
        leaf("p", "mt-space-md font-body-sm text-body-sm text-on-surface-variant", "This repository's identity lock needs attention."),
      ]),
    ];
  }
  if (lock.cause === "push_identity_incomplete") return renderIncompleteSetup(route, lock, identity);
  if (lock.cause === "git_identity_mismatch") return renderGitMismatch(route, lock, identity, repoName);
  if (lock.cause === "push_identity_unverifiable") return renderPushUnverifiable(route, lock, identity, repoName);
  if (lock.cause === "identity_missing") {
    return [
      Card([
        h("div", { className: "flex items-start gap-2.5" }, [IconTile("warning"), h("div", { className: "min-w-0 flex-1" }, [leaf("h2", "font-title-md text-title-md text-on-surface", identity.label), StatusBadge("warning", "Needs attention")])]),
        leaf("p", "mt-space-md font-body-md text-body-md text-on-surface", "The identity this repository was locked to no longer exists in settings."),
        Button("Assign a new identity", () => navPush({ name: "assignIdentity", repoId: route.repoId }), { variant: "primary", block: true, className: "mt-space-md" }),
      ]),
      ListGroup([UnlockRow(route)]),
    ];
  }
  // "other" — no specific actionable cause the backend can prove.
  return [
    Card([
      h("div", { className: "flex items-start gap-2.5" }, [IconTile("warning"), h("div", { className: "min-w-0 flex-1" }, [leaf("h2", "font-title-md text-title-md text-on-surface", identity.label), StatusBadge("warning", "Needs attention")])]),
      leaf("p", "mt-space-md font-body-sm text-body-sm text-on-surface-variant", "This repository's identity lock needs attention, but the exact cause couldn't be determined right now."),
    ]),
    ListGroup([UnlockRow(route)]),
  ];
}

function renderGitMismatch(route, lock, identity, repoName) {
  const detail = lock.detail || {};
  const pendingApply = isPending((h) => h.kind === "applyAssignedIdentity" && h.repoId === route.repoId);
  const detailsOpen = route.detailsOpen || (route.detailsOpen = { value: false });
  return [
    Card([
      h("div", { className: "flex items-start gap-2.5" }, [IconTile("warning"), h("div", { className: "min-w-0 flex-1" }, [leaf("h2", "font-title-md text-title-md text-on-surface", identity.label), StatusBadge("warning", "Needs attention")])]),
      h("p", { className: "mt-space-md font-body-md text-body-md text-on-surface" }, [
        "This repository is locked to ",
        leaf("span", "font-semibold", identity.label),
        ", but Git is currently using:",
      ]),
      h("div", { className: "mt-2 rounded-lg bg-surface-container-lowest border border-outline-variant/30 px-2.5 py-2 flex flex-col gap-1" }, [
        h("div", { className: "flex items-start gap-1.5 font-code-sm text-code-sm text-tertiary min-w-0" }, [leaf("span", "min-w-0 break-all", detail.effectiveGitEmail || "(unknown)")]),
        h("div", { className: "flex items-start gap-1.5 font-code-sm text-code-sm min-w-0" }, [
          h("span", { className: "min-w-0 break-all text-on-surface" }, [leaf("span", "text-outline", "Expected: "), detail.expectedGitEmail || identity.gitEmail]),
        ]),
      ]),
      leaf("p", "mt-2 font-body-sm text-body-sm text-on-surface-variant", "Commits in " + repoName + " are blocked until Git uses the " + identity.label + " identity."),
      Button(
        pendingApply ? "Applying\\u2026" : "Use " + identity.label + " identity",
        () => {
          sendRequest({ type: "applyAssignedIdentity" }, {
            kind: "applyAssignedIdentity",
            repoId: route.repoId,
            onSuccess: (msg) => showToast(msg.message || "Now using " + identity.label, "success"),
            onFailure: (msg) => showToast(msg.message || "Couldn't update the Git identity.", "info"),
          });
        },
        { variant: "primary", block: true, className: "mt-space-md", loading: pendingApply },
      ),
      h("div", { className: "mt-2.5" }, [
        Collapsible(
          detailsOpen,
          [
            KeyValueList(
              [
                { k: "Git is using", v: detail.effectiveGitEmail || "(unknown)", mono: true },
                { k: "Expected", v: detail.expectedGitEmail || identity.gitEmail, mono: true },
              ],
              true,
            ),
            leaf("p", "font-body-sm text-body-sm text-on-surface-variant", "\\"Use " + identity.label + " identity\\" sets the Git identity for this repository only."),
          ],
          "Details",
        ),
      ]),
    ]),
    ListGroup([UnlockRow(route)]),
  ];
}

function renderPushUnverifiable(route, lock, identity, repoName) {
  const detailsOpen = route.detailsOpen || (route.detailsOpen = { value: false });
  return [
    Card([
      h("div", { className: "flex items-start gap-2.5" }, [IconTile("warning"), h("div", { className: "min-w-0 flex-1" }, [leaf("h2", "font-title-md text-title-md text-on-surface", identity.label), StatusBadge("warning", "Needs attention")])]),
      leaf("p", "mt-space-md font-body-md text-body-md text-on-surface", "Repo Identity Guard can't currently verify pushes for " + identity.label + "."),
      leaf("p", "mt-1 font-body-sm text-body-sm text-on-surface-variant", "Commits can still use " + identity.label + ", but every push is blocked until this can be verified."),
      h("div", { className: "mt-2.5" }, [
        Collapsible(
          detailsOpen,
          [
            KeyValueList(
              [
                { k: "GitHub username", v: identity.githubUsername || "Not set" },
                { k: "SSH profiles", v: (identity.sshAliases || []).join(", ") || "None" },
              ],
              true,
            ),
          ],
          "Details",
        ),
      ]),
    ]),
    ListGroup([NavRow({ icon: "tune", label: "Manage identities", onClick: () => navPush({ name: "manageIdentities" }) }), UnlockRow(route)]),
  ];
}

const FIELD_LABEL = { githubUsername: "GitHub username", sshProfile: "SSH profile" };

function renderIncompleteSetup(route, lock, identity) {
  const detail = lock.detail || {};
  const missing = [];
  if (detail.missingGitHubUsername) missing.push("githubUsername");
  if (detail.missingSshProfile) missing.push("sshProfile");
  const missingLabel = missing.map((f) => FIELD_LABEL[f]).join(" and ");
  const detailsOpen = route.detailsOpen || (route.detailsOpen = { value: false });
  return [
    Card([
      h("div", { className: "flex items-start gap-2.5" }, [IconTile("warning"), h("div", { className: "min-w-0 flex-1" }, [leaf("h2", "font-title-md text-title-md text-on-surface", identity.label), StatusBadge("warning", "Needs attention")])]),
      leaf("p", "mt-space-md font-body-md text-body-md text-on-surface", "Push verification isn't configured yet."),
      leaf("p", "mt-1 font-body-sm text-body-sm text-on-surface-variant", "Add the " + missingLabel + " used by " + identity.label + " before pushing."),
      Button(
        "Finish setup",
        () => navPush({ name: "editIdentity", identityId: identity.id, draft: draftFromIdentity(identity), touched: {}, submitted: false, highlightMissing: true }),
        { variant: "primary", block: true, className: "mt-space-md" },
      ),
      h("div", { className: "mt-2.5" }, [
        Collapsible(
          detailsOpen,
          [
            KeyValueList(
              [
                { k: "Identity", v: identity.label },
                { k: "Missing", v: missingLabel || "Nothing" },
              ],
              true,
            ),
            leaf("p", "font-body-sm text-body-sm text-on-surface-variant", "Commits can still use " + identity.label + ", but Repo Identity Guard can't verify pushes until this identity has a GitHub username and an SSH profile."),
          ],
          "Details",
        ),
      ]),
    ]),
    ListGroup([UnlockRow(route)]),
  ];
}

function renderRepair(route, lock, repoName) {
  const identity = lock.identity;
  const pendingRepair = isPending((h) => h.kind === "repairLock" && h.repoId === route.repoId);
  const detailsOpen = route.detailsOpen || (route.detailsOpen = { value: false });

  if (route.repairFailedMessage) {
    return [
      Card([
        h("div", { className: "flex items-start gap-2.5" }, [IconTile("error"), h("div", { className: "min-w-0 flex-1" }, [leaf("h2", "font-title-md text-title-md text-on-surface", "Repair failed"), StatusBadge("error", "Needs repair")])]),
        leaf("p", "mt-space-md font-body-sm text-body-sm text-on-surface-variant", "Repo Identity Guard still can't enforce this repository's identity."),
        Button(
          pendingRepair ? "Repairing\\u2026" : "Try again",
          () => doRepair(route),
          { variant: "primary", block: true, className: "mt-space-md", loading: pendingRepair },
        ),
        h("div", { className: "mt-2.5" }, [Collapsible(detailsOpen, [leaf("p", "font-body-sm text-body-sm text-on-surface-variant", route.repairFailedMessage)], "Details")]),
      ]),
    ];
  }

  const reasons = (lock.detail && lock.detail.reasons) || [];
  return [
    Card([
      h("div", { className: "flex items-start gap-2.5" }, [IconTile("error"), h("div", { className: "min-w-0 flex-1" }, [leaf("h2", "font-title-md text-title-md text-on-surface", "Identity lock needs repair")])]),
      leaf("p", "mt-space-md font-body-sm text-body-sm text-on-surface-variant", "Repo Identity Guard can't currently enforce this repository's identity."),
      leaf("p", "font-body-sm text-body-sm text-on-surface-variant", "Repair restores local identity enforcement. Your commits and Repo Notes won't be changed."),
      Button(
        pendingRepair ? "Repairing\\u2026" : "Repair",
        () => doRepair(route),
        { variant: "primary", block: true, className: "mt-space-md", loading: pendingRepair, disabled: !lock.detail || lock.detail.repairAvailable === false },
      ),
      reasons.length ? h("div", { className: "mt-2.5" }, [Collapsible(detailsOpen, [KeyValueList(reasons.map((r, i) => ({ k: "Reason " + (i + 1), v: r })), true)], "Details")]) : null,
    ]),
  ];
}

function doRepair(route) {
  route.repairFailedMessage = null;
  sendRequest({ type: "repairLock" }, {
    kind: "repairLock",
    repoId: route.repoId,
    onSuccess: (msg) => {
      showToast(msg.message || "Identity lock restored.", "success");
    },
    onFailure: (msg) => {
      route.repairFailedMessage = msg.message || "Repo Identity Guard still can't enforce this repository's identity.";
      render();
    },
  });
}

// ==================== assign identity / confirm ====================

function renderAssignIdentity(route) {
  const repoName = state.repo.name;
  const header = Header({ title: "Assign identity", subtitle: repoName, onBack: navPop });
  const identities = state.identities || [];
  if (identities.length === 0) {
    return Screen({
      header: header,
      children: [
        h("div", { className: "mt-2 flex flex-col items-center text-center gap-2 rounded-xl rig-dashed border border-outline-variant px-space-lg py-space-xl" }, [
          leaf("h2", "font-title-md text-title-md text-on-surface", "No identities yet."),
          leaf("p", "font-body-sm text-body-sm text-on-surface-variant max-w-[240px]", "Create an identity first, then assign it to this repository."),
          Button("Add identity", () => navPush({ name: "addIdentity", draft: emptyIdentityDraft(), touched: {}, submitted: false }), { size: "sm", variant: "primary", className: "mt-1" }),
        ]),
      ],
    });
  }
  const currentId = state.lock.identity ? state.lock.identity.id : undefined;
  const cards = identities.map((identity) => {
    const current = identity.id === currentId;
    const trailing = current ? StatusBadge("success", "Current") : !identity.complete ? StatusBadge("warning", "Setup incomplete") : undefined;
    return IdentityCard(identity, { compact: identities.length > 4, onClick: () => navPush({ name: "assignmentConfirm", repoId: route.repoId, identityId: identity.id }), trailing: trailing });
  });
  return Screen({
    header: header,
    children: [
      leaf("p", "font-body-md text-body-md text-on-surface-variant px-0.5", "Choose an identity for this repository."),
      h("div", { className: "flex flex-col gap-2" }, cards.concat([AddRow("Add identity", () => navPush({ name: "addIdentity", draft: emptyIdentityDraft(), touched: {}, submitted: false }))])),
      h("div", { className: "flex justify-center" }, [LinkButton("Manage identities", () => navPush({ name: "manageIdentities" }))]),
    ],
  });
}

function renderAssignmentConfirm(route) {
  const identity = findIdentity(route.identityId);
  if (!identity) {
    navPop();
    return renderMain();
  }
  const repoName = state.repo.name;
  const changing = state.lock.state === "locked";
  const pending = isPending((h) => h.kind === "assignIdentity" && h.repoId === route.repoId && h.identityId === route.identityId);
  const missing = [];
  if (!identity.githubUsername) missing.push("a GitHub username");
  if ((identity.sshAliases || []).length === 0) missing.push("an SSH profile");

  return Screen({
    header: Header({ title: "Assign identity", subtitle: repoName, onBack: navPop }),
    children: [
      Card([
        h("div", { className: "flex items-start gap-2.5" }, [
          IconTile("info"),
          h("div", { className: "min-w-0 flex-1" }, [
            leaf("h2", "font-title-md text-title-md text-on-surface break-words", "Lock " + repoName + " to " + identity.label + "?"),
            leaf("p", "mt-0.5 font-body-sm text-body-sm text-on-surface-variant", "Commits and pushes will be restricted to this identity."),
          ]),
        ]),
        h("div", { className: "mt-space-md" }, [IdentityCard(identity, { showGitName: true })]),
        missing.length
          ? h("div", { className: "mt-2 flex items-start gap-1.5 rounded-lg bg-tertiary/10 border border-tertiary/25 px-2.5 py-2" }, [
              leaf("p", "font-body-sm text-body-sm text-on-surface", "This identity is missing " + missing.join(" and ") + ", so push verification won't work until you add it."),
            ])
          : null,
        h("div", { className: "mt-space-md flex justify-end gap-2" }, [
          Button("Cancel", navPop, { variant: "secondary", disabled: pending }),
          Button(
            pending ? "Locking\\u2026" : "Lock repository",
            () => {
              sendRequest({ type: changing ? "changeIdentity" : "assignIdentity", identityId: identity.id }, {
                kind: "assignIdentity",
                repoId: route.repoId,
                identityId: route.identityId,
                onSuccess: (msg) => {
                  navPopTo("identityLock");
                  showToast(repoName + " locked to " + identity.label, "success");
                },
                onFailure: (msg) => showToast(msg.message || "Couldn't lock this repository.", "info"),
              });
            },
            { variant: "primary", loading: pending },
          ),
        ]),
      ]),
    ],
  });
}

// ==================== manage identities / add / edit ====================

function emptyIdentityDraft() {
  return { label: "", gitName: "", gitEmail: "", githubUsername: "", sshAliases: [""] };
}

function draftFromIdentity(identity) {
  return {
    id: identity.id,
    label: identity.label,
    gitName: identity.gitName || "",
    gitEmail: identity.gitEmail,
    githubUsername: identity.githubUsername || "",
    sshAliases: identity.sshAliases && identity.sshAliases.length ? identity.sshAliases.slice() : [""],
  };
}

function renderManageIdentities() {
  const identities = state.identities || [];
  const currentId = state.lock && state.lock.identity ? state.lock.identity.id : undefined;
  const rows = identities.map((identity) => {
    const assigned = identity.id === currentId;
    const trailing = !identity.complete
      ? leaf("span", "text-tertiary", "!", { attrs: { "aria-label": "Setup incomplete", title: "Setup incomplete" } })
      : assigned
        ? leaf("span", "font-label-sm text-label-sm text-secondary whitespace-nowrap", "Assigned")
        : undefined;
    return h("div", { className: "flex items-stretch gap-1.5" }, [
      h("div", { className: "flex-1 min-w-0" }, [
        IdentityCard(identity, { showGitName: true, onClick: () => navPush({ name: "editIdentity", identityId: identity.id, draft: draftFromIdentity(identity), touched: {}, submitted: false }), trailing: trailing }),
      ]),
      OverflowMenu(
        [
          { label: "Edit", onSelect: () => navPush({ name: "editIdentity", identityId: identity.id, draft: draftFromIdentity(identity), touched: {}, submitted: false }) },
          { label: "Delete", danger: true, onSelect: () => confirmDeleteIdentity(identity) },
        ],
        "More actions for " + identity.label,
      ),
    ]);
  });
  return Screen({
    header: Header({ title: "Identities", onBack: navPop }),
    footer: "Identities are reusable across repositories.",
    children: [
      SectionLabel("Configured identities"),
      h("div", { className: "flex flex-col gap-2" }, rows.concat([identities.length === 0 ? leaf("p", "font-body-sm text-body-sm text-on-surface-variant px-0.5", "No identities yet.") : null, AddRow("Add identity", () => navPush({ name: "addIdentity", draft: emptyIdentityDraft(), touched: {}, submitted: false }))].filter(Boolean))),
    ],
  });
}

function confirmDeleteIdentity(identity) {
  const assignedHere = state.lock && state.lock.identity && state.lock.identity.id === identity.id;
  openOverlay({ type: "deleteIdentity", identity: identity, assignedHere: assignedHere });
}

function renderOverlay() {
  if (!overlay) return null;
  const backdrop = h("div", { className: "fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/40 p-3", attrs: { role: "presentation" } }, []);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) closeOverlay();
  });
  const dialog = h("div", { attrs: { role: "dialog", "aria-modal": "true" } }, []);
  dialog.addEventListener("mousedown", (e) => e.stopPropagation());

  if (overlay.type === "deleteIdentity") {
    const identity = overlay.identity;
    if (overlay.assignedHere) {
      dialog.appendChild(
        Card([
          leaf("p", "font-title-md text-title-md text-on-surface break-words", identity.label + " is currently assigned to " + (state.repo ? state.repo.name : "this repository") + "."),
          leaf("p", "mt-1 font-body-sm text-body-sm text-on-surface-variant", "Change or unlock this repository before deleting " + identity.label + "."),
          h("div", { className: "mt-space-md flex justify-end" }, [
            Button("Go to Identity Lock", () => {
              closeOverlay();
              navPopTo("identityLock");
            }, { variant: "primary" }),
          ]),
        ], "w-full max-w-[320px]"),
      );
    } else {
      const pending = isPending((h) => h.kind === "deleteIdentity" && h.identityId === identity.id);
      const inUseLine = overlay.inUseMessage ? leaf("p", "mt-1 font-body-sm text-body-sm text-error", overlay.inUseMessage) : null;
      dialog.appendChild(
        Card(
          [
            leaf("p", "font-title-md text-title-md text-on-surface break-words", "Delete " + identity.label + "?"),
            leaf("p", "mt-1 font-body-sm text-body-sm text-on-surface-variant", "This removes the reusable identity."),
            inUseLine,
            h("div", { className: "mt-space-md flex flex-wrap justify-end gap-2" }, [
              Button("Cancel", closeOverlay, { variant: "secondary", disabled: pending }),
              Button(
                pending ? "Deleting\\u2026" : "Delete",
                () => {
                  sendRequest({ type: "deleteIdentity", identityId: identity.id }, {
                    kind: "deleteIdentity",
                    identityId: identity.id,
                    onSuccess: () => {
                      closeOverlay();
                      showToast("Deleted " + identity.label, "info");
                    },
                    onFailure: (msg) => {
                      overlay = Object.assign({}, overlay, { inUseMessage: msg.message || "Couldn't delete this identity." });
                      render();
                    },
                  });
                },
                { variant: "danger", loading: pending },
              ),
            ]),
          ].filter(Boolean),
          "w-full max-w-[320px]",
        ),
      );
    }
  } else if (overlay.type === "discardDraft") {
    dialog.appendChild(
      Card(
        [
          leaf("p", "font-title-md text-title-md text-on-surface", "Discard unsaved changes?"),
          h("div", { className: "mt-space-md flex flex-wrap justify-end gap-2" }, [
            Button("Keep editing", closeOverlay, { variant: "secondary" }),
            Button(
              "Discard",
              () => {
                const onDiscard = overlay.onDiscard;
                closeOverlay();
                onDiscard();
              },
              { variant: "danger" },
            ),
          ]),
        ],
        "w-full max-w-[300px]",
      ),
    );
  }
  backdrop.appendChild(dialog);
  return backdrop;
}

function sanitizeSshAliases(aliases) {
  return (aliases || []).map((a) => a.trim()).filter((a) => a.length > 0);
}

function renderIdentityForm(route) {
  const isEdit = !!route.identityId;
  const existing = isEdit ? findIdentity(route.identityId) : undefined;
  if (isEdit && !existing) {
    navPop();
    return renderMain();
  }
  const draft = route.draft;
  const touched = route.touched;
  const submitted = route.submitted;

  const errors = {};
  if (!draft.label.trim()) errors.label = "Required";
  else if ((state.identities || []).some((i) => i.id !== route.identityId && i.label.trim().toLowerCase() === draft.label.trim().toLowerCase())) {
    errors.label = "An identity named " + draft.label.trim() + " already exists.";
  }
  if (!draft.gitEmail.trim()) errors.gitEmail = "Required";
  else if (!EMAIL_RE.test(draft.gitEmail.trim())) errors.gitEmail = "Enter a valid email address.";

  function shown(key) {
    return submitted || touched[key] ? errors[key] : undefined;
  }

  function set(key) {
    return (value) => {
      draft[key] = value;
      render();
    };
  }
  function blur(key) {
    return () => {
      touched[key] = true;
      render();
    };
  }

  const highlightMissing = !!route.highlightMissing;
  function fieldIsMissing(key) {
    if (key === "sshProfile") return sanitizeSshAliases(draft.sshAliases).length === 0;
    return !draft[key].trim();
  }
  function missingNote(key, labelText) {
    return highlightMissing && fieldIsMissing(key) ? labelText + " \\u2014 Needed for push verification" : undefined;
  }

  const sshRows = draft.sshAliases.map((alias, index) =>
    h("div", { className: "flex items-center gap-1.5" }, [
      h("div", { className: "flex-1" }, [
        h("input", {
          className: "w-full h-8 rounded-lg bg-surface-container-lowest border border-outline-variant px-2.5 font-code-sm text-code-sm text-on-surface placeholder:text-outline/70 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30",
          value: alias,
          placeholder: "github-work",
          attrs: { "aria-label": "SSH profile " + (index + 1), spellcheck: "false" },
          on: {
            input: (e) => {
              draft.sshAliases[index] = e.target.value;
            },
          },
        }),
      ]),
      draft.sshAliases.length > 1
        ? Button(
            "\\u00D7",
            () => {
              draft.sshAliases.splice(index, 1);
              render();
            },
            { ariaLabel: "Remove SSH profile " + (index + 1), size: "sm", variant: "ghost" },
          )
        : null,
    ]),
  );

  const sshHelpOpen = route.sshHelpOpen || (route.sshHelpOpen = { value: false });

  function save(e) {
    if (e && e.preventDefault) e.preventDefault();
    route.submitted = true;
    if (Object.keys(errors).length > 0) {
      render();
      return;
    }
    const payloadDraft = {
      label: draft.label.trim(),
      gitName: draft.gitName.trim() || undefined,
      gitEmail: draft.gitEmail.trim(),
      githubUsername: draft.githubUsername.trim().replace(/^@/, "") || undefined,
      sshAliases: sanitizeSshAliases(draft.sshAliases),
    };
    if (route.identityId) payloadDraft.id = route.identityId;
    const pendingHere = isPending((h) => h.kind === "saveIdentity");
    if (pendingHere) return;
    sendRequest({ type: "saveIdentity", identity: payloadDraft }, {
      kind: "saveIdentity",
      onSuccess: () => {
        navPop();
        showToast(isEdit ? "Saved " + payloadDraft.label : "Added " + payloadDraft.label, "success");
      },
      onFailure: (msg) => {
        route.saveError = { message: msg.message, details: msg.details };
        render();
      },
    });
  }

  const pendingSave = isPending((h) => h.kind === "saveIdentity");
  const form = h("form", { className: "flex flex-col gap-space-md", attrs: { novalidate: "true" }, on: { submit: save } }, [
    Field({ label: "Name", required: true, placeholder: "Work", value: draft.label, onChange: set("label"), onBlur: blur("label"), error: shown("label"), hint: "Only shown inside Repo Identity Guard.", autoFocus: !isEdit }),
    Field({ label: "Git name", placeholder: "Jane Doe", value: draft.gitName, onChange: set("gitName") }),
    Field({ label: "Git email", type: "email", mono: true, required: true, placeholder: "jane@company.com", value: draft.gitEmail, onChange: set("gitEmail"), onBlur: blur("gitEmail"), error: shown("gitEmail") }),
    Field({
      label: "GitHub username",
      mono: true,
      placeholder: "jane-company",
      value: draft.githubUsername,
      onChange: set("githubUsername"),
      note: missingNote("githubUsername", "GitHub username"),
      highlight: highlightMissing && !draft.githubUsername.trim(),
      spellCheck: false,
    }),
    h("div", { className: "flex flex-col gap-1" }, [
      leaf("label", "font-label-sm text-label-sm text-on-surface-variant", "SSH profiles"),
      h("div", { className: "flex flex-col gap-1.5" }, sshRows),
      LinkButton("+ Add another SSH profile", () => {
        draft.sshAliases.push("");
        render();
      }),
      missingNote("sshProfile", "SSH profile") ? leaf("p", "font-label-sm text-label-sm text-tertiary", missingNote("sshProfile", "SSH profile")) : null,
    ]),
    h("div", { className: "-mt-1" }, [
      h(
        "button",
        {
          type: "button",
          className: "inline-flex items-center gap-1 font-body-sm text-body-sm text-primary hover:underline underline-offset-2",
          attrs: { "aria-expanded": sshHelpOpen.value },
          on: {
            click: () => {
              sshHelpOpen.value = !sshHelpOpen.value;
              render();
            },
          },
        },
        ["What is an SSH profile?"],
      ),
      sshHelpOpen.value
        ? leaf(
            "p",
            "mt-1.5 rounded-lg bg-surface-container-low border border-outline-variant/40 px-2.5 py-2 font-body-sm text-body-sm text-on-surface-variant",
            "An SSH profile is the Host name in your ~/.ssh/config used for this GitHub account, for example github-work.",
          )
        : null,
    ]),
    route.saveError
      ? h("div", { className: "flex items-start gap-1.5 rounded-lg bg-error/10 border border-error/25 px-2.5 py-2", attrs: { role: "alert" } }, [
          h(
            "div",
            { className: "min-w-0 flex-1" },
            [leaf("p", "font-body-sm text-body-sm text-on-surface", route.saveError.message || "Couldn't save this identity.")].concat(
              (route.saveError.details || []).map((d) => leaf("p", "font-label-sm text-label-sm text-on-surface-variant", d)),
            ),
          ),
        ])
      : null,
    h("div", { className: "flex flex-wrap items-center justify-between gap-2 pt-1" }, [
      isEdit ? Button("Delete", () => confirmDeleteIdentity(existing), { variant: "ghost", className: "text-error" }) : h("span", {}, []),
      h("div", { className: "flex flex-wrap justify-end gap-2" }, [Button("Cancel", navPop, { variant: "secondary" }), Button(pendingSave ? "Saving\\u2026" : "Save", undefined, { type: "submit", variant: "primary", loading: pendingSave })]),
    ]),
  ]);
  // The Save button is type="submit" inside the form, so its own click
  // handler is the form's submit event (set above) rather than a second
  // listener — avoids a double-submit path.
  form.addEventListener("submit", save);

  return Screen({ header: Header({ title: isEdit ? "Edit identity" : "Add identity", subtitle: existing ? existing.label : undefined, onBack: navPop }), children: [form] });
}

// ==================== repo notes ====================

const PRIVACY_LINE = "Notes stay local to this VS Code installation and are not committed to your repository.";
const PERSISTENT_SEARCH_THRESHOLD = 5;

function sortedNotes(notes) {
  return notes
    .map((note, index) => ({ note: note, index: index }))
    .sort((a, b) => Number(!!b.note.pinned) - Number(!!a.note.pinned) || a.index - b.index)
    .map((e) => e.note);
}

function renderRepoNotes(route) {
  const stale = route.repoId !== currentRepoId();
  if (stale) {
    return Screen({ header: Header({ title: "Repo Notes", subtitle: state.repo ? state.repo.name : "", onBack: navPop }), children: [Card([leaf("p", "font-body-sm text-body-sm text-on-surface-variant", "The current repository changed.")])] });
  }
  const repoName = state.repo.name;
  const notes = state.notes || [];
  const persistent = notes.length >= PERSISTENT_SEARCH_THRESHOLD;
  const showSearchField = persistent || route.searchOpen;
  const ordered = sortedNotes(notes);
  const q = route.searchQuery.trim().toLowerCase();
  const visible = q ? ordered.filter((n) => n.text.toLowerCase().indexOf(q) !== -1) : ordered;

  const headerActions = [];
  if (!persistent && notes.length > 0) {
    headerActions.push(
      IconButton(showSearchField ? "Close search" : "Search notes", () => {
        if (showSearchField) {
          route.searchQuery = "";
          route.searchOpen = false;
        } else {
          route.searchOpen = true;
        }
        render();
      }, showSearchField, "\\u{1F50D}"),
    );
  }
  headerActions.push(IconButton("Add note", () => navPush({ name: "addNote", repoId: route.repoId, text: "", original: "" }), false, "+"));
  headerActions.push(
    OverflowMenu(
      [
        { label: "Export notes", onSelect: () => post({ type: "exportNotes" }) },
        { label: "Import notes", onSelect: () => post({ type: "importNotes" }) },
        { label: "About Repo Notes", onSelect: () => showToast(PRIVACY_LINE, "info") },
      ],
      "More Repo Notes actions",
    ),
  );

  let subheader;
  if (notes.length > 0 && showSearchField) {
    const input = h("input", {
      type: "search",
      className: "w-full h-8 rounded-lg bg-surface-container-lowest border border-outline-variant pl-2.5 pr-2.5 font-body-md text-body-md text-on-surface placeholder:text-outline/70 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30",
      value: route.searchQuery,
      placeholder: "Search notes\\u2026",
      attrs: { "aria-label": "Search notes" },
      on: {
        input: (e) => {
          route.searchQuery = e.target.value;
          render();
        },
        keydown: (e) => {
          if (e.key === "Escape" && !persistent) {
            route.searchQuery = "";
            route.searchOpen = false;
            render();
          }
        },
      },
    });
    subheader = h("div", { className: "relative" }, [input]);
  }

  const bodyChildren = [];
  if (notes.length === 0) {
    bodyChildren.push(
      h("div", { className: "mt-2 flex flex-col items-center text-center gap-2 rounded-xl rig-dashed border border-outline-variant px-space-lg py-space-xl" }, [
        leaf("h2", "font-title-md text-title-md text-on-surface", "No notes yet."),
        leaf("p", "font-body-sm text-body-sm text-on-surface-variant max-w-[240px]", "Keep setup steps, reminders, URLs, commands, or anything else useful for " + repoName + "."),
        Button("Add note", () => navPush({ name: "addNote", repoId: route.repoId, text: "", original: "" }), { size: "sm", variant: "primary", className: "mt-1" }),
        leaf("p", "mt-2 font-label-sm text-label-sm text-outline max-w-[240px]", PRIVACY_LINE),
      ]),
    );
  } else if (visible.length === 0) {
    bodyChildren.push(leaf("p", "py-6 text-center font-body-sm text-body-sm text-on-surface-variant", 'No notes match "' + route.searchQuery.trim() + '".'));
  } else {
    bodyChildren.push(h("div", { className: "flex flex-col gap-2" }, visible.map((note) => renderNoteCard(route, note))));
  }

  return Screen({
    header: Header({ title: "Repo Notes", subtitle: repoName, onBack: navPop, actions: headerActions }),
    subheader: subheader,
    footer: notes.length > 0 ? PRIVACY_LINE : undefined,
    children: bodyChildren,
  });
}

const PREVIEW_MAX_CHARS = 260;
const PREVIEW_MAX_LINES = 6;

function needsTruncation(text) {
  return text.length > PREVIEW_MAX_CHARS || text.split("\\n").length > PREVIEW_MAX_LINES;
}

function previewOf(text) {
  const lines = text.split("\\n").slice(0, PREVIEW_MAX_LINES).join("\\n");
  return lines.length > PREVIEW_MAX_CHARS ? lines.slice(0, PREVIEW_MAX_CHARS) + "\\u2026" : lines + "\\u2026";
}

function renderNoteCard(route, note) {
  const expandedRef = (note.__expandedRef = note.__expandedRef || { value: false });
  const truncatable = needsTruncation(note.text);
  const shownText = truncatable && !expandedRef.value ? previewOf(note.text) : note.text;
  const now = Date.now();
  const timeLabel = note.updatedAt ? "Edited " + relativeTime(note.updatedAt, now).toLowerCase() : relativeTime(note.createdAt, now);
  const copied = copiedNotes.get(note.id);

  const children = [];
  if (note.pinned) {
    children.push(h("div", { className: "mb-1 flex items-center gap-1 font-label-sm text-label-sm text-primary" }, [leaf("span", "", "\\u25CF", { attrs: { "aria-hidden": "true" } }), "Pinned"]));
  }
  const textEl = h("p", { className: "whitespace-pre-wrap break-words font-body-md text-body-md text-on-surface" }, []);
  textEl.textContent = shownText;
  children.push(textEl);
  if (truncatable) {
    children.push(
      h(
        "button",
        {
          type: "button",
          className: "mt-1 font-label-sm text-label-sm text-primary hover:underline underline-offset-2",
          attrs: { "aria-expanded": expandedRef.value },
          on: {
            click: () => {
              expandedRef.value = !expandedRef.value;
              render();
            },
          },
        },
        [expandedRef.value ? "Show less" : "Show more"],
      ),
    );
  }

  if (route.confirmDeleteId === note.id) {
    const pendingDelete = isPending((h) => h.kind === "deleteNote" && h.noteId === note.id);
    children.push(
      h("div", { className: "mt-2 pt-1.5 border-t border-outline-variant/40" }, [
        leaf("p", "font-body-sm text-body-sm text-on-surface", "Delete this note?"),
        leaf("p", "font-label-sm text-label-sm text-on-surface-variant", "This can't be undone."),
        h("div", { className: "mt-1.5 flex justify-end gap-1.5" }, [
          Button("Cancel", () => { route.confirmDeleteId = null; render(); }, { size: "sm", variant: "secondary", disabled: pendingDelete }),
          Button(
            pendingDelete ? "Deleting\\u2026" : "Delete",
            () => {
              sendRequest({ type: "deleteNote", noteId: note.id }, {
                kind: "deleteNote",
                noteId: note.id,
                onSuccess: () => {
                  route.confirmDeleteId = null;
                  showToast("Note deleted", "info");
                },
                onFailure: (msg) => {
                  route.confirmDeleteId = null;
                  showToast(msg.message || "Couldn't delete this note.", "info");
                },
              });
            },
            { size: "sm", variant: "danger", loading: pendingDelete },
          ),
        ]),
      ]),
    );
  } else {
    children.push(
      h("div", { className: "mt-2 flex items-center gap-0.5 -mr-1.5" }, [
        leaf("span", "mr-auto font-label-sm text-label-sm text-outline", timeLabel),
        InlineAction(copied ? "\\u2713 Copied" : "Copy", () => copyNote(note), "Copy note"),
        InlineAction("Edit", () => navPush({ name: "editNote", repoId: route.repoId, noteId: note.id, text: note.text, original: note.text }), "Edit note"),
        OverflowMenu(
          [
            {
              label: note.pinned ? "Unpin" : "Pin",
              onSelect: () => {
                sendRequest({ type: "togglePinNote", noteId: note.id }, {
                  kind: "togglePinNote",
                  noteId: note.id,
                  onFailure: (msg) => showToast(msg.message || "Couldn't update this note.", "info"),
                });
              },
            },
            { label: "Delete note", danger: true, onSelect: () => { route.confirmDeleteId = note.id; render(); } },
          ],
          "More note actions",
        ),
      ]),
    );
  }

  return h("article", { className: "rounded-xl bg-surface-container border border-outline-variant/40 pt-2.5 pb-1.5 px-space-md hover:border-outline-variant transition-colors" }, children);
}

function copyNote(note) {
  post({ type: "copyNote", noteId: note.id });
  copiedNotes.set(note.id, true);
  render();
  window.setTimeout(() => {
    copiedNotes.delete(note.id);
    render();
  }, 1500);
  announceLive("Note copied to the clipboard.");
}

/** aria-live region for transient status announcements (copy/save/errors) that may have no persistent visible text — see "ACCESSIBILITY". */
let liveRegionEl = null;
function announceLive(messageText) {
  if (!liveRegionEl) return;
  liveRegionEl.textContent = "";
  window.setTimeout(() => {
    liveRegionEl.textContent = messageText;
  }, 10);
}

// ==================== note editor ====================

function renderNoteEditor(route) {
  const stale = route.repoId !== currentRepoId();
  const isEdit = !!route.noteId;
  const dirty = isNoteEditorDirty(route);
  const canSave = route.text.trim().length > 0 && !stale;
  const pendingSave = isPending((h) => h.kind === (isEdit ? "updateNote" : "addNote") && h.repoId === route.repoId && (isEdit ? h.noteId === route.noteId : true));

  function tryLeave() {
    if (dirty) {
      openOverlay({ type: "discardDraft", onDiscard: navPop });
    } else {
      navPop();
    }
  }

  function doSave() {
    if (!canSave || pendingSave) return;
    route.saveFailed = false;
    const clean = route.text.replace(/^\\s*\\n/, "").replace(/\\s+$/, "");
    if (isEdit) {
      sendRequest({ type: "updateNote", noteId: route.noteId, text: clean }, {
        kind: "updateNote",
        repoId: route.repoId,
        noteId: route.noteId,
        onSuccess: () => {
          showToast("Note saved", "success");
          navPop();
        },
        onFailure: () => {
          route.saveFailed = true;
          render();
        },
      });
    } else {
      sendRequest({ type: "addNote", text: clean }, {
        kind: "addNote",
        repoId: route.repoId,
        onSuccess: () => {
          showToast("Note added", "success");
          navPop();
        },
        onFailure: () => {
          route.saveFailed = true;
          render();
        },
      });
    }
  }

  const textarea = h("textarea", {
    id: "note-editor",
    className: "w-full min-h-[150px] resize-y rounded-lg bg-surface-container-lowest border border-outline-variant px-2.5 py-2 font-body-md text-body-md text-on-surface placeholder:text-outline/70 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30",
    rows: 8,
    value: route.text,
    placeholder: "Write a note for this repository\\u2026",
    attrs: { "aria-label": isEdit ? "Edit note text" : "New note text" },
    on: {
      input: (e) => {
        route.text = e.target.value;
        render();
      },
      keydown: (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          doSave();
        } else if (e.key === "Escape") {
          e.preventDefault();
          tryLeave();
        }
      },
    },
  });

  const children = [
    h("div", { className: "flex flex-col gap-1.5" }, [
      leaf("label", "font-label-sm text-label-sm uppercase tracking-wider text-outline px-0.5", isEdit ? "Editing note" : "New note", { attrs: { for: "note-editor" } }),
      textarea,
      leaf("p", "font-label-sm text-label-sm text-outline px-0.5", "Enter for newline \\u00B7 Ctrl/Cmd+Enter to save"),
    ]),
  ];

  if (stale) {
    children.push(
      h("div", { className: "flex items-start gap-1.5 rounded-lg bg-tertiary/10 border border-tertiary/25 px-2.5 py-2", attrs: { role: "status" } }, [
        h("div", { className: "min-w-0 flex-1" }, [
          leaf("p", "font-body-sm text-body-sm text-on-surface", "The current repository changed."),
          leaf("p", "font-body-sm text-body-sm text-on-surface-variant", "Saving is disabled so this note can't be saved to the wrong repository."),
        ]),
      ]),
    );
  }

  if (route.saveFailed) {
    children.push(
      h("div", { className: "flex items-start gap-1.5 rounded-lg bg-error/10 border border-error/25 px-2.5 py-2", attrs: { role: "alert" } }, [
        h("div", { className: "min-w-0 flex-1" }, [
          leaf("p", "font-body-sm text-body-sm text-on-surface", "Couldn't save this note."),
          leaf("p", "font-body-sm text-body-sm text-on-surface-variant", "Your draft is still here."),
          Button("Retry", doSave, { size: "sm", variant: "secondary", className: "mt-1.5" }),
        ]),
      ]),
    );
  }

  children.push(
    h("div", { className: "flex justify-end gap-2" }, [
      Button("Cancel", tryLeave, { variant: "secondary" }),
      Button(pendingSave ? "Saving\\u2026" : isEdit ? "Save" : "Add note", doSave, { variant: "primary", disabled: !canSave, loading: pendingSave }),
    ]),
  );

  return Screen({ header: Header({ title: "Repo Notes", subtitle: state.repo ? state.repo.name : "", onBack: tryLeave }), footer: PRIVACY_LINE, children: children });
}

// ==================== toast ====================

function renderToastHost() {
  if (!toast) return null;
  const success = toast.tone !== "info";
  return h("div", { className: "absolute left-2 right-2 bottom-2 z-40", attrs: { role: "status", "aria-live": "polite" } }, [
    h("div", { className: "flex items-center gap-2 min-h-9 pl-2.5 pr-1 py-1.5 rounded-lg bg-surface-container-highest border border-outline-variant shadow-xl shadow-black/50 rig-toast-enter" }, [
      leaf("span", success ? "text-secondary" : "text-on-surface-variant", success ? "\\u2713" : "\\u2139", { attrs: { "aria-hidden": "true" } }),
      leaf("span", "flex-1 min-w-0 font-body-sm text-body-sm text-on-surface", toast.message),
      h(
        "button",
        { type: "button", className: "h-6 w-6 inline-flex items-center justify-center rounded-lg text-outline hover:text-on-surface hover:bg-surface-bright", attrs: { "aria-label": "Dismiss" }, on: { click: () => { toast = null; render(); } } },
        ["\\u00D7"],
      ),
    ]),
  ]);
}

// ==================== dispatch / render ====================

function render() {
  const app = document.getElementById("app");
  if (!app) return;
  const active = document.activeElement;
  const activeId = active && active.id ? active.id : null;
  const selection = active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;

  if (!state) {
    app.replaceChildren(leaf("div", "rig-muted p-4", "Loading\\u2026"));
    return;
  }

  reconcileNavForCurrentRepo();

  const route = top();
  let screen;
  switch (route.name) {
    case "identityLock":
      screen = renderIdentityLock(route);
      break;
    case "assignIdentity":
      screen = renderAssignIdentity(route);
      break;
    case "assignmentConfirm":
      screen = renderAssignmentConfirm(route);
      break;
    case "manageIdentities":
      screen = renderManageIdentities();
      break;
    case "addIdentity":
    case "editIdentity":
      screen = renderIdentityForm(route);
      break;
    case "repoNotes":
      screen = renderRepoNotes(route);
      break;
    case "addNote":
    case "editNote":
      screen = renderNoteEditor(route);
      break;
    default:
      screen = renderMain();
  }

  const wrapper = h("div", { className: "relative h-full min-h-0" }, [screen, renderOverlay(), renderToastHost()]);
  const live = h("div", { className: "rig-sr-only", attrs: { "aria-live": "polite", role: "status" }, id: "liveRegion" }, []);
  liveRegionEl = live;
  app.replaceChildren(wrapper, live);

  if (activeId) {
    const again = document.getElementById(activeId);
    if (again) {
      again.focus();
      if (selection && typeof again.setSelectionRange === "function") {
        try {
          again.setSelectionRange(selection[0], selection[1]);
        } catch (e) {
          // Some input types (e.g. "search") can throw; focus is enough.
        }
      }
    } else {
      const autofocusTarget = app.querySelector("[data-autofocus]");
      if (autofocusTarget) autofocusTarget.focus();
    }
  } else {
    const autofocusTarget = app.querySelector("[data-autofocus]");
    if (autofocusTarget) autofocusTarget.focus();
  }
}

window.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.type === "state") {
    state = message.payload;
    render();
  } else if (message.type === "operationResult") {
    const handlers = pending.get(message.requestId);
    if (!handlers) return; // unknown requestId, duplicate ack, or a late ack after teardown — ignored
    pending.delete(message.requestId);
    if (message.ok && handlers.onSuccess) handlers.onSuccess(message);
    else if (!message.ok && handlers.onFailure) handlers.onFailure(message);
    render();
  }
});

render();
post({ type: "ready" });
`;
