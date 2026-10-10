import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface Checks {
  /** Check that helpers start by calling Helper(). */
  begin: boolean;
  /** Check that the testing parameter comes first, or after a context.Context. */
  first: boolean;
  /** Check that the testing parameter has its usual name. */
  name: boolean;
}

interface Config {
  /** Checks of helpers taking *testing.T. */
  test: Checks;
  /** Checks of helpers taking *testing.F. */
  fuzz: Checks;
  /** Checks of helpers taking *testing.B. */
  benchmark: Checks;
  /** Checks of helpers taking testing.TB. */
  tb: Checks;
}

const allChecks: Checks = { begin: true, first: true, name: true };

export default defineAnalyzer<Config>({
  name: "thelper",
  doc: `detects test helpers which do not start with the t.Helper() method

Helpers, functions taking a *testing.T, *testing.B, *testing.F, or
testing.TB, should call its Helper method first, so failures report the
caller's line. They should also take it first, or after a context.Context,
and name it t, b, f, or tb. Functions run as subtests are not helpers.`,
  config: { test: allChecks, fuzz: allChecks, benchmark: allChecks, tb: allChecks },
  requires: [inspect],
  run(pass) {
    new Checker(pass).run();
  },
});

// Options describe one kind of helper.
interface Options {
  skipPrefix: string;
  varName: string;
  helper: types.Object | null;
  subRun: types.Object | null;
  subTestFuncType: types.Type | null;
  helperType: types.Type | null;
  ctxType: types.Type | null;
  checks: Pass<Config>["config"]["test"];
}

// FuncInfo is a function declaration or literal.
interface FuncInfo {
  pos: token.Pos;
  name: string;
  type: ast.FuncType;
  body: ast.BlockStmt | null;
}

interface Report {
  pos: token.Pos;
  message: string;
}

class Checker {
  private readonly reports: Report[] = [];
  // Functions run as subtests are not helpers, unless also called directly.
  private readonly subtests = new Set<token.Pos>();
  private readonly called = new Set<token.Pos>();

  constructor(private readonly pass: Pass<Config>) {}

  run(): void {
    const options = this.options();
    if (options === null) {
      return;
    }
    const [test, fuzz, benchmark, tb] = options;
    for (const cursor of this.pass.resultOf(inspect).root().preorder(ast.FuncDecl, ast.FuncLit, ast.CallExpr)) {
      const node = cursor.node()!;
      let fn: FuncInfo;
      switch (node.$type) {
        case "FuncLit":
          fn = { pos: node.pos(), name: "", type: node.type!, body: node.body };
          break;
        case "FuncDecl":
          fn = { pos: node.name!.namePos, name: node.name!.name, type: node.type!, body: node.body };
          break;
        case "CallExpr": {
          let subtests = this.subtestExprs(node, test.subRun, test.subTestFuncType);
          if (subtests.length === 0) {
            subtests = this.subtestExprs(node, benchmark.subRun, benchmark.subTestFuncType);
          }
          if (subtests.length === 0) {
            subtests = this.fuzzExprs(node, fuzz.subRun);
          }
          if (subtests.length === 0) {
            subtests = this.synctestExprs(node, test.subTestFuncType);
          }
          if (subtests.length > 0) {
            for (const expr of subtests) {
              addValid(this.subtests, this.funcDefPosition(expr));
            }
          } else {
            addValid(this.called, this.funcDefPosition(node.fun));
          }
          continue;
        }
        default:
          continue;
      }
      for (const opts of [test, fuzz, benchmark, tb]) {
        this.checkFunc(fn, opts);
      }
    }
    for (const report of this.reports) {
      if (!this.subtests.has(report.pos) || this.called.has(report.pos)) {
        this.pass.report({ pos: report.pos, message: report.message });
      }
    }
  }

