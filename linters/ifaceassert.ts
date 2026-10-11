// Port of golang.org/x/tools/go/analysis/passes/ifaceassert at v0.50.0.
import * as ast from "go/ast";
import * as types from "go/types";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import { normalTerms } from "./internal/typeparams";

export default defineAnalyzer({
  name: "ifaceassert",
  doc: `detect impossible interface-to-interface type assertions

This checker flags type assertions v.(T) and corresponding type-switch cases
in which the static type V of v is an interface that cannot possibly implement
the target interface T. This occurs when V and T contain methods with the same
name but different signatures. Example:

	var v interface {
		Read()
	}
	_ = v.(io.Reader)

The Read method in v has a different signature than the Read method in
io.Reader, so this assertion cannot succeed.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/ifaceassert",
  group: "govet",
  requires: [inspect],
  run(pass) {
    const free = new Free();
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.TypeAssertExpr, ast.TypeSwitchStmt)) {
      const n = cursor.node()!;
      let assert: ast.TypeAssertExpr | null = null;
      const targets: ast.Expr[] = [];
      if (n.$type === "TypeAssertExpr") {
        // v.(type) is handled with its TypeSwitchStmt.
        if (n.type === null) {
          continue;
        }
        assert = n;
        targets.push(n.type);
      } else if (n.$type === "TypeSwitchStmt") {
        const assign = n.assign;
        if (assign?.$type === "ExprStmt") {
          assert = assign.x as ast.TypeAssertExpr;
        } else if (assign?.$type === "AssignStmt") {
          assert = assign.rhs[0] as ast.TypeAssertExpr;
        }
        for (const c of n.body!.list) {
          for (const e of (c as ast.CaseClause).list) {
            targets.push(e!);
          }
        }
      }
      const v = pass.typesInfo.typeOf(assert!.x);
      for (const target of targets) {
        const t = pass.typesInfo.typeOf(target);
        const f = assertableTo(free, v, t);
        if (f !== null) {
          pass.report({
            pos: target.pos(),
            message: `impossible type assertion: no type can implement both ${v!.string()} and ${t!.string()} (conflicting types for ${f.name()} method)`,
          });
        }
      }
    }
  },
});

// Returns the method with conflicting types that makes v.(t) impossible.
function assertableTo(free: Free, v: types.Type | null, t: types.Type | null): types.Func | null {
  if (t === null || v === null) {
    return null;
  }
  const vi = v.underlying();
  const ti = t.underlying();
  if (vi?.$type !== "Interface" || ti?.$type !== "Interface") {
    return null;
  }
  // Interfaces mentioning free type parameters may be instantiated compatibly.
  if (free.has(vi) || free.has(ti)) {
    return null;
  }
  const [f, wrongType] = types.missingMethod(vi, ti, false);
  return wrongType ? f : null;
}

// Port of internal/typeparams.Free: whether a type mentions a free type
// parameter, caching results for the package.
class Free {
  private readonly seen = new Map<types.Type, boolean>();

  has(typ: types.Type | null): boolean {
    if (typ === null) {
      return false;
    }
    const cached = this.seen.get(typ);
    if (cached !== undefined) {
      return cached;
    }
    // A type being visited counts as false, which ends cycles.
    this.seen.set(typ, false);
    const res = this.compute(typ);
    this.seen.set(typ, res);
    return res;
  }

  private compute(t: types.Type): boolean {
    switch (t.$type) {
      case "Alias":
        if ((t.typeParams()?.len() ?? 0) > (t.typeArgs()?.len() ?? 0)) {
          return true;
        }
        return this.has(types.unalias(t));
      case "Array":
      case "Slice":
      case "Pointer":
      case "Chan":
        return this.has(t.elem());
      case "Struct":
        for (let i = 0; i < t.numFields(); i++) {
          if (this.has(t.field(i)!.type())) {
            return true;
          }
        }
        return false;
      case "Tuple":
        for (let i = 0; i < t.len(); i++) {
          if (this.has(t.at(i)!.type())) {
            return true;
          }
        }
        return false;
      case "Signature":
        return this.has(t.params()) || this.has(t.results());
      case "Interface": {
        for (let i = 0; i < t.numMethods(); i++) {
          if (this.has(t.method(i)!.type())) {
            return true;
          }
        }
        // An ill-typed or empty type set has no free type parameters.
        const terms = normalTerms(t) ?? [];
        return terms.some((term) => this.has(term.type()));
      }
      case "Map":
        return this.has(t.key()) || this.has(t.elem());
      case "Named": {
        const args = t.typeArgs();
        const nargs = args?.len() ?? 0;
        if ((t.typeParams()?.len() ?? 0) > nargs) {
          return true;
        }
        for (let i = 0; i < nargs; i++) {
          if (this.has(args!.at(i))) {
            return true;
          }
        }
        return this.has(t.underlying());
      }
      case "TypeParam":
        return true;
      default:
        return false;
    }
  }
}
