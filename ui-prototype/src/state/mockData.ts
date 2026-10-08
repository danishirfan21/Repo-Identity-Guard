import type { Identity, Note, NotesPreset } from './types';

export const mockRepo = { name: 'my-project' };

export const mockIdentities: Identity[] = [
  {
    id: 'work',
    label: 'Work',
    gitName: 'Danish Irfan',
    gitEmail: 'work@company.com',
    githubUsername: 'danish-work',
    sshProfile: 'github-work',
  },
  {
    id: 'personal',
    label: 'Personal',
    gitName: 'Danish Irfan',
    gitEmail: 'me@gmail.com',
    githubUsername: 'danishirfan21',
    sshProfile: 'github-personal',
  },
];

/** The wrong identity Git is "currently using" in the needs_attention mock. */
export const mockDetectedEmail = 'personal@gmail.com';

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
];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Ages (ms before "now") so the seeded notes show a spread of relative times.
const seedAges = [2 * HOUR, 1 * DAY, 3 * DAY, 4 * DAY, 6 * DAY, 9 * DAY, 12 * DAY, 15 * DAY, 21 * DAY, 30 * DAY];

let noteSeq = 0;
export function newNoteId(): string {
  noteSeq += 1;
  return `note-${Date.now().toString(36)}-${noteSeq}`;
}

export function makeNotes(preset: NotesPreset, now = Date.now()): Note[] {
  const texts = preset === 'empty' ? [] : preset === 'two' ? mockNotes : [...mockNotes, ...fillerNotes];
  return texts.map((text, i) => ({ id: newNoteId(), text, createdAt: now - seedAges[i % seedAges.length] }));
}
