import type * as ast from "go/ast";
import * as types from "go/types";
import { goFmt, isPointerToPkgDotType, walk, type Visitor } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "unhandled-error";

export interface Options {
  /** Regular expressions matching whole names of functions whose errors may go unhandled. */
  ignoreList: string[];
}

export const defaults: Options = { ignoreList: [] };

export function create(options: DeepReadonly<Options>): Rule {
  // Patterns are JavaScript regular expressions, where revive's are Go's.
  const ignoreList = options.ignoreList.map((arg) => {
    const pattern = arg.replace(/^ +| +$/g, "");
    if (pattern === "") {
      throw new Error("invalid argument to the unhandled-error rule, expected regular expression must not be empty");
    }
    try {
      return new RegExp(pattern);
    } catch (e) {
      throw new Error(`invalid argument to the unhandled-error rule: regexp "${pattern}" does not compile: ${e}`);
    }
  });
  const isIgnored = (funcName: string) =>
    ignoreList.some((re) => {
      const m = re.exec(funcName);
      return (m === null ? 0 : m[0].length) === funcName.length;
    });
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      const addFailure = (call: ast.CallExpr) => {
        const funcName = nameOf(file, call);
        if (isIgnored(funcName) || isSafeFprintfToBuffer(file, call)) {
          return;
        }
        failures.push({ node: call, confidence: 1, failure: `Unhandled error in call to function ${funcName}` });
      };
      const visitor: Visitor = {
        visit(node) {
          if (node === null || node.$type !== "ExprStmt") {
            return visitor;
          }
          const x = (node as ast.ExprStmt).x!;
          if (x.$type !== "CallExpr") {
            return null;
          }
          const call = x as ast.CallExpr;
          const t = file.pkg.typeOf(call);
          if (t === null) {
            return null;
          }
          if (t.$type === "Named") {
            if (!isTypeError(t)) {
              return null;
            }
            addFailure(call);
          } else {
            const tuple = t.underlying();
            if (tuple === null || tuple.$type !== "Tuple") {
              return null;
            }
            if ([...tuple.variables()].some((v) => isTypeError(v!.type()))) {
              addFailure(call);
            }
          }
          return visitor;
        },
      };
      walk(visitor, file.ast);
      return failures;
    },
  };
}

function isTypeError(t: types.Type | null): boolean {
  return t !== null && t.$type === "Named" && t.obj()!.id() === "_.error";
}

function getFunc(file: File, call: ast.CallExpr): types.Func | null {
  if (call.fun!.$type !== "SelectorExpr") {
    return null;
  }
  const obj = file.pkg.typesInfo.objectOf((call.fun as ast.SelectorExpr).sel);
  return obj !== null && obj.$type === "Func" ? obj : null;
}

function nameOf(file: File, call: ast.CallExpr): string {
  const fn = getFunc(file, call);
  if (fn === null) {
    return goFmt(call.fun!);
  }
  return fullName(file, fn).replace(/[()*]/g, "");
}

// fullName is types.Func.FullName, except that it qualifies the linted
// package by its name, not its path, because revive type-checks it so.
function fullName(file: File, fn: types.Func): string {
  const pkg = file.pkg.typesPkg;
  const qualifier = (p: types.Package | null) => (p!.path() === pkg.path() ? pkg.name() : p!.path());
  const recv = fn.signature()!.recv();
  if (recv !== null) {
    const t = recv.type();
    return `(${t !== null && t.$type === "Interface" ? "interface" : types.typeString(t, qualifier)}).${fn.name()}`;
  }
  const fnPkg = fn.pkg();
  return fnPkg === null ? fn.name() : `${qualifier(fnPkg)}.${fn.name()}`;
}

function isSafeFprintfToBuffer(file: File, call: ast.CallExpr): boolean {
  if (call.args.length === 0) {
    return false;
  }
  const fn = getFunc(file, call);
  if (fn === null || fullName(file, fn) !== "fmt.Fprintf") {
    return false;
  }
  const argType = file.pkg.typeOf(call.args[0]!);
  return argType !== null && (isPointerToPkgDotType(argType, "bytes", "Buffer") || isPointerToPkgDotType(argType, "strings", "Builder"));
}
