import * as ast from "go/ast";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Require an empty line between embedded and regular fields. */
  emptyLine: boolean;
  /** Forbid embedding sync.Mutex and sync.RWMutex. */
  forbidMutex: boolean;
}

export default defineAnalyzer<Config>({
  name: "embeddedstructfieldcheck",
  doc: "Embedded types should be at the top of the field list of a struct, and there must be an empty line separating embedded fields from regular fields.",
  requires: [inspect],
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: { emptyLine: true, forbidMutex: false },
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.StructType)) {
      analyze(pass, cursor.node() as ast.StructType);
    }
  },
});

function analyze(pass: Pass<Config>, st: ast.StructType): void {
  let lastEmbedded: ast.Field | null = null;
  let firstRegular: ast.Field | null = null;
  for (const field of st.fields!.list) {
    if (field!.names.length !== 0) {
      if (firstRegular === null) {
        firstRegular = field;
      }
      continue;
    }
    if (pass.config.forbidMutex) {
      checkMutex(pass, field!);
    }
    if (lastEmbedded === null || lastEmbedded.pos() < field!.pos()) {
      lastEmbedded = field;
    }
    if (firstRegular !== null && firstRegular.pos() < field!.pos()) {
      pass.report({ pos: field!.pos(), message: "embedded fields should be listed before regular fields" });
      return;
    }
  }
  if (!pass.config.emptyLine || lastEmbedded === null || firstRegular === null) {
    return;
  }
  const line = pass.fset.position(lastEmbedded.end()).line;
  const next = firstRegular.doc?.pos() ?? firstRegular.pos();
  if (pass.fset.position(next).line !== line + 2) {
    pass.report({
      pos: lastEmbedded.pos(),
      message: "there must be an empty line separating embedded fields from regular fields",
      suggestedFixes: [
        {
          message: "adding extra line separating embedded fields from regular fields",
          textEdits: [{ pos: next, end: next, newText: "\n\n" }],
        },
      ],
    });
  }
}

function checkMutex(pass: Pass<Config>, field: ast.Field): void {
  const t = field.type?.$type === "StarExpr" ? field.type.x : field.type;
  if (t?.$type !== "SelectorExpr" || t.x?.$type !== "Ident") {
    return;
  }
  if (t.x.name === "sync" && (t.sel!.name === "Mutex" || t.sel!.name === "RWMutex")) {
    pass.report({ pos: t.pos(), message: `sync.${t.sel!.name} should not be embedded` });
  }
}
