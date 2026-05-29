/**
 * shared.js — primitives common to the host and player views.
 *
 * These were previously copy-pasted into host.js and player.js; keeping a
 * single copy here prevents the colour palette, answer tiles, escaping, and
 * shape rendering from drifting apart between the two views.
 */

// ── Design tokens ──────────────────────────────────────────────────────────
export const C = {
  red:     '#EE3124',
  blue:    '#009DDC',
  gold:    '#FBB034',
  lime:    '#C1D82F',
  orange:  '#F47920',
  dark:    '#211F25',
  grey:    '#6D6E71',
  chalk:   '#FAFAF8',
  ink:     '#1A1820',
  inkSoft: '#3A3641',
};

// Answer tiles. `name` is used by the player view for accessibility; the host
// view simply ignores it.
export const TILES = [
  { letter: 'A', color: C.red,  shape: 'triangle', name: 'Red Triangle' },
  { letter: 'B', color: C.blue, shape: 'diamond',  name: 'Blue Diamond' },
  { letter: 'C', color: C.gold, shape: 'circle',   name: 'Gold Circle'  },
  { letter: 'D', color: C.lime, shape: 'square',   name: 'Lime Square'  },
];

// ── HTML escaping ──────────────────────────────────────────────────────────
export function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── SVG shapes ─────────────────────────────────────────────────────────────
export function shapeSVG(shape, size, color) {
  const p = `fill="${color}"`;
  if (shape === 'triangle') return `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><polygon points="20,3 38,37 2,37" ${p}/></svg>`;
  if (shape === 'diamond')  return `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><polygon points="20,2 38,20 20,38 2,20" ${p}/></svg>`;
  if (shape === 'circle')   return `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" ${p}/></svg>`;
  return                           `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><rect x="3" y="3" width="34" height="34" rx="2" ${p}/></svg>`;
}
