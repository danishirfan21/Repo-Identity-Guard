import type { Identity, IdentitiesPreset, Note, NotesPreset } from './types';

export const mockRepo = { name: 'my-project' };

/** The wrong identity Git is "currently using" in the needs_attention mock. */
export const mockDetectedEmail = 'personal@gmail.com';

const identityPool: Identity[] = [
  { id: 'work', label: 'Work', gitName: 'Danish Irfan', gitEmail: 'work@company.com', githubUsername: 'danish-work', sshProfile: 'github-work' },
  { id: 'personal', label: 'Personal', gitName: 'Danish Irfan', gitEmail: 'me@gmail.com', githubUsername: 'danishirfan21', sshProfile: 'github-personal' },
  { id: 'client-a', label: 'Client A', gitName: 'Danish Irfan', gitEmail: 'danish@client-a.com', githubUsername: 'danish-clienta', sshProfile: 'github-client-a' },
  { id: 'client-b', label: 'Client B', gitName: 'Danish Irfan', gitEmail: 'd.irfan@client-b.io', githubUsername: '', sshProfile: 'github-client-b' },
  { id: 'oss', label: 'Open Source', gitName: 'Danish Irfan', gitEmail: 'oss@danishirfan.dev', githubUsername: 'danishirfan21', sshProfile: '' },
  { id: 'freelance', label: 'Freelance', gitName: 'Danish Irfan', gitEmail: 'hello@danishirfan.dev', githubUsername: 'danish-freelance', sshProfile: 'github-freelance' },
  { id: 'side-project', label: 'Side Project', gitName: 'Danish Irfan', gitEmail: 'side@danishirfan.dev', githubUsername: 'danish-side', sshProfile: 'github-side' },
  { id: 'consulting', label: 'Consulting', gitName: 'Danish Irfan', gitEmail: 'consulting@danishirfan.dev', githubUsername: 'danish-consulting', sshProfile: 'github-consulting' },
];

/** Identities for the "Complete" / Work demo identity (used by Identity Setup dev axis). */
export const mockIdentities: Identity[] = [identityPool[0], identityPool[1]];

export function isIdentityComplete(identity: Pick<Identity, 'githubUsername' | 'sshProfile'>): boolean {
  return identity.githubUsername.trim().length > 0 && identity.sshProfile.trim().length > 0;
}

export function missingFields(identity: Pick<Identity, 'githubUsername' | 'sshProfile'>): ('githubUsername' | 'sshProfile')[] {
  const out: ('githubUsername' | 'sshProfile')[] = [];
  if (!identity.githubUsername.trim()) out.push('githubUsername');
  if (!identity.sshProfile.trim()) out.push('sshProfile');
  return out;
}

/** Dev preset: how many identities exist, and whether some are missing required fields. */
export function makeIdentities(preset: IdentitiesPreset): Identity[] {
  switch (preset) {
    case '0':
      return [];
    case '1':
      return [identityPool[0]];
    case '2':
      return [identityPool[0], identityPool[1]];
    case '8':
      return identityPool.map((i) => ({ ...i, githubUsername: i.githubUsername || `gh-${i.id}`, sshProfile: i.sshProfile || `github-${i.id}` }));
    case 'incomplete':
      return [identityPool[0], identityPool[2], identityPool[3], identityPool[4]];
  }
}

// ---------------------------------------------------------------------------
// Notes — realistic dev-note content, not placeholder text.
// ---------------------------------------------------------------------------

export const mockNotes: string[] = [
  'npm run dev\nBackend runs on port 8000.',
  'Ask Ahmed before changing the auth flow.',
];

