type WorkObserver<Operation extends string> = (operation: Operation) => void

class WorkObserverError extends Error {}

const invokeWorkObserver = <Operation extends string>(observer: WorkObserver<Operation>, operation: Operation) => {
  try {
    observer(operation)
  } catch (error) {
    throw new WorkObserverError('Internal work observer failed.', { cause: error })
  }
}

/** @internal */
export const reportWork = <Operation extends string>(observer: WorkObserver<Operation>, operation: Operation) =>
  invokeWorkObserver(observer, operation)

/** @internal */
export const observeWork = <Operation extends string>(
  observer: WorkObserver<Operation> | undefined,
  operation: Operation,
) => {
  if (observer !== undefined) {
    return () => invokeWorkObserver(observer, operation)
  }
}

/** @internal */
export const rethrowWorkObserverError = (error: unknown) => {
  if (error instanceof WorkObserverError) {
    throw error.cause
  }
}

const isArrayIndex = (property: string | symbol) => typeof property === 'string' && /^(?:0|[1-9]\d*)$/.test(property)

/** @internal */
export const observedArray = <Value>(onRead?: () => void, onWrite?: () => void) => {
  const values: Value[] = []
  if (onRead !== undefined || onWrite !== undefined) {
    return new Proxy(values, {
      get: (target, property, receiver) => {
        if (isArrayIndex(property)) {
          onRead?.()
        }
        return Reflect.get(target, property, receiver) as unknown
      },
      set: (target, property, value, receiver) => {
        if (isArrayIndex(property)) {
          onWrite?.()
        }
        return Reflect.set(target, property, value, receiver)
      },
    })
  }
  return values
}

/** @internal */
export const observedMap = <Key, Value>(onWrite?: () => void) => {
  if (onWrite !== undefined) {
    return new (class extends Map<Key, Value> {
      override set(key: Key, value: Value) {
        onWrite()
        return super.set(key, value)
      }
    })()
  }
  return new Map<Key, Value>()
}

/** @internal */
export const observedSet = <Value>(onWrite?: () => void) => {
  if (onWrite !== undefined) {
    return new (class extends Set<Value> {
      override add(value: Value) {
        onWrite()
        return super.add(value)
      }
    })()
  }
  return new Set<Value>()
}
