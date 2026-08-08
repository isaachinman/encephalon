import { existsSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const [databasePath, readyPath, holdMillisecondsText] = process.argv.slice(2)

if (databasePath === undefined || readyPath === undefined || holdMillisecondsText === undefined) {
  throw new Error('Expected a database path, ready path, and hold duration.')
}

const holdMilliseconds = Number(holdMillisecondsText)
if (!(Number.isInteger(holdMilliseconds) && holdMilliseconds > 0)) {
  throw new Error('Expected a positive integer hold duration.')
}

const wait = (milliseconds: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

const database = new DatabaseSync(databasePath, { timeout: 1000 })
try {
  database.exec('PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE')
  writeFileSync(readyPath, 'ready')
  const deadline = Date.now() + holdMilliseconds
  while (Date.now() < deadline && existsSync(databasePath)) {
    wait(10)
  }
  database.exec('ROLLBACK')
} finally {
  database.close()
}
