// Port of golang.org/x/tools/go/analysis/passes/timeformat at v0.50.0.
import * as ast from "go/ast";
import * as constant from "go/constant";
import * as types from "go/types";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import { isFunctionNamed, isMethodNamed } from "./internal/typesinternal";

const badFormat = "2006-02-01";
const goodFormat = "2006-01-02";

export default defineAnalyzer({
  name: "timeformat",
  doc: `check for calls of (time.Time).Format or time.Parse with 2006-02-01

The timeformat checker looks for time formats with the 2006-02-01 (yyyy-dd-mm)
format. Internationally, "yyyy-dd-mm" does not occur in common calendar date
standards, and so it is more likely that 2006-01-02 (yyyy-mm-dd) was intended.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/timeformat",
  requires: [inspect],
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      const obj = typeutil.callee(pass.typesInfo, call);
      if (!isMethodNamed(obj, "time", "Time", "Format") && !isFunctionNamed(obj, "time", "Parse")) {
        continue;
      }
      if (call.args.length === 0) {
        continue;
      }
      const arg = call.args[0]!;
      const badAt = badFormatAt(pass.typesInfo, arg);
      if (badAt < 0) {
        continue;
      }
      const message = `${badFormat} should be ${goodFormat}`;
      if (arg.$type === "BasicLit") {
        // Skip the opening quote; like upstream, this assumes no escapes.
        const pos = arg.pos() + badAt + 1;
        const end = pos + badFormat.length;
        pass.report({
          pos,
          end,
          message,
          suggestedFixes: [{ message: `Replace ${badFormat} with ${goodFormat}`, textEdits: [{ pos, end, newText: goodFormat }] }],
        });
      } else {
        pass.report({ pos: arg.pos(), message });
      }
    }
  },
});

// Returns the index of badFormat in e's constant string value, or -1.
function badFormatAt(info: types.Info, e: ast.Expr): number {
  const tv = info.types.get(e);
  if (tv === undefined) {
    return -1;
  }
  // Upstream does not unalias the type.
  const t = tv.type;
  if (t?.$type !== "Basic" || (t.info() & types.IsString) === 0 || tv.value === null) {
    return -1;
  }
  return constant.stringVal(tv.value).indexOf(badFormat);
}
