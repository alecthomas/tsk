import * as ast from "go/ast";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Maximum number of interface elements, embedded interfaces included. */
  max: number;
}

export default defineAnalyzer<Config>({
  name: "interfacebloat",
  doc: "A linter that checks the number of methods inside an interface.",
  requires: [inspect],
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: { max: 10 },
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.InterfaceType)) {
      const iface = cursor.node() as ast.InterfaceType;
      const count = iface.methods!.list.length;
      if (count > pass.config.max) {
        pass.report({ pos: iface.pos(), message: `the interface has more than ${pass.config.max} methods: ${count}` });
      }
    }
  },
});
