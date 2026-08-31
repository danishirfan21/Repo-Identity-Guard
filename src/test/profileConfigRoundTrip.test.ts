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
import { buildShieldPolicy } from "../shield/policy";
import { Profile } from "../types";

/**
 * PART 5 + PART 13 — profile config round-trip.
 *
 * Every field of `Profile` has to survive every save path, including the
 * ones the editor does not render. The webview's editor builds its outgoing
 * profile with `Object.assign({}, storedProfile, partialFromForm)`, which
 * is correct *only* as long as the left-hand operand is the STORED profile
 * — swap it for a fresh literal and every unrendered field
 * (`exactRepos`, `expectedBranchPatterns`, `trustedSshHostAliases`,
 * `expectedGitHubLogin`, anything added later) is silently dropped on the
 * next Save. That is exactly the failure this file exists to catch, driven
 * against the REAL client script rather than a re-implementation of it.
 *
 * `expectedGitHubLogin` gets extra attention because it is the input to
 * strict GitHub account verification: losing it does not produce an error,
 * it silently downgrades Shield from "this route must authenticate as
 * danish-work" to "any trusted route will do."
 */

const ALL_PROFILE_FIELDS = [
  "id",
  "label",
  "gitName",
  "gitEmail",
  "expectedRemoteOwners",
  "exactRepos",
  "expectedBranchPatterns",
  "strictPushSetup",
  "trustedSshHostAliases",
  "expectedGitHubLogin",
] as const;

/** A profile with every single documented field populated with a distinctive value. */
function fullyPopulatedProfile(): Profile {
  return {
    id: "work",
    label: "Work",
    gitName: "Danish Irfan",
    gitEmail: "work@example.com",
    expectedRemoteOwners: ["AcmeSoftware", "acme-*"],
    exactRepos: ["github.com/acme/secret"],
    expectedBranchPatterns: ["feature/*", "release/*"],
    strictPushSetup: true,
    trustedSshHostAliases: ["github-work", "github-work-2"],
    expectedGitHubLogin: "danish-work",
  };
}

// ==================== the real webview editor, in a sandbox ====================

interface FakeElement {
  id?: string;
  value?: string;
  checked?: boolean;
  dataset: Record<string, string>;
  closest(selector: string): FakeElement | null;
  querySelector(selector: string): FakeElement | null;
}

/**
 * The narrowest DOM that the real navigation/settings client script needs
 * in order to run its Save-profile branch: a click target that answers
 * `closest("[data-save-profile]")`, and a profile-editor container whose
 * `querySelector('[data-field="X"]')` returns the form control for X.
 */
function makeFakeDom(profileId: string, fields: Record<string, { value?: string; checked?: boolean }>) {
  const fieldElements = new Map<string, FakeElement>();
  for (const [name, spec] of Object.entries(fields)) {
    fieldElements.set(name, {
      value: spec.value,
      checked: spec.checked,
      dataset: {},
      closest: () => null,
      querySelector: () => null,
    });
  }
  const container: FakeElement = {
    dataset: { profileId },
    closest: () => null,
    querySelector: (selector) => {
      const match = /^\[data-field="(.+)"\]$/.exec(selector);
      return match ? (fieldElements.get(match[1]) ?? null) : null;
    },
  };
  const saveButton: FakeElement = {
    dataset: { saveProfile: profileId },
    closest: (selector) => (selector === "[data-save-profile]" ? saveButton : null),
    querySelector: () => null,
  };
  return { container, saveButton, fieldElements };
}

interface SandboxRun {
  sent: Array<{ type: string; profile?: Record<string, unknown> }>;
  clickHandlers: Array<(event: { target: unknown }) => void>;
  sandbox: Record<string, unknown>;
}

