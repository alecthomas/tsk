import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer } from "tsk";

interface Config {
  /** Report functions whose cognitive complexity is above this. */
  minComplexity: number;
}

export default defineAnalyzer<Config>({
  name: "gocognit",
  doc: `computes and checks the cognitive complexity of functions

Branches and loops cost more the deeper they are nested. Sequences of logical
operators, labelled jumps, and recursion add to the cost too. A
//gocognit:ignore comment in a function's doc comment skips it.`,
  config: { minComplexity: 30 },
  runDespiteErrors: true,
  run(pass) {
    for (const file of pass.files) {
      for (const decl of file.decls) {
        if (decl?.$type !== "FuncDecl" || decl.doc?.list.some((comment) => comment!.text === "//gocognit:ignore")) {
          continue;
        }
        const visitor = new Visitor(decl.name!);
        visitor.walk(decl);
        if (visitor.complexity > pass.config.minComplexity) {
          pass.report({
            pos: decl.pos(),
            message: `cognitive complexity ${visitor.complexity} of func \`${funcName(decl)}\` is high (> ${pass.config.minComplexity})`,
          });
        }
      }
    }
  },
});

// Visitor sums a function's cognitive complexity in the order go/ast walks
// it, which decides which logical operators are counted together.
class Visitor {
  complexity = 0;
  private nesting = 0;
  private readonly elseIfs = new Set<ast.IfStmt>();
  // counted holds the binary expressions already counted as part of a
  // sequence of logical operators.
  private readonly counted = new Set<ast.Expr>();

  constructor(private readonly name: ast.Ident) {}

  walk(node: ast.Node | null): void {
    if (node !== null) {
      ast.inspect(node, (n) => this.visit(n));
    }
  }

  // nested walks a body one level deeper.
  private nested(node: ast.Node | null): void {
    this.nesting++;
    this.walk(node);
    this.nesting--;
  }

  // visit counts a node and reports whether to walk its children, which
  // statements walk themselves.
  private visit(node: ast.Node | null): boolean {
    switch (node?.$type) {
      case "IfStmt":
        // An else if costs one, with no nesting.
        this.complexity += this.elseIfs.has(node) ? 1 : this.nesting + 1;
        this.walk(node.init);
        this.walk(node.cond);
        this.nested(node.body);
        if (node.else?.$type === "BlockStmt") {
          // Upstream walks an else block without nesting it further.
          this.complexity++;
          this.walk(node.else);
        } else if (node.else?.$type === "IfStmt") {
          this.elseIfs.add(node.else);
          this.walk(node.else);
        }
        return false;
      case "SwitchStmt":
        this.complexity += this.nesting + 1;
        this.walk(node.init);
        this.walk(node.tag);
        this.nested(node.body);
        return false;
      case "TypeSwitchStmt":
        this.complexity += this.nesting + 1;
        this.walk(node.init);
        this.walk(node.assign);
        this.nested(node.body);
        return false;
      case "SelectStmt":
        this.complexity += this.nesting + 1;
        this.nested(node.body);
        return false;
      case "ForStmt":
        this.complexity += this.nesting + 1;
        this.walk(node.init);
        this.walk(node.cond);
        this.walk(node.post);
        this.nested(node.body);
        return false;
      case "RangeStmt":
        this.complexity += this.nesting + 1;
        this.walk(node.key);
        this.walk(node.value);
        this.walk(node.x);
        this.nested(node.body);
        return false;
      case "FuncLit":
        this.walk(node.type);
        this.nested(node.body);
        return false;
      case "BranchStmt":
        if (node.label !== null) {
          this.complexity++;
        }
        return true;
      case "BinaryExpr":
        if (isLogical(node.op) && !this.counted.has(node)) {
          // Each change of operator in a sequence costs one.
          let last: token.Token | undefined;
          for (const op of this.logicalOps(node)) {
            if (op !== last) {
              this.complexity++;
              last = op;
            }
          }
        }
        return true;
      case "CallExpr":
        // Recursion, by the parser's object resolution, which leaves a
        // method's name and unresolved calls without an object.
        if (node.fun?.$type === "Ident" && node.fun.obj === this.name.obj && node.fun.name === this.name.name) {
          this.complexity++;
        }
        return true;
    }
    return true;
  }

  // logicalOps lists the logical operators of a chain of binary expressions
  // in source order, marking each as counted. Parentheses end a chain.
  private logicalOps(expr: ast.Expr | null): token.Token[] {
    if (expr === null) {
      return [];
    }
    this.counted.add(expr);
    if (expr.$type !== "BinaryExpr") {
      return [];
    }
    return [...this.logicalOps(expr.x), ...(isLogical(expr.op) ? [expr.op] : []), ...this.logicalOps(expr.y)];
  }
}

function isLogical(op: token.Token): boolean {
  return op === token.LAND || op === token.LOR;
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
