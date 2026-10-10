import * as ast from "go/ast";
import { isPkgDotName } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "errorf";

export function create(): Rule {
  return { name, apply };
}

// Revive also builds a replacement line; tsk reports no suggested fix.
function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  ast.inspect(file.ast, (n) => {
    if (n === null || n.$type !== "CallExpr") {
      return true;
    }
    const call = n as ast.CallExpr;
    if (call.args.length !== 1) {
      return true;
    }
    const isErrorsNew = isPkgDotName(call.fun, "errors", "New");
    let isTestingError = false;
    const se = call.fun!.$type === "SelectorExpr" ? (call.fun as ast.SelectorExpr) : null;
    if (se !== null && se.sel!.name === "Error") {
      const typ = file.pkg.typeOf(se.x!);
      if (typ !== null) {
        isTestingError = typ.string() === "*testing.T";
      }
    }
    if (!isErrorsNew && !isTestingError) {
      return true;
    }
    const arg = call.args[0]!;
    if (arg.$type !== "CallExpr" || !isPkgDotName((arg as ast.CallExpr).fun, "fmt", "Sprintf")) {
      return true;
    }
    const prefix = isTestingError ? file.render(se!.x!) : "fmt";
    failures.push({
      node: n,
      confidence: 1,
      failure: `should replace ${file.render(se!)}(fmt.Sprintf(...)) with ${prefix}.Errorf(...)`,
    });
    return true;
  });
  return failures;
}
