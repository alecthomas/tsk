import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, type Pass } from "tsk";
import { unquote } from "./internal/strconv";

interface Config {
  /** Report checking the error of encoding a value that cannot fail to encode. */
  checkErrorFreeEncoding: boolean;
  /** Report encoding a struct with no exported fields. */
  reportNoExported: boolean;
}

export default defineAnalyzer<Config>({
  name: "errchkjson",
  doc: `checks types passed to the json encoding functions

Reports types encoding/json cannot encode, and errors from encoding left
unchecked. Values of only booleans, integers, and strings cannot fail, so with
check-error-free-encoding, checking their error is reported and leaving it
unchecked is allowed.`,
  config: { checkErrorFreeEncoding: false, reportNoExported: false },
  run(pass) {
    new Checker(pass).run();
  },
});

// ErrorTarget is where an encoding call's error goes.
type ErrorTarget = "blank" | "variable" | "argument";

// Unsafe types may fail to encode. Unsupported ones always fail, and structs
// with no exported fields encode as {}.
type Problem = { kind: "unsafe" | "unsupported" | "noExported"; message: string };

const marshalFunctions = new Set(["encoding/json.Marshal", "encoding/json.MarshalIndent"]);
const encodeMethod = "(*encoding/json.Encoder).Encode";

class Checker {
  // Without check-error-free-encoding, a safe value's error may be left
  // unchecked and a checked one is not reported.
  private readonly omitSafe: boolean;
  private readonly textMarshaler = marshalerInterface("MarshalText");
  private readonly jsonMarshaler = marshalerInterface("MarshalJSON");

  constructor(private readonly pass: Pass<Config>) {
    this.omitSafe = !pass.config.checkErrorFreeEncoding;
  }

  run(): void {
    for (const file of this.pass.files) {
      ast.inspect(file, (node) => {
        switch (node?.$type) {
          case "ReturnStmt":
            return false;
          case "CallExpr": {
            const name = this.calleeName(node);
            if (name === null) {
              return true;
            }
            if (!this.handle(node, name, "blank")) {
              this.inspectArgs(node.args);
            }
            return false;
          }
          case "AssignStmt": {
            const call = node.rhs[0];
            if (call?.$type !== "CallExpr") {
              return true;
            }
            const name = this.calleeName(call);
            if (name === null) {
              return true;
            }
            // Marshal returns its error second, Encode first.
            const target = node.lhs[marshalFunctions.has(name) ? 1 : 0] ?? null;
            return !this.handle(call, name, target?.$type === "Ident" && target.name === "_" ? "blank" : "variable");
          }
        }
        return true;
      });
    }
  }

  private calleeName(call: ast.CallExpr): string | null {
    const callee = typeutil.callee(this.pass.typesInfo, call);
    return callee?.$type === "Func" ? callee.fullName() : null;
  }

  // handle checks a call to an encoding function, reporting whether it was
  // one.
  private handle(call: ast.CallExpr, name: string, target: ErrorTarget): boolean {
    if (marshalFunctions.has(name)) {
      this.check(call, name, target, this.omitSafe);
      return true;
    }
    if (name === encodeMethod) {
      this.check(call, name, target, true);
      return true;
    }
    return false;
  }

  // inspectArgs checks calls passed directly as arguments, and theirs. A
  // call with no declared callee, as through a function value, has its
  // function and arguments checked the same way.
  private inspectArgs(args: readonly (ast.Expr | null)[]): void {
    for (const arg of args) {
      if (arg?.$type !== "CallExpr") {
        continue;
      }
      const name = this.calleeName(arg);
      if (name === null) {
        this.inspectArgs([arg.fun, ...arg.args]);
      } else if (!this.handle(arg, name, "argument")) {
        this.inspectArgs(arg.args);
      }
    }
  }

  private check(call: ast.CallExpr, name: string, target: ErrorTarget, omitSafe: boolean): void {
    const pass = this.pass;
    let t = pass.typesInfo.typeOf(call.args[0]!);
    if (t === null) {
      if (target === "blank") {
        pass.report({ pos: call.pos(), message: `Type of argument to \`${name}\` could not be evaluated and error return value is not checked` });
      }
      return;
    }
    if (t.$type === "Pointer") {
      t = t.elem();
    }
    const problem = this.jsonSafe(t!, 0, new Set());
    if (problem !== null) {
      if (problem.kind === "unsupported") {
        pass.report({ pos: call.pos(), message: `\`${name}\` for ${problem.message}` });
        return;
      }
      if (problem.kind === "noExported") {
        pass.report({ pos: call.pos(), message: `Error argument passed to \`${name}\` does not contain any exported field` });
      }
      if (target === "blank") {
        pass.report({ pos: call.pos(), message: `Error return value of \`${name}\` is not checked: ${problem.message}` });
      }
      return;
    }
    if (target === "variable" && !omitSafe) {
      pass.report({ pos: call.pos(), message: `Error return value of \`${name}\` is checked but passed argument is safe` });
    }
    if (target === "blank" && omitSafe) {
      pass.report({ pos: call.pos(), message: `Error return value of \`${name}\` is not checked` });
    }
  }