function loadSettingsSandbox(profiles: Profile[], container: FakeElement): SandboxRun {
  const sent: SandboxRun["sent"] = [];
  const clickHandlers: SandboxRun["clickHandlers"] = [];
  const noopEl = { addEventListener: () => undefined, classList: { toggle: () => undefined }, click: () => undefined, focus: () => undefined, value: "" };
  const sandbox: Record<string, unknown> = {
    acquireVsCodeApi: () => ({
      postMessage: (msg: { type: string; profile?: Record<string, unknown> }) => sent.push(msg),
    }),
    console,
    // The client uses `instanceof Element`; give the sandbox an Element
    // whose prototype the fake nodes inherit from, so the real guard clauses
    // behave exactly as they do in a browser instead of being bypassed.
    Element: function Element() {} as unknown,
    CSS: { escape: (s: string) => s },
    document: {
      addEventListener: (type: string, handler: (event: { target: unknown }) => void) => {
        if (type === "click") clickHandlers.push(handler);
      },
      getElementById: () => noopEl,
      querySelector: (selector: string) => (selector.includes("data-profile-id") ? container : null),
    },
    window: { addEventListener: () => undefined },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [
      ICONS_JS,
      COMPONENTS_JS,
      MAIN_VIEW_JS,
      SHIELD_VIEW_JS,
      DETAILS_VIEW_JS,
      MEMORY_VIEW_JS,
      ONBOARDING_VIEW_JS,
      SETTINGS_VIEW_JS,
      NAVIGATION_JS,
      // Inject the state the real script would have received via a
      // postMessage, then re-render so `state.profiles` is populated.
      `state = ${JSON.stringify({
        profiles,
        protectedBranches: ["main"],
        preferences: {},
        facts: {},
        memory: { notes: [], commands: [] },
        shield: { lifecycle: "off", reasons: [], trustedSshHostAliases: [], commitProtection: false, mergeCommitProtection: false, pushProtection: false, policyProfileDrift: false, pushDestinationDrift: false },
      })};`,
    ].join("\n"),
    sandbox,
  );
  // Fake nodes must satisfy `instanceof Element` inside the sandbox.
  const ElementCtor = sandbox.Element as { prototype: object };
  Object.setPrototypeOf(container, ElementCtor.prototype);
  return { sent, clickHandlers, sandbox };
}

function clickSave(run: SandboxRun, saveButton: FakeElement): Record<string, unknown> {
  Object.setPrototypeOf(saveButton, (run.sandbox.Element as { prototype: object }).prototype);
  for (const handler of run.clickHandlers) handler({ target: saveButton });
  const saved = run.sent.filter((m) => m.type === "saveProfile");
  assert.equal(saved.length, 1, `expected exactly one saveProfile message, got ${JSON.stringify(run.sent)}`);
  // Objects crossing the vm realm boundary are not reference-comparable to
  // host-realm ones; JSON round-tripping normalizes them so assertions
  // compare CONTENT. This is also exactly what a real postMessage does to
  // the payload, so it is the faithful representation of what the extension
  // host actually receives — including `undefined` fields being dropped.
  return JSON.parse(JSON.stringify(saved[0].profile)) as Record<string, unknown>;
}

test("PART 13 — the webview profile editor's Save preserves every field it does not render", () => {
  const profile = fullyPopulatedProfile();
  const { container, saveButton } = makeFakeDom(profile.id, {
    label: { value: "Work Renamed" },
    gitName: { value: "Danish Irfan" },
    gitEmail: { value: "work@example.com" },
    strictPushSetup: { checked: true },
    expectedGitHubLogin: { value: "danish-work" },
  });
  const run = loadSettingsSandbox([profile], container);
  const saved = clickSave(run, saveButton);

  assert.equal(saved.label, "Work Renamed");
  // Everything the form does not render survives untouched.
  assert.deepEqual(saved.expectedRemoteOwners, profile.expectedRemoteOwners);
  assert.deepEqual(saved.exactRepos, profile.exactRepos);
  assert.deepEqual(saved.expectedBranchPatterns, profile.expectedBranchPatterns);
  assert.deepEqual(saved.trustedSshHostAliases, profile.trustedSshHostAliases);
  // And no documented field went missing outright (every field of this
  // fixture is populated, so every one must come back).
  for (const field of ALL_PROFILE_FIELDS) {
    assert.ok(field in saved, `Save dropped the "${field}" field entirely`);
  }
});

test("PART 5 — expectedGitHubLogin survives an edit that does not touch it, and is editable without hand-editing settings.json", () => {
  const profile = fullyPopulatedProfile();
  const { container, saveButton } = makeFakeDom(profile.id, {
    label: { value: "Work" },
    gitName: { value: "Danish Irfan" },
    gitEmail: { value: "someone-else@example.com" },
    strictPushSetup: { checked: true },
    // The user changed only the email; the login input still holds its
    // rendered value, exactly as the real editor would present it.
    expectedGitHubLogin: { value: "danish-work" },
  });
  const run = loadSettingsSandbox([profile], container);
  const saved = clickSave(run, saveButton);

  assert.equal(saved.gitEmail, "someone-else@example.com");
  assert.equal(saved.expectedGitHubLogin, "danish-work");

  // And the editor genuinely renders an input for it — this is what makes
  // the field configurable at all, rather than JSON-only.
  const rendered = (run.sandbox as { renderSettings: () => string }).renderSettings();
  assert.match(rendered, /data-field="expectedGitHubLogin"/);
  assert.match(rendered, /Expected GitHub login/);
  // The copy must not let a user confuse it with the three adjacent
  // identity-shaped concepts.
  assert.match(rendered, /Not your commit email, not the repo owner\/org, and not the SSH alias/);
});

