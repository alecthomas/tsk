import { defineAnalyzer } from "tsk";

interface Config {
  /** The most blank identifiers an assignment may have. */
  maxBlankIdentifiers: number;
}

export default defineAnalyzer<Config>({
  name: "dogsled",
  doc: `checks assignments with too many blank identifiers

Ignoring most of a call's results, as in x, _, _, _ := f(), suggests the
function returns too much.`,
  config: { maxBlankIdentifiers: 2 },
  run(pass) {
    for (const file of pass.files) {
      for (const decl of file!.decls) {
        if (decl?.$type !== "FuncDecl" || decl.body === null) {
          continue;
        }
        // Only a function body's own statements are checked.
        for (const stmt of decl.body.list) {
          if (stmt?.$type !== "AssignStmt") {
            continue;
          }
          const blanks = stmt.lhs.filter((lhs) => lhs?.$type === "Ident" && lhs.name === "_").length;
          if (blanks > pass.config.maxBlankIdentifiers) {
            pass.report({ pos: stmt.pos(), message: `declaration has ${blanks} blank identifiers` });
          }
        }
      }
    }
  },
});
