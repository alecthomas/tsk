import { receiverType } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "marshal-receiver";

const marshalMethods = new Set(["MarshalJSON", "MarshalText", "MarshalYAML"]);
const unmarshalMethods = new Set(["UnmarshalJSON", "UnmarshalText", "UnmarshalYAML"]);

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  for (const decl of file.ast.decls) {
    if (decl?.$type !== "FuncDecl" || decl.recv === null || decl.recv.list.length === 0) {
      continue;
    }
    const method = decl.name!.name;
    const isPtr = decl.recv.list[0]!.type!.$type === "StarExpr";
    let msg: string;
    if (marshalMethods.has(method) && isPtr) {
      msg = "method should use a value receiver, not a pointer receiver";
    } else if (unmarshalMethods.has(method) && !isPtr) {
      msg = "method should use a pointer receiver, not a value receiver";
    } else {
      continue;
    }
    failures.push({ failure: `${receiverType(decl)}.${method} ${msg}`, node: decl, confidence: 1 });
  }
  return failures;
}
