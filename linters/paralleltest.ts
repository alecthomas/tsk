import * as ast from "go/ast";
import type * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";

interface Config {
  /** Report only misuse of t.Parallel, not missing calls. */
  ignoreMissing: boolean;
  /** Require t.Parallel in top-level tests only, not subtests. */
  ignoreMissingSubtests: boolean;
  /** Report defer in tests that call t.Parallel; use t.Cleanup instead. */
  checkCleanup: boolean;
}

export default defineAnalyzer<Config>({
  name: "paralleltest",
  doc: `checks that tests use t.Parallel

Tests, and the subtests they run, should call t.Parallel unless they call
t.Setenv, which cannot be used in parallel tests.`,
  config: { ignoreMissing: false, ignoreMissingSubtests: false, checkCleanup: false },
  run(pass) {
    for (const file of pass.files) {
      if (!pass.fset.file(file!.fileStart)!.name().endsWith("_test.go")) {
        continue;
      }
      for (const decl of file!.decls) {
        if (decl?.$type === "FuncDecl") {
          new TestFunction(pass, decl).analyze();
        }
      }
    }
  },
});

// RunAnalysis is what a t.Run call shows.
interface RunAnalysis {
  runs: number;
  // missing holds the runs that neither call t.Parallel nor t.Setenv.
  missing: ast.Node[];
}

class TestFunction {
  private hasParallel = false;
  private cantParallel = false;
  private rangeOverCases = false;
  private rangeHasParallel = false;
  private rangeCantParallel = false;
  private loopVarInRun: string | undefined;
  private runs = 0;
  private missingRuns: ast.Node[] = [];
  private rangeNode: ast.RangeStmt | null = null;
  private defers: ast.DeferStmt[] = [];

  constructor(
    private readonly pass: Pass<Config>,
    private readonly fn: ast.FuncDecl,
  ) {}

  analyze(): void {
    const pass = this.pass;
    const fn = this.fn;
    const testVar = testParam(fn, true);
    if (testVar === undefined || fn.body === null) {
      return;
    }
    for (const stmt of fn.body.list) {
      switch (stmt?.$type) {
        case "DeferStmt":
          if (pass.config.checkCleanup) {
            this.defers.push(stmt);
          }
          break;
        case "ExprStmt":
          ast.inspect(stmt, (node) => {
            this.hasParallel = this.hasParallel || callsMethod(node, testVar, "Parallel");
            this.cantParallel = this.cantParallel || callsMethod(node, testVar, "Setenv");
            this.addRun(this.analyzeRun(node, testVar));
            return true;
          });
          break;
        case "RangeStmt":
          this.analyzeRange(stmt, testVar);
          break;
      }
    }
    const name = fn.name!.name;
    const config = pass.config;
    const cantParallel = this.cantParallel || this.rangeCantParallel;
    if (!config.ignoreMissing && !this.hasParallel && !cantParallel) {
      pass.report({ pos: fn.pos(), message: `Function ${name} missing the call to method parallel` });
    }
    if (this.rangeOverCases && this.rangeNode !== null) {
      if (!this.rangeHasParallel && !this.rangeCantParallel) {
        if (!config.ignoreMissing && !config.ignoreMissingSubtests) {
          pass.report({ pos: this.rangeNode.pos(), message: `Range statement for test ${name} missing the call to method parallel in test Run` });
        }
      } else if (this.loopVarInRun !== undefined && !loopVarsPerIteration(pass)) {
        pass.report({ pos: this.rangeNode.pos(), message: `Range statement for test ${name} does not reinitialise the variable ${this.loopVarInRun}` });
      }
    }
    if (!config.ignoreMissing && !config.ignoreMissingSubtests && this.runs > 1) {
      for (const run of this.missingRuns) {
        pass.report({ pos: run.pos(), message: `Function ${name} missing the call to method parallel in the test run` });
      }
    }
    if (config.checkCleanup && this.hasParallel && this.defers.length > 0) {
      for (const stmt of this.defers) {
        pass.report({
          pos: stmt.pos(),
          message: `Function ${name} uses defer with t.Parallel, use t.Cleanup instead to ensure cleanup runs after parallel subtests complete`,
        });
      }
    }
  }

  private addRun(run: RunAnalysis): void {
    this.runs += run.runs;
    this.missingRuns.push(...run.missing);
  }

  // analyzeRange checks t.Run calls in a loop over test cases.
  private analyzeRange(stmt: ast.RangeStmt, testVar: string): void {
    this.rangeNode = stmt;
    const loopVars: (types.Object | null)[] = [];
    for (const expr of [stmt.key, stmt.value]) {
      if (expr?.$type === "Ident") {
        loopVars.push(this.pass.typesInfo.objectOf(expr));
      }
    }
    ast.inspect(stmt, (node) => {
      if (node?.$type !== "ExprStmt" || !callsMethod(node.x, testVar, "Run")) {
        return true;
      }
      const call = node.x as ast.CallExpr;
      const innerVar = runCallbackParam(call);
      this.rangeOverCases = true;
      this.rangeHasParallel = this.rangeHasParallel || callsMethodInArgs(call, innerVar, "Parallel");
      this.rangeCantParallel = this.rangeCantParallel || callsMethodInArgs(call, innerVar, "Setenv");
      this.loopVarInRun = this.loopVarInRun ?? loopVarInRun(this.pass, call, loopVars);
      const callback = call.args.length > 1 ? call.args[1] : null;
      if (callback?.$type === "FuncLit") {
        ast.inspect(callback, (inner) => {
          this.addRun(this.analyzeRun(inner, innerVar));
          return true;
        });
      }
      return true;
    });
  }

