import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer } from "tsk";

interface Config {
  /** Maximum cyclomatic complexity of a function. */
  maxComplexity: number;
  /** Maximum average complexity of a package's functions; 0 disables it. */
  packageAverage: number;
}

export default defineAnalyzer<Config>({
  name: "cyclop",
  doc: "checks function and package cyclomatic complexity",
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: { maxComplexity: 10, packageAverage: 0 },
  run(pass) {
    const { maxComplexity, packageAverage } = pass.config;
    let sum = 0;
    let count = 0;
    // Upstream reports the package average at the last file's package clause.
    let pkgName = "";
    let pkgPos = token.NoPos;
    for (const file of pass.files) {
      pkgName = file!.name!.name;
      pkgPos = file!.pos();
      for (const decl of file!.decls) {
        if (decl?.$type !== "FuncDecl") {
          continue;
        }
        const comp = complexity(decl);
        count++;
        sum += comp;
        if (comp > maxComplexity) {
          pass.report({
            pos: decl.pos(),
            message: `calculated cyclomatic complexity for function ${decl.name!.name} is ${comp}, max is ${maxComplexity}`,
          });
        }
      }
    }
    const avg = sum / count;
    if (packageAverage > 0 && avg > packageAverage) {
      pass.report({
        pos: pkgPos,
        message: `the average complexity for the package ${pkgName} is ${avg.toFixed(6)}, max is ${packageAverage.toFixed(6)}`,
      });
    }
  },
});

function complexity(fn: ast.FuncDecl): number {
  let comp = 0;
  ast.inspect(fn, (node) => {
    switch (node?.$type) {
      case "FuncDecl":
      case "IfStmt":
      case "ForStmt":
      case "RangeStmt":
      case "CaseClause":
      case "CommClause":
        comp++;
        break;
      case "BinaryExpr":
        if (node.op === token.LAND || node.op === token.LOR) {
          comp++;
        }
        break;
    }
    return true;
  });
  return comp;
}
