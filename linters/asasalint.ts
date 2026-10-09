import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Regular expressions matching callee names, such as `fmt.Println`, to skip. */
  exclude: string[];
  /** Skip common print and log functions, which deliberately take []any as one value. */
  useBuiltinExclusions: boolean;
  /** Skip _test.go files. */
  ignoreTest: boolean;
}

const builtinExclusions = /^(fmt|log|logger|t|)\.(Print|Fprint|Sprint|Fatal|Panic|Error|Warn|Warning|Info|Debug|Log)(|f|ln)$/;

export default defineAnalyzer<Config>({
  name: "asasalint",
  doc: `check for passing []any as any in variadic func(...any)

Passing a []any to a ...any parameter without ... wraps the whole slice as a
single argument, which is rarely intended.`,
  requires: [inspect],
  config: { exclude: [], useBuiltinExclusions: true, ignoreTest: false },
  run(pass) {
    const excludes = pass.config.exclude.filter((pattern) => pattern !== "").map((pattern) => new RegExp(pattern));
    if (pass.config.useBuiltinExclusions) {
      excludes.push(builtinExclusions);
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      if (call.ellipsis !== token.NoPos || call.args.length === 0) {
        continue;
      }
      if (pass.config.ignoreTest && pass.fset.position(call.pos()).filename.endsWith("_test.go")) {
        continue;
      }
      const name = types.exprString(call.fun);
      if (excludes.some((exclude) => exclude.test(name))) {
        continue;
      }
      const signature = pass.typesInfo.typeOf(call.fun);
      if (signature?.$type !== "Signature" || !signature.variadic() || call.args.length !== signature.params()!.len()) {
        continue;
      }
      const params = signature.params()!;
      const last = call.args[call.args.length - 1];
      if (!isSliceOfAny(params.at(params.len() - 1)!.type()) || !isSliceOfAny(pass.typesInfo.typeOf(last))) {
        continue;
      }
      pass.report({ pos: last!.pos(), end: last!.end(), message: `pass []any as any to func ${name} ${signature.string()}` });
    }
  },
});

function isSliceOfAny(t: types.Type | null): boolean {
  if (t?.$type !== "Slice") {
    return false;
  }
  // Unlike upstream, see through the any alias, which go/types now records.
  const element = types.unalias(t.elem());
  return element?.$type === "Interface" && element.numMethods() === 0;
}