  // analyzeRun checks whether a node is a t.Run call whose subtest calls
  // t.Parallel or t.Setenv.
  private analyzeRun(node: ast.Node | null, testVar: string): RunAnalysis {
    if (node?.$type !== "CallExpr" || !callsMethod(node, testVar, "Run")) {
      return { runs: 0, missing: [] };
    }
    const innerVar = runCallbackParam(node);
    let hasParallel = false;
    let cantParallel = false;
    const callback = node.args.length > 1 ? node.args[1] : null;
    switch (callback?.$type) {
      case "FuncLit":
        ast.inspect(callback, (p) => {
          hasParallel = hasParallel || callsMethod(p, innerVar, "Parallel");
          cantParallel = cantParallel || callsMethod(p, innerVar, "Setenv");
          return true;
        });
        break;
      case "Ident":
        // A named test function in this package.
        for (const file of this.pass.files) {
          for (const decl of file!.decls) {
            if (decl?.$type !== "FuncDecl" || decl.name!.name !== callback.name) {
              continue;
            }
            const param = testParam(decl, false);
            if (param !== undefined) {
              ast.inspect(decl, (p) => {
                hasParallel = hasParallel || callsMethod(p, param, "Parallel");
                return true;
              });
            }
          }
        }
        break;
      case "CallExpr":
        hasParallel = this.builderHasParallel(callback);
        break;
    }
    return { runs: 1, missing: hasParallel || cantParallel ? [] : [node] };
  }

  // builderHasParallel checks whether a function returning a subtest, as in
  // t.Run(name, makeTest()), returns one calling t.Parallel.
  private builderHasParallel(builder: ast.CallExpr): boolean {
    const fun = builder.fun;
    const name = fun?.$type === "Ident" ? fun.name : fun?.$type === "SelectorExpr" ? fun.sel!.name : "";
    if (name === "") {
      return false;
    }
    for (const file of this.pass.files) {
      for (const decl of file!.decls) {
        if (decl?.$type !== "FuncDecl" || decl.name!.name !== name) {
          continue;
        }
        let hasParallel = false;
        ast.inspect(decl, (node) => {
          if (node?.$type !== "ReturnStmt" || node.results.length === 0) {
            return true;
          }
          for (const result of node.results) {
            if (result?.$type !== "FuncLit") {
              continue;
            }
            const param = result.type?.params?.list[0]?.names[0]?.name ?? "";
            if (param === "") {
              continue;
            }
            ast.inspect(result, (p) => {
              if (callsMethod(p, param, "Parallel")) {
                hasParallel = true;
                return false;
              }
              return true;
            });
            if (hasParallel) {
              return false;
            }
          }
          return true;
        });
        return hasParallel;
      }
    }
    return false;
  }
}

// loopVarsPerIteration reports whether the package's Go version, from Go
// 1.22, gives each iteration its own loop variables, so subtests need not
// copy them. golangci-lint skips the check then; an unknown version keeps it.
function loopVarsPerIteration(pass: Pass<Config>): boolean {
  const match = /^go1\.(\d+)/.exec(pass.pkg.goVersion());
  return match !== null && Number(match[1]) >= 22;
}

// callsMethod reports whether a node is a call of receiver.method(...).
function callsMethod(node: ast.Node | null, receiver: string, method: string): boolean {
  if (node?.$type !== "CallExpr" || node.fun?.$type !== "SelectorExpr" || node.fun.x?.$type !== "Ident") {
    return false;
  }
  return node.fun.x.name === receiver && node.fun.sel!.name === method;
}

// callsMethodInArgs reports whether a call's arguments call receiver.method.
function callsMethodInArgs(call: ast.CallExpr, receiver: string, method: string): boolean {
  let called = false;
  for (const arg of call.args) {
    if (called) {
      break;
    }
    ast.inspect(arg, (node) => {
      if (called) {
        return false;
      }
      called = callsMethod(node, receiver, method);
      return true;
    });
  }
  return called;
}

// runCallbackParam names the *testing.T parameter of a t.Run function
// literal, or returns "".
function runCallbackParam(call: ast.CallExpr): string {
  const callback = call.args.length < 2 ? null : call.args[1];
  if (callback?.$type !== "FuncLit") {
    return "";
  }
  return callback.type?.params?.list[0]?.names[0]?.name ?? "";
}

// testParam names the parameter of a function taking only a *testing.T, and
// requires a Test prefix for a test function.
function testParam(fn: ast.FuncDecl, test: boolean): string | undefined {
  if (test && !fn.name!.name.startsWith("Test")) {
    return undefined;
  }
  const params = fn.type!.params;
  if (params === null || params.list.length !== 1) {
    return undefined;
  }
  const param = params.list[0]!;
  const type = param.type;
  if (type?.$type !== "StarExpr" || type.x?.$type !== "SelectorExpr" || type.x.sel!.name !== "T" || type.x.x?.$type !== "Ident") {
    return undefined;
  }
  if (param.names.length === 0 || type.x.x.name !== "testing") {
    return undefined;
  }
  return param.names[0]!.name;
}

// loopVarInRun names the last identifier in a t.Run callback that refers to
// a loop variable. A blank loop variable has no object, so it matches any
// identifier without one, as upstream compares them.
function loopVarInRun(pass: Pass<Config>, call: ast.CallExpr, loopVars: (types.Object | null)[]): string | undefined {
  if (call.args.length !== 2) {
    return undefined;
  }
  let found: string | undefined;
  ast.inspect(call.args[1], (node) => {
    if (node?.$type === "Ident" && loopVars.some((object) => pass.typesInfo.objectOf(node) === object)) {
      found = node.name;
    }
    return true;
  });
  return found;
}
