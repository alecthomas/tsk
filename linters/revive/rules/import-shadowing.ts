import type * as ast from "go/ast";
import * as token from "go/token";
import { isVersionPath, type Visitor, walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "import-shadowing";

// Subtrees that declare no identifiers, or whose identifiers were already
// seen: imports, calls, keys, returns, selectors, and struct fields.
const skipped = new Set(["CallExpr", "ImportSpec", "KeyValueExpr", "ReturnStmt", "SelectorExpr", "StructType"]);

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const importNames = new Set(file.ast.imports.map((imp) => importName(imp!)));
  const packageNameIdent = file.ast.name;
  // Identifiers resolve to ast.Objects; unresolved ones share the null key,
  // so only the first of them is reported, as in revive.
  const alreadySeen = new Set<ast.Object | null>();
  const skipIdents = new Set<ast.Ident>();
  const visitor: Visitor = {
    visit(n) {
      if (n === null) {
        return this;
      }
      if (skipped.has(n.$type)) {
        return null;
      }
      switch (n.$type) {
        case "AssignStmt":
          // Only id := expr declares identifiers.
          return (n as ast.AssignStmt).tok === token.DEFINE ? this : null;
        case "FuncDecl": {
          const fn = n as ast.FuncDecl;
          if (fn.recv !== null) {
            skipIdents.add(fn.name!);
          }
          break;
        }
        case "Ident": {
          const id = n as ast.Ident;
          if (id === packageNameIdent) {
            return null;
          }
          if (id.name !== "_" && importNames.has(id.name) && !alreadySeen.has(id.obj) && !skipIdents.has(id)) {
            failures.push({ failure: `The name '${id.name}' shadows an import name`, confidence: 1, node: id });
            alreadySeen.add(id.obj);
          }
          break;
        }
      }
      return this;
    },
  };
  walk(visitor, file.ast);
  return failures;
}

// importName is the import's alias, or the last element of its path that is
// not a major version.
function importName(imp: ast.ImportSpec): string {
  if (imp.name !== null) {
    return imp.name.name;
  }
  const parts = imp.path!.value.replace(/^"+|"+$/g, "").split("/");
  const last = parts[parts.length - 1];
  if (isVersionPath(last) && parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return last;
}
