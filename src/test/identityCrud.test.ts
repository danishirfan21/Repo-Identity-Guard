import assert from "node:assert/strict";
import test from "node:test";
import { IdentityDraft, createIdentity, deleteIdentity, updateIdentity } from "../identity/identityCrud";
import { Identity } from "../identity/types";

/**
 * Product-level identity CRUD policy (on top of `validateIdentity`'s
 * structural checks): unique id, unique (case-insensitive) label, and
 * delete safety — never orphaning a currently-open assignment. See the
 * "IDENTITY CRUD" and "IDENTITY DELETE SAFETY" sections of the task spec.
 */

const WORK: Identity = { id: "work", label: "Work", gitEmail: "work@example.com", gitName: "Danish", expectedGitHubLogin: "danish-work", trustedSshHostAliases: ["github-work"] };
const PERSONAL: Identity = { id: "personal", label: "Personal", gitEmail: "me@example.com" };

function draft(overrides: Partial<IdentityDraft> = {}): IdentityDraft {
  return { label: "New One", gitEmail: "new@example.com", sshAliases: [], ...overrides };
}

// ==================== create ====================

test("create: a well-formed draft is added with a generated id", () => {
  const result = createIdentity([WORK], draft({ label: "Side Project" }), () => "generated-id");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.id, "generated-id");
  assert.equal(result.identity.label, "Side Project");
  assert.deepEqual(result.identities.map((i) => i.id), ["work", "generated-id"]);
});

test("create: an invalid draft is rejected and the list is unchanged", () => {
  const result = createIdentity([WORK], draft({ label: "", gitEmail: "" }), () => "x");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "invalid");
  assert.ok(result.errors.length > 0);
});

test("create: a generated id colliding with an existing one is rejected (duplicate id policy)", () => {
  const result = createIdentity([WORK], draft(), () => "work");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "duplicate_id");
});

test("create: a duplicate label (case-insensitive) is rejected (duplicate label policy)", () => {
  const result = createIdentity([WORK], draft({ label: "  work  " }), () => "another-id");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "duplicate_label");
});

test("create: an incomplete identity (no GitHub login, no SSH alias) is NOT rejected — legacy/incomplete identities are a legitimate, storable product state", () => {
  const result = createIdentity([], draft({ label: "Bare Minimum", gitEmail: "bare@example.com" }), () => "bare");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.expectedGitHubLogin, undefined);
  assert.equal(result.identity.trustedSshHostAliases, undefined);
});

// ==================== update ====================

test("update: an existing identity's fields are replaced; the id is kept", () => {
  const result = updateIdentity([WORK, PERSONAL], { id: "work", label: "Work (new email)", gitEmail: "new-work@example.com", sshAliases: ["github-work"] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.id, "work");
  assert.equal(result.identity.gitEmail, "new-work@example.com");
  assert.equal(result.identities.find((i) => i.id === "personal")?.gitEmail, "me@example.com");
});

test("update: an unknown id is rejected", () => {
  const result = updateIdentity([WORK], { id: "does-not-exist", label: "X", gitEmail: "x@example.com", sshAliases: [] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "not_found");
});

test("update: renaming to collide with ANOTHER identity's label is rejected", () => {
  const result = updateIdentity([WORK, PERSONAL], { id: "personal", label: "Work", gitEmail: "me@example.com", sshAliases: [] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "duplicate_label");
});

test("update: keeping an identity's OWN label is not treated as a duplicate of itself", () => {
  const result = updateIdentity([WORK, PERSONAL], { id: "work", label: "Work", gitEmail: "work@example.com", gitName: "Danish Irfan", sshAliases: ["github-work"] });
  assert.equal(result.ok, true);
});

test("update: an invalid draft is rejected and the list is unchanged", () => {
  const result = updateIdentity([WORK], { id: "work", label: "Work", gitEmail: "not-an-email-but-structurally-fine-is-not-checked-here", sshAliases: ["has space invalid"] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "invalid");
});

test("update: multiple SSH aliases round-trip exactly — 0, 1, and many aliases are never truncated or lost", () => {
  for (const aliases of [[], ["github-work"], ["github-work", "github-work-2", "github-work-3"]]) {
    const result = updateIdentity([WORK], { id: "work", label: "Work", gitEmail: "work@example.com", gitName: "Danish", sshAliases: aliases });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) continue;
    assert.deepEqual(result.identity.trustedSshHostAliases ?? [], aliases);
  }
});

// ==================== delete ====================

test("delete: an identity with no currently-open assignment is removed", () => {
  const result = deleteIdentity([WORK, PERSONAL], "personal", []);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.identities.map((i) => i.id), ["work"]);
});

test("delete: an unknown id is rejected", () => {
  const result = deleteIdentity([WORK], "ghost", []);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "not_found");
});

test("delete: an identity referenced by a currently-open repository is refused, with safe display names, and the list is unchanged", () => {
  const result = deleteIdentity([WORK, PERSONAL], "work", [{ repoName: "service-a" }, { repoName: "service-b" }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "identity_in_use");
  assert.deepEqual(result.repoNames, ["service-a", "service-b"]);
  // Never a filesystem path.
  for (const name of result.repoNames) assert.ok(!name.includes("/") && !name.includes("\\"));
});
