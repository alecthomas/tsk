import type * as ast from "go/ast";
import { getTypeNames } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "get-return";

const getterPrefix = "GET";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  for (const decl of file.ast.decls) {
    if (decl!.$type !== "FuncDecl") {
      continue;
    }
    const fd = decl as ast.FuncDecl;
    const results = fd.type!.results;
    if (!isGetter(fd.name!.name) || (results !== null && results.list.length > 0)) {
      continue;
    }
    // The Get prefix of an HTTP handler refers to HTTP GET.
    if (isHTTPHandler(fd.type!.params)) {
      continue;
    }
    failures.push({
      failure: `function '${fd.name!.name}' seems to be a getter but it does not return any result`,
      node: fd,
      confidence: 0.8,
    });
  }
  return failures;
}

function isGetter(name: string): boolean {
  if (!name.toUpperCase().startsWith(getterPrefix) || name.length === getterPrefix.length) {
    return false;
  }
  const c = name[getterPrefix.length];
  return !(c >= "a" && c <= "z");
}

function isHTTPHandler(params: ast.FieldList | null): boolean {
  const typeNames = getTypeNames(params) ?? [];
  return typeNames.length >= 2 && typeNames[0] === "http.ResponseWriter" && typeNames[1] === "*http.Request";
}