  // jsonSafe finds why a type might not encode. Structs seen before are
  // safe, as their fields are checked where first seen.
  private jsonSafe(t: types.Type, level: number, seen: Set<types.Type>): Problem | null {
    if (seen.has(t)) {
      return null;
    }
    if (types.implements_(t, this.textMarshaler) || types.implements_(t, this.jsonMarshaler)) {
      return unsafe(`unsafe type \`${t.string()}\` found`);
    }
    const underlying = t.underlying()!;
    switch (underlying.$type) {
      case "Basic": {
        const info = underlying.info();
        if ((info & (types.IsBoolean | types.IsInteger | types.IsString)) !== 0) {
          return (info & types.IsString) !== 0 && t.string() === "encoding/json.Number" ? unsafe(`unsafe type \`${t.string()}\` found`) : null;
        }
        if ((info & types.IsComplex) !== 0) {
          return unsupported(`unsupported type \`${underlying.string()}\` found`);
        }
        switch (underlying.kind()) {
          case types.UntypedNil:
            return null;
          case types.UnsafePointer:
            return unsupported(`unsupported type \`${underlying.string()}\` found`);
        }
        return unsafe(`unsafe type \`${underlying.string()}\` found`);
      }
      case "Array":
      case "Slice":
      case "Pointer":
        return this.jsonSafe(underlying.elem()!, level + 1, seen);
      case "Struct": {
        seen.add(t);
        let exported = 0;
        for (let i = 0; i < underlying.numFields(); i++) {
          const field = underlying.field(i)!;
          if (!field.exported() || lookupTag(underlying.tag(i), "json") === "-") {
            continue;
          }
          const problem = this.jsonSafe(field.type()!, level + 1, seen);
          if (problem !== null) {
            return problem;
          }
          exported++;
        }
        if (this.pass.config.reportNoExported && level === 0 && exported === 0) {
          return { kind: "noExported", message: "struct does not export any field" };
        }
        return null;
      }
      case "Map":
        return this.jsonSafeMapKey(underlying.key()!) ?? this.jsonSafe(underlying.elem()!, level + 1, seen);
      case "Chan":
      case "Signature":
        return unsupported(`unsupported type \`${underlying.string()}\` found`);
    }
    return unsafe(`unsafe type \`${t.string()}\` found`);
  }

  private jsonSafeMapKey(t: types.Type): Problem | null {
    if (types.implements_(t, this.textMarshaler) || types.implements_(t, this.jsonMarshaler)) {
      return unsafe(`unsafe type \`${t.string()}\` as map key found`);
    }
    const underlying = t.underlying()!;
    switch (underlying.$type) {
      case "Basic": {
        const info = underlying.info();
        if ((info & types.IsString) !== 0 && t.string() === "encoding/json.Number") {
          return unsafe(`unsafe type \`${t.string()}\` as map key found`);
        }
        if ((info & (types.IsInteger | types.IsString)) !== 0) {
          return null;
        }
        return unsupported(`unsupported type \`${t.string()}\` as map key found`);
      }
      case "Interface":
        return unsafe(`unsafe type \`${t.string()}\` as map key found`);
    }
    return unsupported(`unsupported type \`${t.string()}\` as map key found`);
  }
}

function unsafe(message: string): Problem {
  return { kind: "unsafe", message };
}

function unsupported(message: string): Problem {
  return { kind: "unsupported", message };
}

// marshalerInterface is interface { name() ([]byte, error) }.
function marshalerInterface(name: string): types.Interface {
  const results = types.newTuple(
    types.newVar(token.NoPos, null, "", types.newSlice(types.Universe!.lookup("byte")!.type())),
    types.newVar(token.NoPos, null, "", types.Universe!.lookup("error")!.type()),
  );
  const method = types.newFunc(token.NoPos, null, name, types.newSignatureType(null, [], [], null, results, false));
  const iface = types.newInterfaceType([method], [])!;
  iface.complete();
  return iface;
}

// lookupTag ports reflect.StructTag.Lookup, returning undefined when the tag
// has no such key or is malformed before it.
function lookupTag(tag: string, key: string): string | undefined {
  let rest = tag;
  while (rest !== "") {
    rest = rest.replace(/^ +/, "");
    let i = 0;
    while (i < rest.length && rest.charCodeAt(i) > 0x20 && rest[i] !== ":" && rest[i] !== '"' && rest.charCodeAt(i) !== 0x7f) {
      i++;
    }
    if (i === 0 || i + 1 >= rest.length || rest[i] !== ":" || rest[i + 1] !== '"') {
      return undefined;
    }
    const name = rest.slice(0, i);
    rest = rest.slice(i + 1);
    i = 1;
    while (i < rest.length && rest[i] !== '"') {
      if (rest[i] === "\\") {
        i++;
      }
      i++;
    }
    if (i >= rest.length) {
      return undefined;
    }
    const quoted = rest.slice(0, i + 1);
    rest = rest.slice(i + 1);
    if (name === key) {
      return unquote(quoted) ?? undefined;
    }
  }
  return undefined;
}