test("PART 5 — clearing the expectedGitHubLogin input stores an ABSENT field, never an empty string", () => {
  const profile = fullyPopulatedProfile();
  const { container, saveButton } = makeFakeDom(profile.id, {
    label: { value: "Work" },
    gitName: { value: "Danish Irfan" },
    gitEmail: { value: "work@example.com" },
    strictPushSetup: { checked: true },
    expectedGitHubLogin: { value: "   " },
  });
  const run = loadSettingsSandbox([profile], container);
  const saved = clickSave(run, saveButton);

  // An empty string here would be persisted into the policy as `""`, and
  // ShieldManager's profile-drift comparison against a policy built before
  // this field existed (`undefined`) would then report drift forever on a
  // profile nobody actually changed.
  assert.equal(saved.expectedGitHubLogin, undefined);
  assert.ok(!("expectedGitHubLogin" in JSON.parse(JSON.stringify(saved))));
});

test("PART 5 — a profile with NO expectedGitHubLogin still round-trips without inventing one", () => {
  const profile: Profile = { ...fullyPopulatedProfile(), expectedGitHubLogin: undefined };
  const { container, saveButton } = makeFakeDom(profile.id, {
    label: { value: "Work" },
    gitName: { value: "Danish Irfan" },
    gitEmail: { value: "work@example.com" },
    strictPushSetup: { checked: false },
    expectedGitHubLogin: { value: "" },
  });
  const run = loadSettingsSandbox([profile], container);
  const saved = clickSave(run, saveButton);
  assert.equal(saved.expectedGitHubLogin, undefined);
  assert.deepEqual(saved.trustedSshHostAliases, profile.trustedSshHostAliases);
});

// ==================== onboarding / profile creation ====================

test("PART 5 + 13 — onboarding creates a profile with no expectedGitHubLogin rather than a corrupt one", () => {
  // The onboarding path builds its profile literally (see
  // onboardingView.ts) — it must not fabricate an expectedGitHubLogin, and
  // must not emit "" for it either. Asserted against the real source so a
  // future edit that adds a stray field is caught.
  assert.doesNotMatch(ONBOARDING_VIEW_JS, /expectedGitHubLogin\s*:\s*["']["']/);
  assert.match(ONBOARDING_VIEW_JS, /trustedSshHostAliases:\s*\[\]/);
});

test("PART 5 + 13 — the 'add profile' button creates a profile with every array field initialized and no invented login", () => {
  assert.match(NAVIGATION_JS, /addProfileButton/);
  const literal = /const profile = \{ id: "profile-".*?\};/s.exec(NAVIGATION_JS)?.[0] ?? "";
  assert.ok(literal.length > 0, "could not find the add-profile literal");
  for (const field of ["expectedRemoteOwners", "exactRepos", "expectedBranchPatterns", "trustedSshHostAliases"]) {
    assert.match(literal, new RegExp(`${field}: \\[\\]`), `add-profile literal is missing ${field}: []`);
  }
  assert.doesNotMatch(literal, /expectedGitHubLogin/);
});

// ==================== policy round-trip ====================

test("PART 5 — expectedGitHubLogin travels verbatim from Profile into the persisted ShieldPolicy", () => {
  const policy = buildShieldPolicy({
    profile: fullyPopulatedProfile(),
    protectedBranches: ["main"],
    enabledActions: ["commit", "push"],
    now: 1,
  });
  assert.equal(policy.expectedGitHubLogin, "danish-work");
  // ...and is never confused with the three adjacent concepts.
  assert.notEqual(policy.expectedGitHubLogin, policy.expectedGitEmail);
  assert.notEqual(policy.expectedGitHubLogin, policy.approvedPushDestination?.owner);
  assert.ok(!policy.trustedSshHostAliases.includes(policy.expectedGitHubLogin as string));
});

test("PART 5 — package.json documents expectedGitHubLogin accurately and distinguishes it from the fields it is confused with", async () => {
  const pkg = JSON.parse(
    await (await import("node:fs")).promises.readFile(
      (await import("node:path")).join(__dirname, "..", "..", "package.json"),
      "utf8",
    ),
  );
  const props = pkg.contributes.configuration.properties["repoIdentityGuard.profiles"].items.properties;
  // Every field the extension actually reads must be documented in the
  // schema — an undocumented field is one a user cannot discover.
  for (const field of ALL_PROFILE_FIELDS) {
    assert.ok(props[field], `package.json profile schema is missing "${field}"`);
  }
  const description: string = props.expectedGitHubLogin.description;
  assert.match(description, /GitHub username this profile expects a trusted SSH route to authenticate as/);
  assert.match(description, /strict GitHub account verification/);
  assert.match(description, /NOT your commit email/i);
  assert.match(description, /NOT the repository's owner or org/i);
  assert.match(description, /NOT the SSH host alias/i);
  assert.match(description, /NOT a generic Git username/i);
});
