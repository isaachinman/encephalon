// @ts-expect-error Node 26-only modules must not be available to runtime source typechecking.
import type { dlopen } from 'node:ffi'

export type Node26OnlyRuntimeApi = typeof dlopen
