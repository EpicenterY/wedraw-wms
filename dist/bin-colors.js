// Identification colours belong to the bin, not its current cell or contents.
// Keep the dark wedraw green reserved for robots and selected-order outlines.
export const BIN_COLORS = Object.freeze([
  '#62afe0', '#efa565', '#b49ade', '#61c3ca',
  '#df8eaa', '#e8c966', '#7f9fe0', '#e98d7c'
]);

export function getBinColor(id) {
  let hash = 2166136261;
  for (const char of String(id || 'B0000')) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return BIN_COLORS[(hash >>> 0) % BIN_COLORS.length];
}