  // options returns the options for tests, fuzz tests, benchmarks, and
  // testing.TB, or null if the package does not import testing.
  private options(): [Options, Options, Options, Options] | null {
    const config = this.pass.config;
    const ctxType = this.findType("context", "Context")?.type() ?? null;
    const none: Options = {
      skipPrefix: "",
      varName: "",
      helper: null,
      subRun: null,
      subTestFuncType: null,
      helperType: null,
      ctxType,
      checks: { begin: false, first: false, name: false },
    };
    const runnable = (name: string, varName: string, skipPrefix: string, runName: string, checks: Options["checks"], withFuncType: boolean): Options | null => {
      const object = this.findType("testing", name);
      if (object === null) {
        return null;
      }
      const [helper] = types.lookupFieldOrMethod(object.type(), true, object.pkg(), "Helper");
      const [subRun] = types.lookupFieldOrMethod(object.type(), true, object.pkg(), runName);
      if (helper === null || subRun === null) {
        return null;
      }
      const helperType = types.newPointer(object.type());
      const param = types.newVar(token.NoPos, null, varName, helperType);
      const subTestFuncType = withFuncType ? types.newSignatureType(null, [], [], types.newTuple(param), null, false) : null;
      return { skipPrefix, varName, helper, subRun, subTestFuncType, helperType, ctxType, checks };
    };
    const test = runnable("T", "t", "Test", "Run", config.test, true);
    // Fuzzing is missing before Go 1.18, which is not an error.
    const fuzz = this.findType("testing", "F") === null ? none : runnable("F", "f", "Fuzz", "Fuzz", config.fuzz, false);
    const benchmark = runnable("B", "b", "Benchmark", "Run", config.benchmark, true);
    const tbObject = this.findType("testing", "TB");
    const [tbHelper] = tbObject === null ? [null] : types.lookupFieldOrMethod(tbObject.type(), true, tbObject.pkg(), "Helper");
    if (test === null || fuzz === null || benchmark === null || tbObject === null || tbHelper === null) {
      return null;
    }
    const tb: Options = { ...none, varName: "tb", helper: tbHelper, helperType: tbObject.type(), checks: config.tb };
    return [test, fuzz, benchmark, tb];
  }

  // findType finds a type in an imported package with a name, as testing.
  private findType(pkgName: string, typeName: string): types.Object | null {
    for (const pkg of this.pass.pkg.imports()) {
      if (pkg!.name() === pkgName) {
        const object = pkg!.scope()!.lookup(typeName);
        if (object !== null) {
          return object;
        }
      }
    }
    return null;
  }

  private checkFunc(fn: FuncInfo, opts: Options): void {
    const { checks } = opts;
    if (!checks.first && !checks.begin && !checks.name) {
      return;
    }
    if (opts.skipPrefix !== "" && fn.name.startsWith(opts.skipPrefix)) {
      return;
    }
    const found = this.searchParam(fn, opts.helperType);
    if (found === null) {
      return;
    }
    const [param, index] = found;
    const typeName = opts.helperType!.string();
    if (checks.first && index !== 0) {
      const ctx = index === 1 && opts.ctxType !== null ? this.searchParam(fn, opts.ctxType) : null;
      if (ctx === null || ctx[1] !== 0) {
        this.reports.push({ pos: fn.pos, message: `parameter ${typeName} should be the first or after context.Context` });
      }
    }
    if (param.names.length === 0 || param.names[0]!.name === "_") {
      return;
    }
    if (checks.name && param.names[0]!.name !== opts.varName) {
      this.reports.push({ pos: fn.pos, message: `parameter ${typeName} should have name ${opts.varName}` });
    }
    // A declaration without a body cannot start with the call.
    if (checks.begin && fn.body !== null && (fn.body.list.length === 0 || !this.isHelperCall(fn.body.list[0]!, opts.helper))) {
      this.reports.push({ pos: fn.pos, message: `test helper function should start from ${opts.varName}.Helper()` });
    }
  }

  // searchParam finds the first parameter of a type, and its index among
  // the parameter fields.
  private searchParam(fn: FuncInfo, type: types.Type | null): [ast.Field, number] | null {
    const list = fn.type.params?.list ?? [];
    for (let i = 0; i < list.length; i++) {
      if (this.hasType(list[i]!.type, type)) {
        return [list[i]!, i];
      }
    }
    return null;
  }

  private hasType(expr: ast.Expr | null, type: types.Type | null): boolean {
    const found = expr === null ? undefined : this.pass.typesInfo.types.get(expr);
    return found !== undefined && types.identical(found.type, type);
  }

  private isHelperCall(stmt: ast.Stmt, helper: types.Object | null): boolean {
    return stmt.$type === "ExprStmt" && stmt.x?.$type === "CallExpr" && stmt.x.fun?.$type === "SelectorExpr" && this.isSelectorCall(stmt.x.fun, helper);
  }

  private isSelectorCall(sel: ast.SelectorExpr, object: types.Object | null): boolean {
    const selection = this.pass.typesInfo.selections.get(sel);
    return selection !== undefined && selection !== null && selection.obj() === object;
  }

  // subtestExprs returns the functions a t.Run or b.Run call runs.
  private subtestExprs(call: ast.CallExpr, run: types.Object | null, funcType: types.Type | null): ast.Expr[] {
    if (call.fun?.$type !== "SelectorExpr" || !this.isSelectorCall(call.fun, run) || call.args.length !== 2) {
      return [];
    }
    return this.unwrapBuilder(call.args[1]!, funcType) ?? [call.args[1]!];
  }