const fillerNotes: string[] = [
  'Staging deploys go out from the release branch every Thursday.',
  'Use Node 20 here. The build breaks on Node 22 because of the image library.',
  "Feature flags live in config/flags.json. Don't hardcode them.",
  'Design review with Sara on Friday.\nBring the onboarding screens and the empty states.',
  'docker compose up db\nThen run migrations before starting the API.',
  'The payments sandbox key is in the team password manager, not in .env.',
  'Remember to bump the version in package.json before tagging a release.',
  'checkout.spec.ts times out on CI now and then. Re-run once before investigating.',
  'Staging URL: https://staging.my-project.internal\nLogin with the shared QA account.',
  'Webhook secret rotates monthly. Ping #platform if deliveries start failing.',
  'Run `npm run lint:fix` before pushing — CI fails on warnings, not just errors.',
  'The onboarding flow is behind the "new-onboarding" flag for internal users only.',
  'Database migrations: never squash them on main, only on your own branch.',
  'Support escalations go to #my-project-oncall, not the general channel.',
  'Local HTTPS cert is in certs/dev.pem. Regenerate with scripts/make-cert.sh if it expires.',
  'Thursday 2pm: sync with the mobile team about the new auth token shape.',
  'npm run test:e2e -- --headed\nUseful when a Playwright test fails only on CI.',
  'robots.txt disallows /admin — don\'t remove that without checking with legal.',
  'Error budget review happens the first Monday of each month.',
  'The seed script wipes the local DB. Back up anything you care about first.',
  'Contact for the GitHub App: @priya. She owns the webhook permissions.',
  'Image uploads go through the CDN, not directly to S3. See docs/uploads.md.',
  'Rate limiter config is per-environment; staging is 10x looser than prod.',
  'Tag releases as vX.Y.Z, never with a leading "release-" prefix.',
  'Use the `feature/` branch prefix so the preview-deploy bot picks it up.',
  'Known flaky test: billing.spec.ts > "renews on schedule". Retry twice before filing a bug.',
  'The staging DB resets every night at 3am UTC. Don\'t rely on data surviving overnight.',
  'README setup steps are out of date for M1 Macs — use scripts/mac-setup.sh instead.',
];

const longNoteText =
  'Runbook: rotating the GitHub App private key\n\n' +
  "1. Generate a new private key from the GitHub App settings page (Settings > Developer settings > GitHub Apps > my-project-bot > Private keys).\n" +
  '2. Download the .pem file. Do not commit it, do not paste it into Slack.\n' +
  '3. Base64-encode it: `base64 -i new-key.pem | pbcopy`\n' +
  '4. Update the GH_APP_PRIVATE_KEY secret in both the staging and production environments. Do this one environment at a time.\n' +
  '5. Redeploy the webhook service so it picks up the new secret — it does not hot-reload.\n' +
  '6. Watch the webhook delivery log for the next 10 minutes. A spike in 401s means the old key is still cached somewhere.\n' +
  '7. Once deliveries look healthy, revoke the old private key from the GitHub App settings page.\n' +
  '8. Update the "last rotated" date in the team wiki so the next person knows when this is due again.\n\n' +
  'If this breaks, the fallback is to disable the GitHub App integration from the dashboard and fall back to manual deploys until it is fixed. Ping #platform-oncall if you get stuck — this has bitten at least three people before you.';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Ages (ms before "now") so the seeded notes show a spread of relative times.
const seedAges = [
  2 * HOUR, 1 * DAY, 3 * DAY, 4 * DAY, 6 * DAY, 9 * DAY, 12 * DAY, 15 * DAY, 21 * DAY, 30 * DAY,
  35 * DAY, 40 * DAY, 45 * DAY, 50 * DAY, 55 * DAY, 60 * DAY, 65 * DAY, 70 * DAY, 75 * DAY, 80 * DAY,
  85 * DAY, 90 * DAY, 95 * DAY, 100 * DAY, 105 * DAY, 110 * DAY, 115 * DAY, 120 * DAY, 125 * DAY, 130 * DAY,
];

let noteSeq = 0;
export function newNoteId(): string {
  noteSeq += 1;
  return `note-${Date.now().toString(36)}-${noteSeq}`;
}

export function makeNotes(preset: NotesPreset, now = Date.now()): Note[] {
  let texts: string[];
  switch (preset) {
    case 'empty':
      texts = [];
      break;
    case 'two':
      texts = mockNotes;
      break;
    case 'ten':
      texts = [...mockNotes, ...fillerNotes].slice(0, 10);
      break;
    case 'thirty':
      texts = [...mockNotes, ...fillerNotes];
      break;
    case 'long':
      texts = [longNoteText, ...mockNotes, ...fillerNotes.slice(0, 3)];
      break;
  }
  return texts.map((text, i) => ({ id: newNoteId(), text, createdAt: now - seedAges[i % seedAges.length] }));
}
