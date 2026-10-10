import type * as ast from "go/ast";
import * as token from "go/token";
import { type Visitor, walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "unexported-naming";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const lintIDs = (ids: readonly (ast.Ident | null)[]): void => {
    for (const id of ids) {
      if (id!.isExported()) {
        failures.push({ failure: `the symbol ${id!.name} is local, its name should start with a lowercase letter`, confidence: 1, node: id! });
      }
    }
  };
  const lintFields = (fields: ast.FieldList | null): void => {
    if (fields !== null) {
      lintIDs(fields.list.flatMap((field) => field!.names));
    }
  };
  const visitor: Visitor = {
    visit(node) {
      if (node === null) {
        return this;
      }
      switch (node.$type) {
        case "FuncDecl":
        case "FuncLit": {
          const fn = node as ast.FuncDecl | ast.FuncLit;
          lintFields(fn.type!.params);
          lintFields(fn.type!.results);
          if (fn.body !== null) {
            walk(this, fn.body);
          }
          return null;
        }
        case "AssignStmt": {
          const n = node as ast.AssignStmt;
          if (n.tok !== token.DEFINE) {
            return null;
          }
          lintIDs(n.lhs.filter((e) => e!.$type === "Ident") as ast.Ident[]);
          break;
        }
        case "DeclStmt": {
          const decl = (node as ast.DeclStmt).decl!;
          if (decl.$type !== "GenDecl") {
            return null;
          }
          const specs = (decl as ast.GenDecl).specs;
          if (specs.length < 1 || specs[0]!.$type !== "ValueSpec") {
            return null;
          }
          // Only the first spec of a declaration is checked.
          lintIDs((specs[0] as ast.ValueSpec).names);
          break;
        }
      }
      return this;
    },
  };
  walk(visitor, file.ast);
  return failures;
}
