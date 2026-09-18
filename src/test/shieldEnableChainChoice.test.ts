import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { ICONS_JS } from "../webview/client/icons";
import { COMPONENTS_JS } from "../webview/client/components";
import { ONBOARDING_VIEW_JS } from "../webview/client/onboardingView";
import { MAIN_VIEW_JS } from "../webview/client/mainView";
import { DETAILS_VIEW_JS } from "../webview/client/detailsView";
import { MEMORY_VIEW_JS } from "../webview/client/memoryView";
import { SETTINGS_VIEW_JS } from "../webview/client/settingsView";
import { SHIELD_VIEW_JS } from "../webview/client/shieldView";
import { NAVIGATION_JS } from "../webview/client/navigation";

/**
 * Review finding: `renderShieldEnable()` reset `shieldChainChoice = "leave"`
 * on every call, but `render()` (which calls it) runs on every re-render —
 * including the one the radio's own "change" handler triggers right after
 * setting `shieldChainChoice = "chain"`. So the UI displayed the Chain
 * option but a user could never actually select it: the very re-render
 * meant to reflect the click undid it first.
 *
 * These tests drive the REAL navigation.ts + shieldView.ts client script in
 * a sandboxed VM (same pattern as profileConfigRoundTrip.test.ts), through
 * the full flow: open Enable Shield -> select Chain -> re-render (as a
 * backend state push would trigger) -> confirm -> verify the outgoing
 * `enableShield` message carries `chainForeignHooks: true`. And the
 * symmetric case for Leave.
 */

interface FakeElement {
  id?: string;
  name?: string;
  value?: string;
  dataset: Record<string, string>;
  innerHTML: string;
  textContent: string;
  classList: { toggle(): void };
  addEventListener(): void;
  closest(selector: string): FakeElement | null;
}

function makeFakeElement(overrides: Partial<FakeElement> = {}): FakeElement {
  return {
    dataset: {},
    innerHTML: "",
    textContent: "",
    classList: { toggle: () => undefined },
    addEventListener: () => undefined,
    closest(selector: string) {
      if (selector.startsWith("#")) {
        return this.id === selector.slice(1) ? this : null;
      }
      const dataMatch = /^\[data-([a-zA-Z-]+)\]$/.exec(selector);
      if (dataMatch) {
        const key = dataMatch[1].replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        return this.dataset[key] !== undefined ? this : null;
      }
      return null;
    },
    ...overrides,
  };
}

interface Harness {
  sent: Array<{ type: string; [key: string]: unknown }>;
  clickHandlers: Array<(event: { target: unknown }) => void>;
  changeHandlers: Array<(event: { target: unknown }) => void>;
  sandbox: Record<string, unknown>;
  elementsById: Map<string, FakeElement>;
}

function loadShieldEnableSandbox(): Harness {
  const sent: Harness["sent"] = [];
  const clickHandlers: Harness["clickHandlers"] = [];
  const changeHandlers: Harness["changeHandlers"] = [];
  const elementsById = new Map<string, FakeElement>();
  const idOf = (id: string): FakeElement => {
    let el = elementsById.get(id);
    if (!el) {
      el = makeFakeElement({ id });
      elementsById.set(id, el);
    }
    return el;
  };

  const sandbox: Record<string, unknown> = {
    acquireVsCodeApi: () => ({
      postMessage: (msg: { type: string; [key: string]: unknown }) => sent.push(msg),
    }),
    console,
    Element: function Element() {} as unknown,
    CSS: { escape: (s: string) => s },
    document: {
      getElementById: (id: string) => idOf(id),
      addEventListener: (type: string, handler: (event: { target: unknown }) => void) => {
        if (type === "click") clickHandlers.push(handler);
        if (type === "change") changeHandlers.push(handler);
      },
    },
    window: { addEventListener: () => undefined },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [ICONS_JS, COMPONENTS_JS, ONBOARDING_VIEW_JS, MAIN_VIEW_JS, SHIELD_VIEW_JS, DETAILS_VIEW_JS, MEMORY_VIEW_JS, SETTINGS_VIEW_JS, NAVIGATION_JS].join(
      "\n",
    ),
    sandbox,
  );

  const ElementCtor = sandbox.Element as { prototype: object };
  for (const el of elementsById.values()) Object.setPrototypeOf(el, ElementCtor.prototype);

  return { sent, clickHandlers, changeHandlers, sandbox, elementsById };
}

