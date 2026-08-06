import { writeFileSync } from "node:fs"
import { withOperationLock } from "../../src/lock.ts"

const [root, readyPath] = process.argv.slice(2)

if (root === undefined || readyPath === undefined) {
  throw new Error("Expected a repository root and ready path.")
}

withOperationLock(root, () => {
  writeFileSync(readyPath, "ready")
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750)
})
