import * as ast from "go/ast";
import * as token from "go/token";
import type { Failure, File, Rule } from "../lint";

export const name = "redefines-builtin-id";

const builtInConstAndVars = new Set(["true", "false", "iota", "nil"]);

const builtFunctions = [
  "append",
  "cap",
  "close",
  "complex",
  "copy",
  "delete",
  "imag",
  "len",
  "make",
  "new",
  "panic",
  "print",
  "println",
  "real",
  "recover",
];

const builtFunctionsAfterGo121 = ["clear", "max", "min"];

const builtInTypes = new Set([
  "bool",
  "byte",
  "comparable",
  "complex128",
  "complex64",
  "error",
  "float32",
  "float64",
  "int",
  "int16",
  "int32",
  "int64",
  "int8",
  "rune",
  "string",
  "uint",
  "uint16",
  "uint32",
  "uint64",
  "uint8",
  "uintptr",
  "any",
]);

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const builtFuncs = new Set(file.pkg.isAtLeastGoVersion("1.21") ? [...builtFunctions, ...builtFunctionsAfterGo121] : builtFunctions);
  const builtInKind = (id: string): string | undefined => {
    if (builtFuncs.has(id)) {
      return "function";
    }
    if (builtInConstAndVars.has(id)) {
      return "constant or variable";
    }
    return builtInTypes.has(id) ? "type" : undefined;
  };
  const addFailure = (node: ast.Node, failure: string): void => {
    failures.push({ failure, confidence: 1, node });
  };
  ast.inspect(file.ast, (node) => {
    if (node === null) {
      return true;
    }
    switch (node.$type) {
      case "GenDecl": {
        const n = node as ast.GenDecl;
        if (n.tok === token.TYPE) {
          // Only the first spec of a type declaration is checked.
          if (n.specs.length < 1 || n.specs[0]!.$type !== "TypeSpec") {
            return false;
          }
          const id = (n.specs[0] as ast.TypeSpec).name!.name;
          const bt = builtInKind(id);
          if (bt !== undefined) {
            addFailure(n, `redefinition of the built-in ${bt} ${id}`);
          }
        } else if (n.tok === token.VAR || n.tok === token.CONST) {
          for (const vs of n.specs) {
            if (vs!.$type !== "ValueSpec") {
              continue;
            }
            for (const id of (vs as ast.ValueSpec).names) {
              const bt = builtInKind(id!.name);
              if (bt !== undefined) {
                addFailure(n, `redefinition of the built-in ${bt} ${id!.name}`);
              }
            }
          }
        } else {
          return false;
        }
        break;
      }
      case "FuncDecl": {
        const n = node as ast.FuncDecl;
        if (n.recv !== null) {
          break;
        }
        const id = n.name!.name;
        const bt = builtInKind(id);
        if (bt !== undefined) {
          addFailure(n, `redefinition of the built-in ${bt} ${id}`);
        }
        break;
      }
      case "FuncType": {
        const n = node as ast.FuncType;
        const fields = [...(n.typeParams?.list ?? []), ...(n.params?.list ?? []), ...(n.results?.list ?? [])];
        for (const field of fields) {
          for (const id of field!.names) {
            const obj = id!.obj;
            if (obj === null || (obj.kind !== ast.Var && obj.kind !== ast.Typ)) {
              continue;
            }
            const bt = builtInKind(obj.name);
            if (bt !== undefined) {
              addFailure(id!, `redefinition of the built-in ${bt} ${obj.name}`);
            }
          }
        }
        break;
      }
      case "AssignStmt": {
        const n = node as ast.AssignStmt;
        for (const e of n.lhs) {
          if (e!.$type !== "Ident") {
            continue;
          }
          const id = (e as ast.Ident).name;
          const bt = builtInKind(id);
          if (bt === undefined) {
            continue;
          }
          if (bt !== "constant or variable") {
            addFailure(n, `redefinition of the built-in ${bt} ${id}`);
          } else if (n.tok === token.DEFINE) {
            addFailure(n, `assignment creates a shadow of built-in identifier ${id}`);
          } else {
            addFailure(n, `assignment modifies built-in identifier ${id}`);
          }
        }
        break;
      }
    }
    return true;
  });
  return failures;
}
