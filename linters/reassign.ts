import * as ast from "go/ast";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Patterns for names of other packages' variables that must not be reassigned. */
  patterns: string[];
}

export default defineAnalyzer<Config>({
  name: "reassign",
  doc: "Checks that package variables are not reassigned",
  requires: [inspect],
  config: { patterns: ["EOF", "Err.*"] },
  run(pass) {
    const pattern = new RegExp(`^(${pass.config.patterns.join("|")})$`);
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.AssignStmt)) {
      for (const lhs of (cursor.node() as ast.AssignStmt).lhs) {
        check(pass, lhs!, pattern);
      }
    }
  },
});

function check(pass: Pass<Config>, expr: ast.Expr, pattern: RegExp): void {
  if (expr.$type === "SelectorExpr") {
    const x = expr.x;
    if (x?.$type !== "Ident") {
      return;
    }
    const name = expr.sel!.name;
    let pkgPath = "";
    // An unresolved identifier is treated as a package with an empty path.
    const object = pass.typesInfo.uses.get(x);
    if (object !== undefined) {
      if (object?.$type !== "PkgName" || object.imported() === pass.pkg) {
        return;
      }
      pkgPath = object.imported()!.path();
    }
    // Patterns may match the bare or the package-qualified name.
    if (pattern.test(name) || pattern.test(`${pkgPath}.${name}`)) {
      pass.report({ pos: expr.pos(), message: `reassigning variable ${name} in other package ${x.name}` });
    }
  } else if (expr.$type === "Ident") {
    // A variable from a dot import.
    const object = pass.typesInfo.uses.get(expr);
    if (object?.$type !== "Var" || object.pkg() === pass.pkg || !pattern.test(expr.name)) {
      return;
    }
    pass.report({ pos: expr.pos(), message: `reassigning variable ${expr.name} from other package ${object.pkg()!.path()}` });
  }
}
