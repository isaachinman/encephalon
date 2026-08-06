import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { EncephalonError, fail, wrapIo } from "./errors.ts"

const LOCK_WAIT_MILLISECONDS = 60_000
const POLL_MILLISECONDS = 50

type LockOwner = {
  token: string
  pid: number
  acquiredAt: string
}

type LockTestHooks = {
  afterStaleObservation?: () => void
}

const sleep = (milliseconds: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const readOwner = (path: string): LockOwner | undefined => {
  try {
    const value = JSON.parse(readFileSync(resolve(path, "owner.json"), "utf8")) as Partial<LockOwner>
    if (
      typeof value.token === "string" &&
      Number.isInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      typeof value.acquiredAt === "string"
    ) {
      return value as LockOwner
    }
    return undefined
  } catch {
    return undefined
  }
}

const releaseOwnedLock = (path: string, token: string) => {
  const owner = readOwner(path)
  if (owner?.token === token) {
    rmSync(path, { recursive: true, force: true })
  }
}

const sqliteBusy = (error: unknown) => {
  const candidate = error as { errcode?: unknown; message?: unknown }
  return (
    candidate.errcode === 5 ||
    candidate.errcode === 6 ||
    (typeof candidate.message === "string" && /(?:database is locked|SQLITE_BUSY|SQLITE_LOCKED)/i.test(candidate.message))
  )
}

export const cacheDirectory = (root: string) => resolve(root, "node_modules", ".cache", "encephalon")

export const withOperationLock = <Result>(
  root: string,
  operation: () => Result,
  testHooks: LockTestHooks = {},
): Result => {
  const directory = cacheDirectory(root)
  const lockPath = resolve(directory, "operation.lock")
  const gatePath = resolve(directory, "operation-lock.sqlite")
  const token = randomUUID()
  const candidatePath = resolve(directory, `operation.lock.${token}`)
  const startedAt = Date.now()
  let gate: DatabaseSync | undefined
  let gateTransaction = false

  try {
    mkdirSync(directory, { recursive: true })
    mkdirSync(candidatePath)
    const candidateOwner: LockOwner = { token, pid: process.pid, acquiredAt: new Date().toISOString() }
    writeFileSync(resolve(candidatePath, "owner.json"), `${JSON.stringify(candidateOwner)}\n`, { flag: "wx" })

    const observedOwner = existsSync(lockPath) ? readOwner(lockPath) : undefined
    if (existsSync(lockPath) && (observedOwner === undefined || !processExists(observedOwner.pid))) {
      testHooks.afterStaleObservation?.()
    }

    const remaining = Math.max(0, LOCK_WAIT_MILLISECONDS - (Date.now() - startedAt))
    gate = new DatabaseSync(gatePath, { timeout: remaining })
    try {
      gate.exec("BEGIN IMMEDIATE")
      gateTransaction = true
    } catch (error) {
      if (sqliteBusy(error)) {
        return fail("CACHE_BUSY", "Timed out waiting for the Encephalon operation lock.", {
          timeoutMilliseconds: LOCK_WAIT_MILLISECONDS,
        })
      }
      throw error
    }

    while (existsSync(lockPath)) {
      const owner = readOwner(lockPath)
      if (owner === undefined || !processExists(owner.pid)) {
        rmSync(lockPath, { recursive: true, force: true })
      } else if (Date.now() - startedAt <= LOCK_WAIT_MILLISECONDS) {
        sleep(POLL_MILLISECONDS)
      } else {
        return fail("CACHE_BUSY", "Timed out waiting for the Encephalon operation lock.", {
          timeoutMilliseconds: LOCK_WAIT_MILLISECONDS,
        })
      }
    }

    renameSync(candidatePath, lockPath)
    try {
      return operation()
    } finally {
      releaseOwnedLock(lockPath, token)
    }
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo("Unable to coordinate Encephalon cache access.", error)
  } finally {
    if (gateTransaction) {
      try {
        gate?.exec("ROLLBACK")
      } catch {
        // Closing the connection below releases its operating-system lock.
      }
    }
    gate?.close()
    rmSync(candidatePath, { recursive: true, force: true })
  }
}
