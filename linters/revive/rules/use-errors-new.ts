import { defineAnalyzer } from "tsk";
import { runRule } from "../lint";
import * as ast from "go/ast";
import { isPkgDotName } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "use-errors-new";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  // From Go 1.26, fmt.Errorf of an unformatted string matches errors.New.
  if (file.pkg.isAtLeastGoVersion("1.26")) {
    return [];
  }
  const failures: Failure[] = [];
  ast.inspect(file.ast, (n) => {
    if (n !== null && n.$type === "CallExpr") {
      const call = n as ast.CallExpr;
      if (isPkgDotName(call.fun, "fmt", "Errorf") && call.args.length <= 1) {
        failures.push({ node: n, confidence: 1, failure: "replace fmt.Errorf by errors.New" });
      }
    }
    return true;
  });
  return failures;
}

export default defineAnalyzer({
  name: "use_errors_new",
  doc: "Spots calls to `fmt.Errorf` that can be replaced by `errors.New`",
  url: "https://github.com/mgechev/revive/blob/v1.17.0/RULES_DESCRIPTIONS.md#use-errors-new",
  group: "revive",
  enabledByDefault: false,
  runDespiteErrors: true,
  run(pass) {
    runRule(pass, create());
  },
});
