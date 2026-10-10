import type * as ast from "go/ast";

/** A function's name as "Name", or "(T).Name" or "(*T).Name" for a method. */
export function funcName(fn: ast.FuncDecl): string {
  if (fn.recv !== null && fn.recv.numFields() > 0) {
    return `(${recvString(fn.recv.list[0]!.type!)}).${fn.name!.name}`;
  }
  return fn.name!.name;
}

function recvString(recv: ast.Expr): string {
  switch (recv.$type) {
    case "Ident":
      return (recv as ast.Ident).name;
    case "StarExpr":
      return `*${recvString((recv as ast.StarExpr).x!)}`;
    default:
      return "BADRECV";
  }
}
