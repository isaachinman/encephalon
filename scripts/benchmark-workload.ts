// Freeze published input limits in the common harness so revisions perform identical work.

export const shownIdForBenchmarkCase = (records: number) => {
  if (records === 0) {
    return 'missing'
  }
  const activeChainIndex = Math.max(0, Math.floor(records * 0.1) - 1)
  return `chain-${String(activeChainIndex).padStart(5, '0')}`
}

export const gatherBenchmarkInput = (records: number) => ({
  searches: Array.from({ length: 16 }, (_, index) => (index % 2 === 0 ? 'benchmark needle' : 'large payload')),
  shows: Array.from({ length: 64 }, (_, index) =>
    index % 2 === 0 ? shownIdForBenchmarkCase(records) : 'benchmark-missing',
  ),
})
