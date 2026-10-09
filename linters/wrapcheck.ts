import * as ast from "go/ast";
import * as types from "go/types";
import type * as inspector from "golang.org/x/tools/go/ast/inspector";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { globToRegExp } from "./internal/glob";

interface Config {
  /** Signature substrings to ignore, on top of ignore-sigs. */
  extraIgnoreSigs: readonly string[];
  /** Signature substrings to ignore. An empty list keeps the defaults. */
  ignoreSigs: readonly string[];
  /** Signature regular expressions to ignore. */
  ignoreSigRegexps: readonly string[];
  /** Globs of packages whose errors need no wrapping. */
  ignorePackageGlobs: readonly string[];
  /** Interface name regular expressions whose errors need no wrapping. */
  ignoreInterfaceRegexps: readonly string[];
  /** Also report errors returned from the same package. */
  reportInternalErrors: boolean;
}

const defaultIgnoreSigs = [".Errorf(", "errors.New(", "errors.Unwrap(", "errors.Join(", ".Wrap(", ".Wrapf(", ".WithMessage(", ".WithMessagef(", ".WithStack("];

// Matchers holds the compiled configuration.
interface Matchers {
  config: Config;
  ignoreSigs: readonly string[];
  sigRegexps: RegExp[];
  interfaceRegexps: RegExp[];
  packageGlobs: RegExp[];
}

export default defineAnalyzer<Config>({
  name: "wrapcheck",
  doc: "Checks that errors returned from external packages are wrapped",
  requires: [inspect],
  config: {
    extraIgnoreSigs: [],
    ignoreSigs: defaultIgnoreSigs,
    ignoreSigRegexps: [],
    ignorePackageGlobs: [],
    ignoreInterfaceRegexps: [],
    reportInternalErrors: false,
  },
  run(pass) {
    const c = pass.config;
    const m: Matchers = {
      config: c,
      ignoreSigs: c.ignoreSigs.length === 0 ? defaultIgnoreSigs : c.ignoreSigs,
      sigRegexps: c.ignoreSigRegexps.map((re) => new RegExp(re)),
      interfaceRegexps: c.ignoreInterfaceRegexps.map((re) => new RegExp(re)),
      packageGlobs: c.ignorePackageGlobs.map((glob) => globToRegExp(glob)),
    };
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.ReturnStmt)) {
      const file = cursor.enclosing(ast.File).toArray()[0].node() as ast.File;
      checkReturn(pass, m, file, cursor);
    }
  },
});

function checkReturn(pass: Pass<Config>, m: Matchers, file: ast.File, cursor: inspector.Cursor): void {
  const ret = cursor.node() as ast.ReturnStmt;
  for (const expr of ret.results) {
    if (expr!.$type === "CallExpr") {
      // Returns inside function literals are not checked.
      const fn = cursor.enclosing(ast.FuncLit, ast.FuncDecl).toArray()[0]?.node();
      if (fn?.$type === "FuncLit") {
        return;
      }
      const t = pass.typesInfo.typeOf(expr);
      if (isError(t)) {
        reportUnwrapped(pass, m, expr, expr.pos());
        return;
      }
      if (t?.$type !== "Tuple") {
        return;
      }
      for (let i = 0; i < t.len(); i++) {
        const v = t.at(i);
        if (v === null) {
          return;
        }
        if (isError(v.type())) {
          reportUnwrapped(pass, m, expr, expr.pos());
          return;
        }
      }
    }
    if (!isError(pass.typesInfo.typeOf(expr))) {
      continue;
    }
    if (expr!.$type !== "Ident") {
      return;
    }
    const call = producingCall(pass, file, expr);
    if (call === null) {
      return;
    }
    reportUnwrapped(pass, m, call, expr.pos());
  }
}

// producingCall finds the call whose error a returned identifier holds: the
// most recent assignment to it, or else its var declaration.
function producingCall(pass: Pass<Config>, file: ast.File, ident: ast.Ident): ast.CallExpr | null {
  const assign = prevErrAssign(pass, file, ident);
  if (assign !== null) {
    const rhs = assign.rhs[0];
    return rhs?.$type === "CallExpr" ? rhs : null;
  }
  if (file.unresolved.some((u) => u!.pos() === ident.pos())) {
    return null;
  }
  const decl = ident.obj?.decl as ast.Node | null | undefined;
  if (decl?.$type !== "ValueSpec" || decl.values.length < 1) {
    return null;
  }
  const value = decl.values[0];
  return value?.$type === "CallExpr" ? value : null;
}

// prevErrAssign returns the last assignment to the same error declaration
// before the return, ignoring var declarations.
function prevErrAssign(pass: Pass<Config>, file: ast.File, ident: ast.Ident): ast.AssignStmt | null {
  const assigns: ast.AssignStmt[] = [];
  ast.inspect(file, (node) => {
    if (node?.$type !== "AssignStmt") {
      return true;
    }
    for (const lhs of node.lhs) {
      if (!isError(pass.typesInfo.typeOf(lhs)) || lhs!.$type !== "Ident") {
        continue;
      }
      // Declarations are compared by identity, so unresolved names stop here.
      if (lhs.obj === null || ident.obj === null) {
        return true;
      }
      if (lhs.obj.decl === ident.obj.decl) {
        assigns.push(node);
      }
    }
    return true;
  });
  let recent: ast.AssignStmt | null = null;
  for (const assign of assigns) {
    if (assign.pos() > ident.pos()) {
      break;
    }
    recent = assign;
  }
  return recent;
}

function reportUnwrapped(pass: Pass<Config>, m: Matchers, call: ast.CallExpr, pos: number): void {
  if (m.config.reportInternalErrors && call.fun?.$type === "Ident") {
    const sig = pass.typesInfo.objectOf(call.fun)?.string() ?? "";
    if (!ignoredSignature(m, sig)) {
      pass.report({ pos, message: `package-internal error should be wrapped: sig: ${sig}` });
    }
    return;
  }
  if (call.fun?.$type !== "SelectorExpr") {
    return;
  }
  const sel = call.fun;
  const fn = pass.typesInfo.objectOf(sel.sel);
  const pkg = fn?.pkg();
  if (fn === null || fn === undefined || pkg === null || pkg === undefined) {
    return;
  }
  const sig = fn.string();
  if (ignoredSignature(m, sig)) {
    return;
  }
  const ignoredPackage = m.packageGlobs.some((glob) => glob.test(pkg.path()));
  const x = pass.typesInfo.typeOf(sel.x);
  if (sel.sel!.isExported() && x !== null && types.isInterface(x)) {
    const name = types.typeString(x, (p) => p!.name());
    if (!m.interfaceRegexps.some((re) => re.test(name)) && !ignoredPackage) {
      pass.report({ pos, message: `error returned from interface method should be wrapped: sig: ${sig}` });
      return;
    }
  }
  if (!ignoredPackage && pass.pkg.path() !== pkg.path()) {
    pass.report({ pos, message: `error returned from external package is unwrapped: sig: ${sig}` });
  } else if (m.config.reportInternalErrors) {
    pass.report({ pos, message: `package-internal error should be wrapped: sig: ${sig}` });
  }
}

function ignoredSignature(m: Matchers, sig: string): boolean {
  return m.ignoreSigs.some((s) => sig.includes(s)) || m.config.extraIgnoreSigs.some((s) => sig.includes(s)) || m.sigRegexps.some((re) => re.test(sig));
}

function isError(t: types.Type | null): boolean {
  return t !== null && t.string() === "error";
}
