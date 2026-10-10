import * as ast from "go/ast";
import { isCallToExitFunction, isPkgDotName } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "deep-exit";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const isTest = file.isTest();
  ast.inspect(file.ast, (n) => {
    if (n?.$type === "FuncDecl") {
      return !mustIgnore(n as ast.FuncDecl, isTest);
    }
    if (n?.$type !== "ExprStmt") {
      return true;
    }
    const call = (n as ast.ExprStmt).x;
    if (call?.$type !== "CallExpr") {
      return true;
    }
    const ce = call as ast.CallExpr;
    if (ce.fun?.$type !== "SelectorExpr") {
      return true;
    }
    const fc = ce.fun as ast.SelectorExpr;
    if (fc.x?.$type !== "Ident") {
      return true;
    }
    const pkg = (fc.x as ast.Ident).name;
    const fn = fc.sel!.name;
    if (!isCallToExitFunction(pkg, fn, ce.args)) {
      return true;
    }
    let msg = `calls to ${pkg}.${fn} only in main() or init() functions`;
    if (pkg === "flag" && fn === "Parse") {
      msg += "; move the call or refactor to use flag.NewFlagSet with flag.ContinueOnError";
    } else if (pkg === "flag" && fn === "NewFlagSet" && ce.args.length === 2 && isPkgDotName(ce.args[1], "flag", "ExitOnError")) {
      msg = "calls to flag.NewFlagSet with flag.ExitOnError only in main() or init() functions";
    }
    failures.push({ failure: msg, node: ce, confidence: 1 });
    return true;
  });
  return failures;
}

function mustIgnore(fd: ast.FuncDecl, isTest: boolean): boolean {
  const fn = fd.name!.name;
  return fn === "init" || fn === "main" || (isTest && (fn === "TestMain" || isTestExample(fd)));
}

// isTestExample reports whether fd is a testable example, as go/doc decides.
function isTestExample(fd: ast.FuncDecl): boolean {
  const name = fd.name!.name;
  const prefix = "Example";
  if (!name.startsWith(prefix)) {
    return false;
  }
  if (name.length > prefix.length) {
    const r = String.fromCodePoint(name.codePointAt(prefix.length)!);
    if (isLower(r)) {
      return false;
    }
  }
  return fd.type!.params!.list.length === 0;
}

// isLower approximates unicode.IsLower with case mapping.
function isLower(r: string): boolean {
  return r.toUpperCase() !== r && r.toLowerCase() === r;
}
