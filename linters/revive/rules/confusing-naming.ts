import * as ast from "go/ast";
import { isCgoExported } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "confusing-naming";

// The holder of functions, which have no receiver.
const defaultStructName = "_";

interface ReferenceMethod {
  fileName: string;
  id: ast.Ident;
}

export function create(): Rule {
  // Names seen so far in the package, by holder and then upper-cased name.
  const methods = new Map<string, Map<string, ReferenceMethod>>();
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      // Messages name the other file by its path as the driver gives it,
      // which, unlike revive's command line, is absolute.
      const checkMethodName = (holder: string, id: ast.Ident): void => {
        if (id.name === "init" && holder === defaultStructName) {
          return;
        }
        const upper = id.name.toUpperCase();
        let names = methods.get(holder);
        if (names === undefined) {
          names = new Map();
          methods.set(holder, names);
        }
        const ref = names.get(upper);
        if (ref !== undefined) {
          const kind = holder === defaultStructName ? "function" : "method";
          const where = file.name === ref.fileName ? "the same source file" : ref.fileName;
          failures.push({ failure: `Method '${id.name}' differs only by capitalization to ${kind} '${ref.id.name}' in ${where}`, confidence: 1, node: id });
          return;
        }
        names.set(upper, { fileName: file.name, id });
      };
      ast.inspect(file.ast, (n) => {
        if (n === null) {
          return true;
        }
        if (n.$type === "FuncDecl") {
          const fn = n as ast.FuncDecl;
          // Functions exported to C but not in the Go API keep their names.
          if (ast.isExported(fn.name!.name) || !isCgoExported(fn)) {
            checkMethodName(structName(fn.recv), fn.name!);
          }
        } else if (n.$type === "TypeSpec") {
          const spec = n as ast.TypeSpec;
          if (spec.type!.$type === "StructType") {
            failures.push(...checkStructFields((spec.type as ast.StructType).fields!, spec.name!.name));
          }
        }
        return true;
      });
      return failures;
    },
  };
}

// structName names a receiver's type, or defaultStructName.
function structName(recv: ast.FieldList | null): string {
  if (recv === null || recv.list.length < 1) {
    return defaultStructName;
  }
  let t = recv.list[0]!.type!;
  if (t.$type === "StarExpr") {
    t = (t as ast.StarExpr).x!;
  }
  if (t.$type === "IndexExpr") {
    t = (t as ast.IndexExpr).x!;
  }
  return t.$type === "Ident" ? (t as ast.Ident).name : defaultStructName;
}

function checkStructFields(fields: ast.FieldList, structName: string): Failure[] {
  const failures: Failure[] = [];
  const seen = new Set<string>();
  for (const f of fields.list) {
    for (const id of f!.names) {
      if (id!.name === "_") {
        continue;
      }
      const norm = id!.name.toUpperCase();
      if (seen.has(norm)) {
        failures.push({ failure: `Field '${id!.name}' differs only by capitalization to other field in the struct type ${structName}`, confidence: 1, node: id! });
      } else {
        seen.add(norm);
      }
    }
  }
  return failures;
}
