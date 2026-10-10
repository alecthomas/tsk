import { defineAnalyzer } from "tsk";

export default defineAnalyzer({
  name: "gochecknoinits",
  doc: `checks that no init functions are present in Go code

Init functions run implicitly, in an order that is easy to get wrong, and make
packages harder to test.`,
  run(pass) {
    for (const file of pass.files) {
      for (const decl of file!.decls) {
        if (decl?.$type === "FuncDecl" && decl.name!.name === "init" && (decl.recv?.list.length ?? 0) === 0) {
          pass.report({ pos: decl.pos(), message: "don't use `init` function" });
        }
      }
    }
  },
});
