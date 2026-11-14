// Group colours, shared by the canvas world and the DOM shell. Keys are the GroupColor values in
// server/contract.mjs. Hues are chosen to stay clear of every other colour that carries meaning:
//   tool colours   - Claude coral (~15deg), Codex mint (~160deg), Cursor violet-blue (~250deg)
//   needs you      - bright yellow (~50deg)
//   failure        - red
// Each has a base, a dark shade for outlines/rug edges, a light tint for floor rugs, and an ink
// colour for text set on the base.

export const GROUP_COLOR_KEYS = ['gold', 'rose', 'lime', 'sky', 'plum', 'sand'];

export const GROUP_COLORS = {
  // A dark olive-mustard, never a bright yellow.
  gold: { base: '#a8902c', dark: '#5c4c0c', tint: '#ddd2a0', ink: '#141003' },
  // Hot pink.
  rose: { base: '#f0609c', dark: '#901c54', tint: '#f8bcd4', ink: '#2a0616' },
  // Yellow-green, well away from mint.
  lime: { base: '#8cc828', dark: '#3c6c08', tint: '#cfeaa0', ink: '#0e1c03' },
  // Cyan, well away from the Cursor violet-blue.
  sky: { base: '#30c0e0', dark: '#0c647c', tint: '#aee6f2', ink: '#03181e' },
  // Magenta-orchid: redder than the Cursor violet.
  plum: { base: '#cc50c0', dark: '#701c68', tint: '#ecbce8', ink: '#22061e' },
  // Warm grey-brown.
  sand: { base: '#b89878', dark: '#684c30', tint: '#e6d6c4', ink: '#1c1208' },
};

/** Human names for the swatches (the keys are historical). */
export const GROUP_COLOR_NAMES = { gold: 'OLIVE', rose: 'PINK', lime: 'LIME', sky: 'CYAN', plum: 'ORCHID', sand: 'SAND' };

/** Colour record for a group (or a neutral grey when the key is unknown). */
export function groupColor(key) {
  return GROUP_COLORS[key] || { base: '#9aa0b4', dark: '#4a4e60', tint: '#d4d8e4', ink: '#0b0b12' };
}

/** What to show as a session's name-of-task: the user's label if set, else the tool's own title. */
export function taskName(session) {
  return (session && (session.label || session.title)) || '';
}
