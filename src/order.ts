// Locale-independent UTF-16 code unit ordering. This matches JavaScript string
// relational comparison, preserves ASCII order, and does not normalise values.
export const ordinalStringCompare = (first: string, second: string) => {
  if (first < second) {
    return -1
  }
  if (first > second) {
    return 1
  }
  return 0
}
