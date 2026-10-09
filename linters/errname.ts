import * as ast from "go/ast";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

export default defineAnalyzer({
  name: "errname",
  doc: `check that sentinel errors are prefixed with Err and error types are suffixed with Error

Error variables should be named ErrXxx or errXxx, error types XxxError or
xxxError, and error slices and arrays XxxErrors. Names in all lower or upper
case are accepted as initialisms.`,
  requires: [inspect],
  run(pass) {
    const errorInterface = types.Universe!.lookup("error")!.type()!.underlying() as types.Interface;
    const implementsError = (t: types.Type | null) => t !== null && types.implements_(t, errorInterface);
    // Upstream does not descend into functions or specs, so local variables
    // and types are not checked. Preorder visits parents first, so the
    // skipped nodes nest; files need not be in position order.
    const skipped: ast.Node[] = [];
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.TypeSpec, ast.ValueSpec, ast.FuncDecl)) {
      const node = cursor.node()!;
      while (skipped.length > 0 && !contains(skipped[skipped.length - 1], node)) {
        skipped.pop();
      }
      if (skipped.length > 0) {
        continue;
      }
      skipped.push(node);
      if (node.$type === "ValueSpec") {
        checkValue(pass, node, implementsError);
      } else if (node.$type === "TypeSpec") {
        checkType(pass, node, implementsError);
      }
    }
  },
});

function contains(outer: ast.Node, inner: ast.Node): boolean {
  return outer.pos() <= inner.pos() && inner.end() <= outer.end();
}

function checkValue(pass: Pass<unknown>, spec: ast.ValueSpec, implementsError: (t: types.Type | null) => boolean): void {
  if (spec.names.length !== 1) {
    return;
  }
  const name = spec.names[0]!.name;
  if (implementsError(pass.typesInfo.typeOf(spec.names[0])) && !isValidVarName(name)) {
    const form = startsWithLower(name) ? "errXxx" : "ErrXxx";
    pass.report({ pos: spec.pos(), message: `the sentinel error name \`${name}\` should conform to the \`${form}\` format` });
  }
}

function checkType(pass: Pass<unknown>, spec: ast.TypeSpec, implementsError: (t: types.Type | null) => boolean): void {
  const t = pass.typesInfo.typeOf(spec.name);
  // A pointer also has the methods of pointer receivers, such as Error.
  if (t === null || !implementsError(types.newPointer(t))) {
    return;
  }
  const name = spec.name!.name;
  const lower = startsWithLower(name);
  if (spec.type?.$type === "ArrayType") {
    if (!isValidArrayTypeName(name)) {
      const forms = lower ? "`xxxErrors` or `xxxError`" : "`XxxErrors` or `XxxError`";
      pass.report({ pos: spec.pos(), message: `the error type name \`${name}\` should conform to the ${forms} format` });
    }
  } else if (!isValidTypeName(name)) {
    const form = lower ? "xxxError" : "XxxError";
    pass.report({ pos: spec.pos(), message: `the error type name \`${name}\` should conform to the \`${form}\` format` });
  }
}

function isValidTypeName(name: string): boolean {
  if (isInitialism(name)) {
    return true;
  }
  const words = split(name);
  return count(words, "error") === 1 && words[words.length - 1] === "error";
}

function isValidArrayTypeName(name: string): boolean {
  if (isInitialism(name)) {
    return true;
  }
  const words = split(name);
  const last = words[words.length - 1];
  return (count(words, "errors") === 1 || count(words, "error") === 1) && (last === "errors" || last === "error");
}

function isValidVarName(name: string): boolean {
  if (isInitialism(name)) {
    return true;
  }
  const words = split(name);
  return count(words, "err") === 1 && words[0] === "err";
}

function isInitialism(name: string): boolean {
  return name.toLowerCase() === name || name.toUpperCase() === name;
}

// split splits a camel-case name into lower-case words at each upper-case letter.
function split(name: string): string[] {
  const words: string[] = [];
  let word = "";
  for (const char of name) {
    if (word !== "" && /\p{Lu}/u.test(char)) {
      words.push(word.toLowerCase());
      word = "";
    }
    word += char;
  }
  words.push(word.toLowerCase());
  return words;
}

function count(words: string[], word: string): number {
  return words.filter((w) => w === word).length;
}

function startsWithLower(name: string): boolean {
  return /^\p{Ll}/u.test(name);
}