  private fuzzExprs(call: ast.CallExpr, fuzz: types.Object | null): ast.Expr[] {
    if (call.fun?.$type !== "SelectorExpr" || !this.isSelectorCall(call.fun, fuzz) || call.args.length !== 1) {
      return [];
    }
    return [call.args[0]!];
  }

  // synctestExprs returns the function a synctest.Test call runs.
  private synctestExprs(call: ast.CallExpr, funcType: types.Type | null): ast.Expr[] {
    const fun = call.fun;
    if (fun?.$type !== "SelectorExpr" || fun.sel!.name !== "Test" || fun.x?.$type !== "Ident") {
      return [];
    }
    const object = this.pass.typesInfo.uses.get(fun.x);
    if (object?.$type !== "PkgName" || object.imported()!.path() !== "testing/synctest" || call.args.length !== 2) {
      return [];
    }
    return this.unwrapBuilder(call.args[1]!, funcType) ?? [call.args[1]!];
  }

  // unwrapBuilder returns what a call building a subtest function returns,
  // as in t.Run(name, makeTest()), or null when expr is not such a call.
  private unwrapBuilder(expr: ast.Expr, funcType: types.Type | null): ast.Expr[] | null {
    if (expr.$type !== "CallExpr") {
      return null;
    }
    let decl: { type: ast.FuncType | null; body: ast.BlockStmt | null } | null = null;
    const fun = expr.fun;
    switch (fun?.$type) {
      case "FuncLit":
        decl = { type: fun.type, body: fun.body };
        break;
      case "Ident":
        decl = this.findFunction(fun);
        break;
      case "SelectorExpr":
        decl = this.findMethod(fun);
        break;
    }
    if (decl === null) {
      return null;
    }
    const results = decl.type?.results?.list ?? [];
    if (results.length !== 1 || !this.hasType(results[0]!.type, funcType)) {
      return null;
    }
    const funcs: ast.Expr[] = [];
    ast.inspect(decl.body, (node) => {
      if (node === null) {
        return false;
      }
      if (node.$type === "ReturnStmt" && node.results.length === 1) {
        funcs.push(node.results[0]!);
      }
      return true;
    });
    return funcs.length > 0 ? funcs : null;
  }

  private findFunction(ident: ast.Ident): ast.FuncDecl | null {
    // The parser resolves an identifier to the declaration of what it names.
    const decl = ident.obj?.decl as ast.Node | null | undefined;
    if (decl?.$type === "FuncDecl") {
      return decl;
    }
    const object = this.pass.typesInfo.objectOf(ident);
    if (object === null) {
      return null;
    }
    for (const file of this.pass.files) {
      for (const d of file!.decls) {
        if (d?.$type === "FuncDecl" && d.name!.pos() === object.pos()) {
          return d;
        }
      }
    }
    return null;
  }

  // findMethod finds the declaration of a method on a value receiver.
  private findMethod(sel: ast.SelectorExpr): ast.FuncDecl | null {
    const selection = this.pass.typesInfo.selections.get(sel);
    if (selection === undefined || selection === null) {
      return null;
    }
    for (const file of this.pass.files) {
      for (const d of file!.decls) {
        if (d?.$type !== "FuncDecl" || d.recv === null || d.recv.list.length !== 1) {
          continue;
        }
        const recvType = d.recv.list[0]!.type;
        if (recvType?.$type !== "Ident") {
          continue;
        }
        const recvObject = this.pass.typesInfo.uses.get(recvType);
        if (recvObject === undefined || recvObject === null || !types.identical(recvObject.type(), selection.recv())) {
          continue;
        }
        if (d.name!.name === sel.sel!.name) {
          return d;
        }
      }
    }
    return null;
  }

  // funcDefPosition locates the function an expression names or defines.
  private funcDefPosition(expr: ast.Expr | null): token.Pos {
    if (expr?.$type === "FuncLit") {
      return expr.pos();
    }
    const ident = expr?.$type === "Ident" ? expr : expr?.$type === "SelectorExpr" ? expr.sel : null;
    if (ident === null) {
      return token.NoPos;
    }
    return this.pass.typesInfo.uses.get(ident)?.pos() ?? token.NoPos;
  }
}

function addValid(set: Set<token.Pos>, pos: token.Pos): void {
  if (pos !== token.NoPos) {
    set.add(pos);
  }
}
