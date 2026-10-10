import * as ast from "go/ast";
import * as token from "go/token";
import { isIdent } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "range";

export function create(): Rule {
  return { name, apply };
}

// Revive also builds a replacement line; tsk reports no suggested fix.
function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  ast.inspect(file.ast, (n) => {
    if (n !== null && n.$type === "RangeStmt") {
      const rs = n as ast.RangeStmt;
      if (rs.value !== null && isIdent(rs.value, "_")) {
        failures.push({
          node: rs.value,
          confidence: 1,
          failure: `should omit 2nd value from range; this loop is equivalent to \`for ${file.render(rs.key!)} ${token.Token.string(rs.tok)} range ...\``,
        });
      }
    }
    return true;
  });
  return failures;
}
