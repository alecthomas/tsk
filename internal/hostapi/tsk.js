// The "tsk" module. __tsk is the runtime's native bridge.
const native = __tsk;

// GoIterable is a single-use iterator, so the standard helpers apply. It pulls
// in batches to cross into Go once per batch rather than once per element.
class GoIterable extends Iterator {
  constructor(handle) {
    super();
    this.handle = handle;
    this.cursor = null;
    this.batch = [];
    this.index = 0;
    this.done = false;
  }

  next() {
    while (this.index === this.batch.length) {
      if (this.done) {
        return { value: undefined, done: true };
      }
      this.cursor ??= this.handle.open();
      try {
        this.batch = this.cursor.pull(256);
      } catch (error) {
        this.return();
        throw error;
      }
      this.index = 0;
      if (this.batch.length === 0) {
        this.return();
      }
    }
    return { value: this.batch[this.index++], done: false };
  }

  // return stops the Go sequence; for-of calls it however a loop ends early.
  return() {
    this.done = true;
    this.batch = [];
    this.index = 0;
    this.cursor?.stop();
    this.cursor = null;
    return { value: undefined, done: true };
  }

  // A native predicate runs in Go, but only before iteration starts, since a
  // fresh Go sequence would restart from the beginning.
  filter(predicate) {
    if (this.cursor === null && !this.done) {
      const filtered = this.handle.filter(predicate);
      if (filtered !== null) {
        this.done = true;
        return new GoIterable(filtered);
      }
    }
    return super.filter(predicate);
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

export function formatNode(node, fset) {
  return native.formatNode(node, fset);
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
