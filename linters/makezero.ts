import * as ast from "go/ast";
import * as token from "go/token";
import type * as types from "go/types";
import { defineAnalyzer, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Report every slice made with a non-zero length, not just ones appended to. */
  always: boolean;
}

export default defineAnalyzer<Config>({
  name: "makezero",
  doc: `Find slice declarations with non-zero initial length

A "nozero" comment on the line suppresses a finding.`,
  requires: [inspect],
  config: { always: false },
  run(pass) {
    for (const fileCursor of pass.resultOf(inspect).root().children()) {
      checkFile(pass, fileCursor.node() as ast.File);
    }
  },
});

// checkFile tracks slices made with a non-zero length, reporting appends to
// them that follow in the same file.
function checkFile(pass: Pass<Config>, file: ast.File): void {
  const nonZero = new Set<types.Object>();
  const suppressed = (node: ast.Node) => hasNoZeroComment(pass, file, node);
  ast.inspect(file, (node) => {
    if (node?.$type === "CallExpr") {
      const slice = node.args[0];
      if (!isIdent(node.fun, "append") || slice?.$type !== "Ident") {
        return true;
      }
      const object = pass.typesInfo.objectOf(slice);
      if (object !== null && nonZero.has(object) && !suppressed(node.fun!)) {
        pass.report({ pos: node.fun!.pos(), message: `append to slice \`${slice.name}\` with non-zero initialized length` });
      }
    } else if (node?.$type === "AssignStmt") {
      node.rhs.forEach((rhs, i) => {
        if (rhs?.$type !== "CallExpr" || !isIdent(rhs.fun, "make") || rhs.args.length !== 2) {
          return;
        }
        const length = rhs.args[1];
        if (pass.typesInfo.typeOf(rhs.args[0])?.underlying()?.$type !== "Slice") {
          return;
        }
        if (length?.$type === "BasicLit" && length.kind === token.INT && length.value === "0") {
          return;
        }
        const lhs = node.lhs[i]!;
        if (pass.config.always && !suppressed(rhs.fun!)) {
          pass.report({ pos: node.pos(), message: `slice \`${formatNode(lhs, pass.fset)}\` does not have non-zero initial length` });
        }
        const object = lhs.$type === "Ident" ? pass.typesInfo.objectOf(lhs) : null;
        if (object !== null) {
          nonZero.add(object);
        }
      });
    }
    return true;
  });
}

function isIdent(expr: ast.Expr | null, name: string): boolean {
  return expr?.$type === "Ident" && expr.name === name;
}

// hasNoZeroComment reports whether a comment starting with "nozero" begins on
// the node's line.
function hasNoZeroComment(pass: Pass<Config>, file: ast.File, node: ast.Node): boolean {
  const line = pass.fset.position(node.pos()).line;
  return file.comments.some((group) => pass.fset.position(group!.pos()).line === line && /^\s*nozero\b/.test(group!.text()));
}
