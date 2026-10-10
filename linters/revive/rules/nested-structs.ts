import * as ast from "go/ast";
import type { Failure, File, Rule } from "../lint";

export const name = "nested-structs";

const message = "no nested structs are allowed";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  ast.inspect(file.ast, (n) => {
    if (n?.$type === "StructType") {
      checkFields((n as ast.StructType).fields, failures);
    }
    return true;
  });
  return failures;
}

// checkFields reports structs in a struct's fields, but not inside channel,
// map, or non-struct array element types.
function checkFields(fields: ast.FieldList | null, failures: Failure[]): void {
  if (fields === null) {
    return;
  }
  ast.inspect(fields, (n) => {
    switch (n?.$type) {
      case "StructType":
        failures.push({ failure: message, node: n, confidence: 1 });
        return false;
      case "ArrayType":
        if ((n as ast.ArrayType).elt?.$type === "StructType") {
          failures.push({ failure: message, node: n, confidence: 1 });
        }
        return false;
      case "ChanType":
      case "MapType":
        return false;
      default:
        return true;
    }
  });
}
