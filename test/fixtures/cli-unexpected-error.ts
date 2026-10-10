Object.defineProperty(process.stdout, 'write', {
  value: () => {
    throw new TypeError('Injected stdout failure.')
  },
})

await import('../../src/cli.ts')
