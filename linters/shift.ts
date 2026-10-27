// Port of golang.org/x/tools/go/analysis/passes/shift at v0.50.0.
import * as ast from "go/ast";
import * as constant from "go/constant";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { structuralTerms } from "./internal/typeparams";

export default defineAnalyzer({
  name: "shift",
  doc: "check for shifts that equal or exceed the width of the integer",
  group: "govet",
  requires: [inspect],
  run(pass) {
    const root = pass.resultOf(inspect).root();
    // Compute dead nodes first, to skip checks on unreachable arch-specific code.
    const dead = new Set<ast.Node>();
    for (const cursor of root.preorder(ast.IfStmt, ast.SwitchStmt)) {
      updateDead(pass.typesInfo, dead, cursor.node()!);
    }
    for (const cursor of root.preorder(ast.AssignStmt, ast.BinaryExpr)) {
      const node = cursor.node();
      if (node === null || dead.has(node)) {
        continue;
      }
      if (node.$type === "BinaryExpr") {
        if (node.op === token.SHL || node.op === token.SHR) {
          checkLongShift(pass, node, node.x!, node.y!);
        }
      } else if (node.$type === "AssignStmt") {
        if (node.lhs.length === 1 && node.rhs.length === 1 && (node.tok === token.SHL_ASSIGN || node.tok === token.SHR_ASSIGN)) {
          checkLongShift(pass, node, node.lhs[0]!, node.rhs[0]!);
        }
      }
    }
  },
});

// checkLongShift reports shifts by at least the width of the shifted value.
function checkLongShift(pass: Pass<unknown>, node: ast.Node, x: ast.Expr, y: ast.Expr): void {
  const xtv = pass.typesInfo.types.get(x);
  // Shifts of constants are common in tricks like ^uint(0) >> 63.
  if (xtv?.value) {
    return;
  }
  const v = pass.typesInfo.types.get(y)?.value ?? null;
  if (v === null) {
    return;
  }
  const amt = constant.int64Val(constant.toInt(v));
  const t = xtv?.type ?? null;
  if (amt === undefined || t === null) {
    return;
  }
  let structural: (types.Type | null)[];
  const u = types.unalias(t);
  if (u?.$type === "TypeParam") {
    const terms = structuralTerms(u);
    if (terms === null) {
      return;
    }
    structural = terms.map((term) => term.type());
  } else {
    structural = [t];
  }
  const sizes = new Set(structural.map((st) => 8 * pass.typesSizes!.sizeof(st)));
  const minSize = Math.min(...sizes);
  if (amt >= minSize) {
    const qualifier = sizes.size > 1 ? "may be " : "";
    pass.report({
      pos: node.pos(),
      end: node.end(),
      // The constant prints exactly where a large amount would lose precision as a number.
      message: `${formatNode(x, pass.fset)} (${qualifier}${minSize} bits) too small for shift of ${constant.toInt(v)!.exactString()}`,
    });
  }
}

// updateDead adds unreachable "if" and "case" nodes, and their descendants, to dead.
function updateDead(info: types.Info, dead: Set<ast.Node>, node: ast.Node): void {
  if (dead.has(node)) {
    return;
  }
  const setDead = (n: ast.Node | null) => {
    ast.inspect(n, (child) => {
      if (child !== null) {
        dead.add(child);
      }
      return true;
    });
  };
  const constValue = (e: ast.Expr | null) => (e === null ? null : (info.types.get(e)?.value ?? null));
  if (node.$type === "IfStmt") {
    // The branch is dead if the condition is constant false.
    const v = constValue(node.cond);
    if (v === null) {
      return;
    }
    if (!constant.boolVal(v)) {
      setDead(node.body);
      return;
    }
    if (node.else !== null) {
      setDead(node.else);
    }
  } else if (node.$type === "SwitchStmt") {
    const clauses = node.body!.list.map((stmt) => stmt as ast.CaseClause);
    if (node.tag === null) {
      // A clause of a tagless switch is dead if all its values are constant false.
      for (const cc of clauses) {
        if (cc.list.length === 0) {
          continue;
        }
        const live = cc.list.some((expr) => {
          const v = constValue(expr);
          return v === null || v.kind() !== constant.Bool || constant.boolVal(v);
        });
        if (!live) {
          setDead(cc);
        }
      }
      return;
    }
    // A clause is dead if no value matches the constant tag. Only integers are handled.
    const v = constValue(node.tag);
    if (v === null || v.kind() !== constant.Int) {
      return;
    }
    if (constant.uint64Val(v) === undefined) {
      return;
    }
    for (const cc of clauses) {
      if (cc.list.length === 0) {
        continue;
      }
      // Values compare as constants: as JavaScript numbers, large ones would lose precision.
      const live = cc.list.some((expr) => {
        const value = constValue(expr);
        return value === null || constant.uint64Val(value) === undefined || constant.compare(value, token.EQL, v);
      });
      if (!live) {
        setDead(cc);
      }
    }
  }
}
