// The "tsk" module. __tsk is the runtime's native bridge.
const native = __tsk;

// GoIterable pulls a Go sequence in batches, so iteration crosses into Go
// once per batch rather than once per element.
class GoIterable {
  constructor(handle) {
    this.handle = handle;
  }

  // Each batch is a native array, so yield* steps through it with the
  // array's own iterator. finally stops the Go sequence however iteration ends.
  *[Symbol.iterator]() {
    const cursor = this.handle.open();
    try {
      for (;;) {
        const batch = cursor.pull(256);
        if (batch.length === 0) {
          return;
        }
        yield* batch;
      }
    } finally {
      cursor.stop();
    }
  }

  filter(predicate) {
    const filtered = this.handle.filter(predicate);
    return filtered === null ? new FilteredIterable(this, predicate) : new GoIterable(filtered);
  }

  toArray() {
    return Array.from(this);
  }
}

// FilteredIterable applies a JavaScript predicate to each element.
class FilteredIterable {
  constructor(source, predicate) {
    this.source = source;
    this.predicate = predicate;
  }

  *[Symbol.iterator]() {
    for (const value of this.source) {
      if (this.predicate(value)) {
        yield value;
      }
    }
  }

  filter(predicate) {
    return new FilteredIterable(this, predicate);
  }

  toArray() {
    return Array.from(this);
  }
}

native.setIterableFactory((handle) => new GoIterable(handle));

// GoError is the base class of every Go error. Go errors are thrown with the
// class of their error type or GoError; error variables are classes whose
// instanceof asks Go's errors.Is.
export class GoError extends Error {}
Object.defineProperty(GoError.prototype, "name", { value: "GoError", writable: true, configurable: true });

const unconstructable = (name) => () => {
  throw new TypeError(`${name} cannot be constructed`);
};

native.setErrorSupport({
  base: GoError,
  // create builds an exception, capturing the script's stack, then gives it
  // the prototype of the error's Go type.
  create(prototype, message) {
    const error = new GoError(message);
    Object.setPrototypeOf(error, prototype);
    return error;
  },
  sentinel(name, matches) {
    const sentinel = class extends GoError {
      constructor() {
        unconstructable(name)();
        super();
      }
    };
    Object.defineProperty(sentinel, "name", { value: name });
    Object.defineProperty(sentinel, Symbol.hasInstance, { value: matches });
    return sentinel;
  },
  errorType(name, prototype) {
    // biome-ignore lint/complexity/useArrowFunction: instanceof needs the prototype an arrow function lacks.
    const errorType = function () {
      unconstructable(name)();
    };
    Object.defineProperty(errorType, "name", { value: name });
    errorType.prototype = prototype;
    Object.defineProperty(prototype, "constructor", { value: errorType, configurable: true });
    return errorType;
  },
});

export function and(...predicates) {
  return native.combine("and", predicates) ?? ((value) => predicates.every((predicate) => predicate(value)));
}

export function or(...predicates) {
  return native.combine("or", predicates) ?? ((value) => predicates.some((predicate) => predicate(value)));
}

export function not(predicate) {
  return native.combine("not", [predicate]) ?? ((value) => !predicate(value));
}

// schema is inserted by the compiler from the call's config type argument.
export function defineAnalyzer(schema, definition) {
  if (typeof schema !== "number") {
    throw new TypeError("defineAnalyzer must be called directly so its config type can be read");
  }
  if (definition === null || typeof definition !== "object") {
    throw new TypeError("defineAnalyzer requires a definition object");
  }
  const analyzer = Object.freeze({ name: definition.name });
  native.registerAnalyzer(analyzer, definition, schema);
  return analyzer;
}

export function defineFact(name) {
  if (typeof name !== "string" || name === "") {
    throw new TypeError("defineFact requires a non-empty name");
  }
  return Object.freeze({ name });
}