function pushState(harness: Harness): void {
  const state = {
    level: "not_safe",
    isGitRepo: true,
    repoName: "acme-frontend",
    profileLabel: "Work",
    profiles: [{ id: "work", label: "Work", gitEmail: "work@example.com" }],
    facts: {},
    capabilityResults: [],
    workspace: { level: "not_safe", repos: [{ repoId: "r1", name: "acme-frontend", level: "not_safe", selected: true }] },
    shield: {
      lifecycle: "degraded",
      reasons: [],
      trustedSshHostAliases: [],
      commitProtection: false,
      mergeCommitProtection: false,
      pushProtection: false,
      policyProfileDrift: false,
      pushDestinationDrift: false,
      foreignHook: { fileName: "pre-push", path: "/repo/.git/hooks/pre-push", chainable: true },
    },
  };
  vm.runInContext(`state = ${JSON.stringify(state)};`, harness.sandbox);
}

function dispatchClick(harness: Harness, el: FakeElement): void {
  Object.setPrototypeOf(el, (harness.sandbox.Element as { prototype: object }).prototype);
  for (const handler of harness.clickHandlers) handler({ target: el });
}

function dispatchChange(harness: Harness, el: FakeElement): void {
  Object.setPrototypeOf(el, (harness.sandbox.Element as { prototype: object }).prototype);
  for (const handler of harness.changeHandlers) handler({ target: el });
}

function navigateToShieldEnable(harness: Harness): void {
  pushState(harness);
  vm.runInContext(`render();`, harness.sandbox);
  const goToEnable = makeFakeElement({ id: "shieldGoToEnableButton" });
  dispatchClick(harness, goToEnable);
}

test("selecting Chain in Enable Shield survives a re-render (the actual bug: it used to snap back to Leave)", () => {
  const harness = loadShieldEnableSandbox();
  navigateToShieldEnable(harness);

  const chainRadio = makeFakeElement({ name: "shieldChain", value: "chain" });
  dispatchChange(harness, chainRadio);

  // A backend state push while still on this screen re-renders — this is
  // exactly what silently reset the choice before the fix.
  pushState(harness);
  vm.runInContext(`render();`, harness.sandbox);

  const appHtml = harness.elementsById.get("app")!.innerHTML;
  assert.match(appHtml, /value="chain"[^]*?checked/, "Chain radio must still render as checked after a re-render");
});

test("confirming after selecting Chain sends enableShield with chainForeignHooks: true", () => {
  const harness = loadShieldEnableSandbox();
  navigateToShieldEnable(harness);

  dispatchChange(harness, makeFakeElement({ name: "shieldChain", value: "chain" }));
  pushState(harness); // an intervening re-render must not undo the selection
  vm.runInContext(`render();`, harness.sandbox);

  dispatchClick(harness, makeFakeElement({ id: "shieldEnableConfirmButton" }));

  const enableMsg = harness.sent.find((m) => m.type === "enableShield");
  assert.ok(enableMsg, "expected an enableShield message to be sent");
  assert.equal(enableMsg!.chainForeignHooks, true);
});

test("confirming without touching the radio (default Leave) sends enableShield with chainForeignHooks: false", () => {
  const harness = loadShieldEnableSandbox();
  navigateToShieldEnable(harness);

  dispatchClick(harness, makeFakeElement({ id: "shieldEnableConfirmButton" }));

  const enableMsg = harness.sent.find((m) => m.type === "enableShield");
  assert.ok(enableMsg, "expected an enableShield message to be sent");
  assert.equal(enableMsg!.chainForeignHooks, false);
});

test("re-entering Enable Shield after a previous Chain selection resets to Leave (fresh confirmation flow, not stale state)", () => {
  const harness = loadShieldEnableSandbox();
  navigateToShieldEnable(harness);
  dispatchChange(harness, makeFakeElement({ name: "shieldChain", value: "chain" }));

  // Leave without confirming (Cancel), then come back in.
  pushState(harness);
  vm.runInContext(`navigate("main");`, harness.sandbox);
  navigateToShieldEnable(harness);

  dispatchClick(harness, makeFakeElement({ id: "shieldEnableConfirmButton" }));
  const enableMsg = harness.sent.find((m) => m.type === "enableShield");
  assert.equal(enableMsg!.chainForeignHooks, false, "re-entering the screen must start from Leave again");
});
