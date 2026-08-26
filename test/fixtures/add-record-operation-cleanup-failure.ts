import { recordWriteTestHooks } from '../../src/records.ts'

recordWriteTestHooks.gateClose = database => {
  database.close()
  throw Object.assign(new Error(`Injected SQLite cleanup failure at ${process.cwd()}`), { code: 'EIO' })
}

await import('../../src/cli.ts')
