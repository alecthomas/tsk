import * as ast from "go/ast";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Skip interface methods with a single unnamed parameter. */
  skipSingleParam: boolean;
}

export default defineAnalyzer<Config>({
  name: "inamedparam",
  doc: "reports interfaces with unnamed method parameters",
  requires: [inspect],
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: { skipSingleParam: false },
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.InterfaceType)) {
      const iface = cursor.node() as ast.InterfaceType;
      for (const method of iface.methods?.list ?? []) {
        const fn = method!.type;
        if (fn?.$type !== "FuncType" || fn.params === null || method!.names.length === 0) {
          continue;
        }
        const name = method!.names[0]!.name;
        if (pass.config.skipSingleParam && fn.params.list.length === 1) {
          continue;
        }
        for (const param of fn.params.list) {
          if (param!.names.length !== 0) {
            continue;
          }
          const t = param!.type;
          let typeName = "";
          if (t?.$type === "SelectorExpr") {
            typeName = `${t.x?.$type === "Ident" ? `${t.x.name}.` : ""}${t.sel!.name}`;
          } else if (t?.$type === "Ident") {
            typeName = t.name;
          }
          pass.report({
            pos: param!.pos(),
            message:
              typeName !== "" ? `interface method ${name} must have named param for type ${typeName}` : `interface method ${name} must have all named params`,
          });
        }
      }
    }
  },
});
