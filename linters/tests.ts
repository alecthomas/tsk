// Port of golang.org/x/tools/go/analysis/passes/tests at v0.50.0.
import * as ast from "go/ast";
import type * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";
import { isTypeNamed } from "./internal/typesinternal";

// The pattern go/doc uses to find example output comments.
const outputRe = /^[\t\n\v\f\r ]*(unordered )?output:/iu;

export default defineAnalyzer({
  name: "tests",
  doc: `check for common mistaken usages of tests and examples

The tests checker walks Test, Benchmark, Fuzzing and Example functions checking
malformed names, wrong signatures and examples documenting non-existent
identifiers.

Please see the documentation for package testing in golang.org/pkg/testing
for the conventions that are enforced for Tests, Benchmarks, and Examples.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/tests",
  run(pass) {
    const checker = new Checker(pass);
    for (const f of pass.files) {
      if (!pass.fset.file(f.fileStart)!.name().endsWith("_test.go")) {
        continue;
      }
      for (const decl of f.decls) {
        if (decl?.$type !== "FuncDecl" || decl.recv !== null) {
          continue;
        }
        const name = decl.name!.name;
        if (name.startsWith("Example")) {
          checker.checkExampleName(decl);
          checker.checkExampleOutput(decl, f.comments);
        } else if (name.startsWith("Test")) {
          checker.checkTest(decl, "Test");
        } else if (name.startsWith("Benchmark")) {
          checker.checkTest(decl, "Benchmark");
        } else if (name.startsWith("Fuzz")) {
          checker.checkTest(decl, "Fuzz");
          checker.checkFuzz(decl);
        }
      }
    }
  },
});

class Checker {
  private readonly acceptedFuzzTypes: types.Type[];

  constructor(private readonly pass: Pass<unknown>) {
    const kinds = [
      types.String,
      types.Bool,
      types.Float32,
      types.Float64,
      types.Int,
      types.Int8,
      types.Int16,
      types.Int32,
      types.Int64,
      types.Uint,
      types.Uint8,
      types.Uint16,
      types.Uint32,
      types.Uint64,
    ];
    this.acceptedFuzzTypes = [...kinds.map((kind) => types.Typ[kind]!), types.newSlice(types.Universe!.lookup("byte")!.type())!];
  }

  private reportRange(node: { pos(): token.Pos; end(): token.Pos }, message: string): void {
    this.pass.report({ pos: node.pos(), end: node.end(), message });
  }

  private typeOf(expr: ast.Expr): types.Type | null {
    return this.pass.typesInfo.types.get(expr)?.type ?? null;
  }

  checkFuzz(fn: ast.FuncDecl): void {
    const params = this.checkFuzzCall(fn);
    if (params !== null) {
      this.checkAddCalls(fn, params);
    }
  }

  // checkFuzzCall checks the f.Fuzz() calls and returns the fuzz target's
  // parameters, if they are valid.
  private checkFuzzCall(fn: ast.FuncDecl): types.Tuple | null {
    let params: types.Tuple | null = null;
    ast.inspect(fn, (n) => {
      if (n?.$type !== "CallExpr") {
        return true;
      }
      if (!this.isFuzzTargetDot(n, "Fuzz") || n.args.length !== 1) {
        return true;
      }
      const expr = n.args[0]!;
      const t = this.typeOf(expr);
      if (t === null) {
        return true;
      }
      const tSign = t.underlying();
      if (tSign?.$type !== "Signature") {
        this.reportRange(expr, "argument to Fuzz must be a function");
        return false;
      }
      // A nil tuple, which the bridge gives as null, is empty.
      if ((tSign.results()?.len() ?? 0) !== 0) {
        this.reportRange(expr, "fuzz target must not return any value");
      }
      if ((tSign.params()?.len() ?? 0) === 0) {
        this.reportRange(expr, "fuzz target must have 1 or more argument");
        return false;
      }
      const ok = this.validateFuzzArgs(tSign.params()!, expr);
      if (ok && params === null) {
        params = tSign.params();
      }
      // The fuzz target may call only the Name and Failed methods of *F.
      ast.inspect(expr, (inner) => {
        if (inner?.$type === "CallExpr" && this.isFuzzTargetDot(inner, "")) {
          if (!this.isFuzzTargetDot(inner, "Name") && !this.isFuzzTargetDot(inner, "Failed")) {
            this.reportRange(inner, "fuzz target must not call any *F methods");
          }
        }
        return true;
      });
      // Calls to f.Fuzz within a fuzz target are not allowed anyway.
      return false;
    });
    return params;
  }

  // checkAddCalls checks that f.Add calls match the fuzz target's parameters.
  private checkAddCalls(fn: ast.FuncDecl, params: types.Tuple): void {
    ast.inspect(fn, (n) => {
      if (n?.$type !== "CallExpr" || !this.isFuzzTargetDot(n, "Add")) {
        return true;
      }
      // The fuzz target's first parameter is the *testing.T.
      if (n.args.length !== params.len() - 1) {
        this.reportRange(n, `wrong number of values in call to (*testing.F).Add: ${n.args.length}, fuzz target expects ${params.len() - 1}`);
        return true;
      }
      const mismatched: number[] = [];
      for (const [i, expr] of n.args.entries()) {
        const t = this.typeOf(expr!);
        if (t === null) {
          return true;
        }
        if (!types.identical(t, params.at(i + 1)!.type())) {
          mismatched.push(i);
        }
      }
      if (mismatched.length === 1) {
        const i = mismatched[0];
        const expr = n.args[i]!;
        this.reportRange(
          expr,
          `mismatched type in call to (*testing.F).Add: ${typeString(this.typeOf(expr))}, fuzz target expects ${typeString(params.at(i + 1)!.type())}`,
        );
      } else if (mismatched.length > 1) {
        const gotArgs = n.args.map((arg) => typeString(this.typeOf(arg!)));
        const wantArgs = n.args.map((_, i) => typeString(params.at(i + 1)!.type()));
        this.reportRange(n, `mismatched types in call to (*testing.F).Add: [${gotArgs.join(" ")}], fuzz target expects [${wantArgs.join(" ")}]`);
      }
      return true;
    });
  }

  // isFuzzTargetDot reports whether call is (*testing.F).<name>(), or any
  // *testing.F method when name is empty.
  private isFuzzTargetDot(call: ast.CallExpr, name: string): boolean {
    const fun = call.fun;
    if (fun?.$type !== "SelectorExpr" || !isTestingType(this.typeOf(fun.x!), "F")) {
      return false;
    }
    return name === "" || fun.sel!.name === name;
  }

  private validateFuzzArgs(params: types.Tuple, expr: ast.Expr): boolean {
    const fLit = expr.$type === "FuncLit" ? expr : null;
    let exprRange: ast.Node = expr;
    let ok = true;
    if (!isTestingType(params.at(0)!.type(), "T")) {
      if (fLit !== null) {
        exprRange = fLit.type!.params!.list[0]!.type!;
      }
      this.reportRange(exprRange, "the first parameter of a fuzz target must be *testing.T");
      ok = false;
    }
    for (let i = 1; i < params.len(); i++) {
      if (this.isAcceptedFuzzType(params.at(i)!.type()!)) {
        continue;
      }
      if (fLit !== null) {
        let curr = 0;
        for (const field of fLit.type!.params!.list) {
          curr += field!.names.length;
          if (i < curr) {
            exprRange = field!.type!;
            break;
          }
        }
      }
      this.reportRange(exprRange, `fuzzing arguments can only have the following types: ${this.acceptedFuzzTypes.map((t) => t.string()).join(", ")}`);
      ok = false;
    }
    return ok;
  }

  private isAcceptedFuzzType(paramType: types.Type): boolean {
    return this.acceptedFuzzTypes.some((t) => types.identical(t, paramType));
  }

  checkExampleOutput(fn: ast.FuncDecl, fileComments: readonly (ast.CommentGroup | null)[]): void {
    const outputs: boolean[] = [];
    const positions: token.Pos[] = [];
    // File comments are in order of appearance.
    for (const cg of fileComments) {
      if (cg!.pos() < fn.pos()) {
        continue;
      }
      if (cg!.end() > fn.end()) {
        break;
      }
      outputs.push(outputRe.test(cg!.text()));
      positions.push(cg!.pos());
    }
    const numOutputs = outputs.filter((isOutput) => isOutput).length;
    const message = numOutputs > 1 ? "there can only be one output comment block per example" : "output comment block must be the last comment block";
    outputs.forEach((isOutput, i) => {
      if (isOutput && i !== outputs.length - 1) {
        this.pass.report({ pos: positions[i], message });
      }
    });
  }

  checkExampleName(fn: ast.FuncDecl): void {
    const fnName = fn.name!.name;
    const report = (message: string) => this.pass.report({ pos: fn.pos(), message });
    if (fn.type!.params!.list.length !== 0) {
      report(`${fnName} should be niladic`);
    }
    if ((fn.type!.results?.list.length ?? 0) !== 0) {
      report(`${fnName} should return nothing`);
    }
    if ((fn.type!.typeParams?.list.length ?? 0) > 0) {
      report(`${fnName} should not have type params`);
    }
    if (fnName === "Example") {
      return;
    }

    const exName = fnName.slice("Example".length);
    const elems = splitN(exName, "_", 3);
    const ident = elems[0];
    const objs = lookup(this.pass.pkg, ident);
    if (ident !== "" && objs.length === 0) {
      // Without the object, no later check can run.
      report(`${fnName} refers to unknown identifier: ${ident}`);
      return;
    }
    if (elems.length < 2) {
      return;
    }
    if (ident === "") {
      // Example_suffix.
      const residual = exName.startsWith("_") ? exName.slice(1) : exName;
      if (!isExampleSuffix(residual)) {
        report(`${fnName} has malformed example suffix: ${residual}`);
      }
      return;
    }

    const mmbr = elems[1];
    if (!isExampleSuffix(mmbr)) {
      // ExampleFoo_Method: Foo.Method must exist in the package or its imports.
      const found = objs.some((obj) => types.lookupFieldOrMethod(obj.type(), true, obj.pkg(), mmbr)[0] !== null);
      if (!found) {
        report(`${fnName} refers to unknown field or method: ${ident}.${mmbr}`);
      }
    }
    if (elems.length === 3 && !isExampleSuffix(elems[2])) {
      report(`${fnName} has malformed example suffix: ${elems[2]}`);
    }
  }

  checkTest(fn: ast.FuncDecl, prefix: string): void {
    // Tests have no results and one parameter.
    const params = fn.type!.params;
    if ((fn.type!.results?.list.length ?? 0) > 0 || params === null || params.list.length !== 1 || params.list[0]!.names.length > 1) {
      return;
    }
    if (!isTestParam(params.list[0]!.type!, prefix[0])) {
      return;
    }
    const tparams = fn.type!.typeParams;
    if (tparams !== null && tparams.list.length > 0) {
      // cmd/go also rejects these, but warning early helps users in IDEs.
      this.pass.report({
        pos: tparams.opening,
        end: tparams.closing,
        message: `${fn.name!.name} has type parameters: it will not be run by go test as a ${prefix}XXX function`,
      });
    }
    if (!isTestSuffix(fn.name!.name.slice(prefix.length))) {
      this.reportRange(fn.name!, `${fn.name!.name} has malformed name: first letter after '${prefix}' must not be lowercase`);
    }
  }
}

function typeString(t: types.Type | null): string {
  return t === null ? "<nil>" : t.string();
}

// isTestingType reports whether typ is *testing.<name>. As upstream, aliases
// of the pointer type do not count, since go test would not recognise them.
function isTestingType(typ: types.Type | null, testingType: string): boolean {
  return typ?.$type === "Pointer" && isTypeNamed(typ.elem(), "testing", testingType);
}

function isExampleSuffix(s: string): boolean {
  return /^\p{Ll}/u.test(s);
}

function isTestSuffix(name: string): boolean {
  return !/^\p{Ll}/u.test(name);
}

// isTestParam reports whether typ looks like *testing.T or *testing.B by name.
function isTestParam(typ: ast.Expr, wantType: string): boolean {
  if (typ.$type !== "StarExpr") {
    return false;
  }
  const x = typ.x;
  if (x?.$type === "Ident") {
    return x.name === wantType;
  }
  if (x?.$type === "SelectorExpr") {
    return x.sel!.name === wantType;
  }
  return false;
}

// lookup finds name in the package, or else in any of its imports, since the
// package under test is hard to tell.
function lookup(pkg: types.Package, name: string): types.Object[] {
  const obj = pkg.scope()!.lookup(name);
  if (obj !== null) {
    return [obj];
  }
  const objs: types.Object[] = [];
  for (const imp of pkg.imports()) {
    const o = imp!.scope()!.lookup(name);
    if (o !== null) {
      objs.push(o);
    }
  }
  return objs;
}

// splitN splits s as strings.SplitN does with n > 0.
function splitN(s: string, sep: string, n: number): string[] {
  const parts = s.split(sep);
  return parts.length <= n ? parts : [...parts.slice(0, n - 1), parts.slice(n - 1).join(sep)];
}
