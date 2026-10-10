import * as ast from "go/ast";
import * as types from "go/types";
import { isPkgDotName } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "context-keys-type";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  ast.inspect(file.ast, (n) => {
    if (n === null || n.$type !== "CallExpr") {
      return true;
    }
    const call = n as ast.CallExpr;
    // The key is context.WithValue's second argument.
    if (!isPkgDotName(call.fun, "context", "WithValue") || call.args.length !== 3) {
      return true;
    }
    const key = file.pkg.typesInfo.types.get(call.args[1]!)?.type ?? null;
    if (key !== null && key.$type === "Basic" && key.kind() !== types.Invalid) {
      failures.push({ node: call, confidence: 1, failure: `should not use basic type ${key.string()} as key in context.WithValue` });
    }
    return true;
  });
  return failures;
}
