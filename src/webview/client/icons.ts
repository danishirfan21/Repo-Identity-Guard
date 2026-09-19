/**
 * Inline line-icon set for the sidebar webview.
 *
 * VS Code's own Codicon font isn't bundled here (that would mean shipping
 * and loading extra font assets into the webview just for this), so instead
 * every icon is a small inline SVG using `currentColor` — same visual
 * language as Codicons (thin single-color line glyphs), no emoji, and no
 * extra network/font dependency. Every glyph is 16x16 with a 1.6px stroke.
 */
export const ICONS_JS = `
const ICONS = {
  shield: '<path d="M8 1.5 2.5 3.6v4.1c0 3.6 2.3 6.6 5.5 7.8 3.2-1.2 5.5-4.2 5.5-7.8V3.6L8 1.5Z"/>',
  shieldCheck: '<path d="M8 1.5 2.5 3.6v4.1c0 3.6 2.3 6.6 5.5 7.8 3.2-1.2 5.5-4.2 5.5-7.8V3.6L8 1.5Z"/><path d="m5.7 8.3 1.6 1.6 3-3.2"/>',
  shieldAlert: '<path d="M8 1.5 2.5 3.6v4.1c0 3.6 2.3 6.6 5.5 7.8 3.2-1.2 5.5-4.2 5.5-7.8V3.6L8 1.5Z"/><path d="M8 5.6v3"/><circle cx="8" cy="11" r="0.15" fill="currentColor" stroke="none"/>',
  shieldQuestion: '<path d="M8 1.5 2.5 3.6v4.1c0 3.6 2.3 6.6 5.5 7.8 3.2-1.2 5.5-4.2 5.5-7.8V3.6L8 1.5Z"/><path d="M6.6 6.6a1.4 1.4 0 1 1 2 1.3c-.6.3-.9.7-.9 1.3v.3"/><circle cx="7.7" cy="11" r="0.15" fill="currentColor" stroke="none"/>',
  gitBranch: '<circle cx="4.5" cy="3" r="1.5"/><circle cx="4.5" cy="13" r="1.5"/><circle cx="11.5" cy="6" r="1.5"/><path d="M4.5 4.5V11.5"/><path d="M4.5 6.5C4.5 8 6 8 7.5 8s4 0 4-2"/>',
  folder: '<path d="M2 4.2c0-.7.6-1.2 1.2-1.2h2.9l1.2 1.4h5.5c.7 0 1.2.6 1.2 1.2v6.2c0 .7-.6 1.2-1.2 1.2H3.2C2.6 13 2 12.5 2 11.8V4.2Z"/>',
  folderCopy: '<path d="M2 3.8c0-.6.5-1.1 1.1-1.1h2.5L6.7 4h4.9c.6 0 1.1.5 1.1 1.1v5.4c0 .6-.5 1.1-1.1 1.1H3.1C2.5 11.6 2 11.1 2 10.5V3.8Z"/><path d="M13.5 6v5.7c0 .6-.5 1.1-1.1 1.1H5"/>',
  user: '<circle cx="8" cy="5.2" r="2.4"/><path d="M3 14c.5-2.8 2.5-4.4 5-4.4s4.5 1.6 5 4.4"/>',
  userCircle: '<circle cx="8" cy="8" r="6.3"/><circle cx="8" cy="6.6" r="2"/><path d="M4 12.6c.6-1.9 2.1-3 4-3s3.4 1.1 4 3"/>',
  chevronRight: '<path d="m6 3.5 5 4.5-5 4.5"/>',
  chevronLeft: '<path d="m10 3.5-5 4.5 5 4.5"/>',
  arrowLeft: '<path d="M13.5 8h-11"/><path d="m6 3.5-4 4.5 4 4.5"/>',
  home: '<path d="m2.5 7.5 5.5-5 5.5 5"/><path d="M4 6.7V13c0 .5.4.9.9.9H11c.5 0 .9-.4.9-.9V6.7"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5V6h-3.5"/>',
  settings: '<circle cx="8" cy="8" r="2.1"/><path d="M8 2.2v1.6M8 12.2v1.6M13.8 8h-1.6M3.8 8H2.2M12 4l-1.1 1.1M5.1 10.9 4 12M12 12l-1.1-1.1M5.1 5.1 4 4"/>',
  pin: '<path d="M6.5 2.5h3l.5 4 2 2.2v1H4v-1l2-2.2z"/><path d="M8 9.7V13.5"/>',
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  trash: '<path d="M3.5 4.8h9M6.3 4.8V3.5h3.4v1.3M6.5 7.3v3.6M9.5 7.3v3.6"/><path d="M4.4 4.8 5 12.3c0 .5.5.9 1 .9h4c.5 0 .9-.4 1-.9l.6-7.5"/>',
  copy: '<rect x="6.3" y="6.3" width="6.7" height="6.7" rx="0.8"/><path d="M4.3 9.7H3.5c-.4 0-.8-.4-.8-.8V3.5c0-.4.4-.8.8-.8h5.4c.4 0 .8.4.8.8v.8"/>',
  play: '<path d="M5 3.2v9.6l8-4.8Z"/>',
  terminal: '<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="m5 6 2.3 2L5 10M8.5 10h2.7"/>',
  notes: '<rect x="2.5" y="2" width="11" height="12" rx="1"/><path d="M5 5.5h6M5 8h6M5 10.5h4"/>',
  memory: '<rect x="3" y="3" width="10" height="10" rx="1"/><path d="M6 3V1.5M10 3V1.5M6 14.5V13M10 14.5V13M3 6H1.5M3 10H1.5M14.5 6H13M14.5 10H13"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="1.8"/>',
  clipboard: '<rect x="4" y="3" width="8" height="11" rx="1"/><path d="M6.3 3V2c0-.3.3-.6.6-.6h2.2c.3 0 .6.3.6.6v1"/>',
  alertTriangle: '<path d="M8 2.3 14.5 13.5h-13Z"/><path d="M8 6.5v3.2"/><circle cx="8" cy="11.5" r="0.15" fill="currentColor" stroke="none"/>',
  checkCircle: '<circle cx="8" cy="8" r="6.3"/><path d="m5.3 8.2 1.8 1.8 3.6-3.8"/>',
  xCircle: '<circle cx="8" cy="8" r="6.3"/><path d="m6 6 4 4M10 6 6 10"/>',
  block: '<circle cx="8" cy="8" r="6.3"/><path d="m4.5 4.5 7 7"/>',
  compass: '<circle cx="8" cy="8" r="6.3"/><path d="m10.2 5.8-1.4 3-3 1.4 1.4-3z"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.3 7V5a2.7 2.7 0 0 1 5.4 0v2"/>',
  wrench: '<path d="M10.5 2.6a3 3 0 0 0-3.9 3.7L2.5 10.4a1.4 1.4 0 0 0 2 2l4.1-4.1a3 3 0 0 0 3.7-3.9l-1.9 1.9-1.6-.5-.5-1.6z"/>',
  power: '<path d="M8 2v5"/><path d="M4.6 4.3a5.2 5.2 0 1 0 6.8 0"/>',
  pulse: '<path d="M1.5 8.5h2.8l1.4-4 2.6 7 1.4-3h3.8"/>',
  link: '<path d="M6.8 9.2 9.2 6.8"/><path d="M6.4 4.4 8 2.8a2.6 2.6 0 0 1 3.7 3.7L10 8.1"/><path d="M9.6 11.6 8 13.2a2.6 2.6 0 0 1-3.7-3.7L6 8"/>',
  edit: '<path d="M11 2.5 13.5 5 5.8 12.7 2.8 13.2l.5-3Z"/><path d="M9.5 4 12 6.5"/>',
  check: '<path d="m3.3 8.3 3.2 3.2 6.2-6.8"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m13 13-2.6-2.6"/>',
  download: '<path d="M8 2v8"/><path d="m4.8 7.2 3.2 3.2 3.2-3.2"/><path d="M3 13h10"/>',
  upload: '<path d="M8 10V2"/><path d="m4.8 4.8 3.2-3.2 3.2 3.2"/><path d="M3 13h10"/>',
};
function icon(name, size) {
  const body = ICONS[name] || ICONS.shield;
  const s = size || 14;
  return '<span class="vs-icon" style="width:' + s + 'px;height:' + s + 'px" aria-hidden="true">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg></span>';
}
`;
