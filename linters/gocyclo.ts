import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer, type Pass } from "tsk";

interface Config {
  /** Report functions whose cyclomatic complexity is above this. */
  minComplexity: number;
}

export default defineAnalyzer<Config>({
  name: "gocyclo",
  doc: `computes and checks the cyclomatic complexity of functions

A function's complexity is one, plus one for each if, for, range, case, select
case, && and ||. A //gocyclo:ignore comment in its doc comment skips it.`,
  config: { minComplexity: 30 },
  runDespiteErrors: true,
  run(pass) {
    for (const file of pass.files) {
      for (const decl of file.decls) {
        if (decl?.$type === "FuncDecl") {
          check(pass, decl, funcName(decl), decl.doc);
        } else if (decl?.$type === "GenDecl") {
          // Function literals assigned in declarations count as functions,
          // named after the declaration's first name.
          for (const spec of decl.specs) {
            if (spec?.$type !== "ValueSpec") {
              continue;
            }
            for (const value of spec.values) {
              if (value?.$type === "FuncLit") {
                check(pass, value, spec.names[0]!.name, decl.doc);
              }
            }
          }
        }
      }
    }
  },
});

function check(pass: Pass<Config>, fn: ast.Node, name: string, doc: ast.CommentGroup | null): void {
  if (doc?.list.some((comment) => comment!.text.startsWith("//gocyclo:") && comment!.text.slice("//gocyclo:".length).trim() === "ignore")) {
    return;
  }
  const value = complexity(fn);
  if (value > pass.config.minComplexity) {
    pass.report({ pos: fn.pos(), message: `cyclomatic complexity ${value} of func \`${name}\` is high (> ${pass.config.minComplexity})` });
  }
}

function complexity(fn: ast.Node): number {
  let total = 1;
  ast.inspect(fn, (node) => {
    switch (node?.$type) {
      case "IfStmt":
      case "ForStmt":
      case "RangeStmt":
        total++;
        break;
      case "CaseClause":
        // A default case adds nothing.
        if (node.list.length > 0) {
          total++;
        }
        break;
      case "CommClause":
        if (node.comm !== null) {
          total++;
        }
        break;
      case "BinaryExpr":
        if (node.op === token.LAND || node.op === token.LOR) {
          total++;
        }
        break;
    }
    return true;
  });
  return total;
}

// funcName names a function, or a method as (T).Name.
function funcName(fn: ast.FuncDecl): string {
  const recv = fn.recv?.list[0];
  return recv === undefined || recv === null ? fn.name!.name : `(${recvString(recv.type)}).${fn.name!.name}`;
}

function recvString(expr: ast.Expr | null): string {
  switch (expr?.$type) {
    case "Ident":
      return expr.name;
    case "StarExpr":
      return `*${recvString(expr.x)}`;
    case "IndexExpr":
    case "IndexListExpr":
      return recvString(expr.x);
  }
  return "BADRECV";
}
