import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Report each const with a value instead of the whole const block. */
  reportIndividual: boolean;
}

export default defineAnalyzer<Config>({
  name: "iotamixing",
  doc: "checks if iotas are being used in const blocks with other non-iota declarations.",
  url: "https://github.com/AdminBenni/iota-mixing",
  requires: [inspect],
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: { reportIndividual: false },
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.GenDecl)) {
      const decl = cursor.node() as ast.GenDecl;
      if (decl.tok !== token.CONST) {
        continue;
      }
      const specs = decl.specs.filter((spec): spec is ast.ValueSpec => spec?.$type === "ValueSpec");
      if (!specs.some(usesIota)) {
        continue;
      }
      const valued = specs.filter((spec) => !usesIota(spec) && spec.values.length > 0);
      if (pass.config.reportIndividual) {
        for (const spec of valued) {
          const names = spec.names.map((name) => name!.name).join(", ");
          pass.report({
            pos: spec.pos(),
            message: `${names} is a const with r-val in same const block as iota. keep iotas in separate const blocks`,
          });
        }
      } else if (valued.length > 0) {
        pass.report({ pos: decl.pos(), message: "iota mixing. keep iotas in separate blocks to consts with r-val" });
      }
    }
  },
});

// usesIota reports whether a spec's values include a bare iota.
function usesIota(spec: ast.ValueSpec): boolean {
  return spec.values.some((value) => value?.$type === "Ident" && value.name === "iota");
}
