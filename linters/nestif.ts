import * as ast from "go/ast";
import { defineAnalyzer, formatNode, type Pass } from "tsk";

interface Config {
  /** The least complexity of an if statement to report. */
  minComplexity: number;
}

export default defineAnalyzer<Config>({
  name: "nestif",
  doc: `reports deeply nested if statements

An if statement's complexity grows by each nested if's depth, and by one for
each else if and else, so deep nesting costs more than a flat chain.`,
  config: { minComplexity: 5 },
  run(pass) {
    for (const file of pass.files) {
      for (const decl of file.decls) {
        if (decl?.$type !== "FuncDecl" || decl.body === null) {
          continue;
        }
        for (const stmt of decl.body.list) {
          // The outermost if statements are checked, including those in
          // function literals outside any if.
          ast.inspect(stmt, (node) => {
            if (node?.$type !== "IfStmt") {
              return true;
            }
            check(pass, node);
            return false;
          });
        }
      }
    }
  },
});

function check(pass: Pass<Config>, stmt: ast.IfStmt): void {
  const complexity = new Complexity();
  complexity.visit(stmt, false);
  if (complexity.total < pass.config.minComplexity) {
    return;
  }
  // Upstream prints the condition with go/printer's zero config, which
  // indents nothing, and reports the start of the line.
  const cond = formatNode(stmt.cond!, pass.fset).replace(/\n\t+/g, "\n");
  const tokenFile = pass.fset.file(stmt.pos())!;
  pass.report({
    pos: tokenFile.lineStart(tokenFile.line(stmt.pos())),
    message: `\`if ${cond}\` has complex nested blocks (complexity: ${complexity.total})`,
  });
}

// Complexity sums an if statement's nested ifs, weighted by their depth.
class Complexity {
  total = 0;
  private nesting = 0;

  // visit adds an if statement, one for an else if, and then what its
  // branches hold.
  visit(stmt: ast.IfStmt, elseIf: boolean): void {
    this.total += elseIf ? 1 : this.nesting;
    this.nesting++;
    this.walk(stmt.body);
    this.nesting--;
    const otherwise = stmt.else;
    if (otherwise?.$type === "BlockStmt") {
      this.total++;
      this.nesting++;
      this.walk(otherwise);
      this.nesting--;
    } else if (otherwise?.$type === "IfStmt") {
      this.visit(otherwise, true);
    }
  }

  // walk visits the if statements in a block, but not those nested in them,
  // which visit reaches itself.
  private walk(block: ast.Node | null): void {
    ast.inspect(block, (node) => {
      if (node?.$type !== "IfStmt") {
        return true;
      }
      this.visit(node, false);
      return false;
    });
  }
}
