import * as ast from "go/ast";
import * as types from "go/types";
import { receiverType } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "unexported-return";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  // Other packages cannot use symbols of test files or main packages.
  if (!file.isImportable()) {
    return [];
  }
  const failures: Failure[] = [];
  for (const decl of file.ast.decls) {
    if (decl!.$type !== "FuncDecl") {
      continue;
    }
    const fn = decl as ast.FuncDecl;
    if (fn.type!.results === null || !fn.name!.isExported()) {
      continue;
    }
    let thing = "func";
    if (fn.recv !== null && fn.recv.list.length > 0) {
      thing = "method";
      // Exported methods of unexported types, such as sort.Interface implementations, are fine.
      if (!ast.isExported(receiverType(fn))) {
        continue;
      }
    }
    for (const ret of fn.type!.results.list) {
      const typ = file.pkg.typeOf(ret!.type!);
      if (exportedType(typ)) {
        continue;
      }
      failures.push({
        node: ret!.type!,
        confidence: 0.8,
        failure: `exported ${thing} ${fn.name!.name} returns unexported type ${typeString(file, typ)}, which can be annoying to use`,
      });
      break;
    }
  }
  return failures;
}

// typeString qualifies the linted package's types by its name, not its path,
// because revive type-checks the package under its name.
function typeString(file: File, typ: types.Type | null): string {
  const pkg = file.pkg.typesPkg;
  return types.typeString(typ, (p) => (p!.path() === pkg.path() ? pkg.name() : p!.path()));
}

// exportedType errs on the side of true, such as for composite types.
function exportedType(typ: types.Type | null): boolean {
  if (typ === null) {
    return true;
  }
  switch (typ.$type) {
    case "Alias":
    case "Named":
      return exportedTypeName(typ.obj()!);
    case "Map":
      return exportedType(typ.key()) && exportedType(typ.elem());
    case "Array":
    case "Slice":
    case "Pointer":
    case "Chan":
      return exportedType(typ.elem());
    default:
      return true;
  }
}

function exportedTypeName(obj: types.TypeName): boolean {
  // Builtin types have no package.
  return obj.pkg() === null || obj.exported();
}
