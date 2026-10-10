import * as ast from "go/ast";
import * as token from "go/token";
import { type Visitor, walk } from "../astutils";
import { funcName } from "../funcname";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "cognitive-complexity";

export interface Options {
  /** The highest cognitive complexity a function may have. */
  max: number;
}

export const defaults: Options = { max: 7 };

export function create(options: DeepReadonly<Options>): Rule {
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      for (const decl of file.ast.decls) {
        if (decl!.$type !== "FuncDecl" || (decl as ast.FuncDecl).body === null) {
          continue;
        }
        const fn = decl as ast.FuncDecl;
        const v = new ComplexityVisitor(fn.name!);
        walk(v, fn.body!);
        if (v.complexity > options.max) {
          failures.push({ failure: `function ${funcName(fn)} has cognitive complexity ${v.complexity} (> max enabled ${options.max})`, node: fn, confidence: 1 });
        }
      }
      return failures;
    },
  };
}

class ComplexityVisitor implements Visitor {
  complexity = 0;
  private nestingLevel = 0;

  constructor(private readonly name: ast.Ident) {}

  visit(n: ast.Node | null): Visitor | null {
    if (n === null) {
      return this;
    }
    switch (n.$type) {
      case "IfStmt":
        this.walkIfElse(n as ast.IfStmt);
        return null;
      case "ForStmt": {
        const stmt = n as ast.ForStmt;
        this.walk(1, stmt.cond, stmt.body);
        return null;
      }
      case "RangeStmt":
        this.walk(1, (n as ast.RangeStmt).body);
        return null;
      case "SelectStmt":
        this.walk(1, (n as ast.SelectStmt).body);
        return null;
      case "SwitchStmt":
        this.walk(1, (n as ast.SwitchStmt).body);
        return null;
      case "TypeSwitchStmt":
        this.walk(1, (n as ast.TypeSwitchStmt).body);
        return null;
      case "FuncLit":
        // Only nests, though the nesting level still adds to the complexity.
        this.walk(0, (n as ast.FuncLit).body);
        return null;
      case "BinaryExpr":
        this.complexity += binExprComplexity(n as ast.BinaryExpr);
        return null;
      case "BranchStmt":
        if ((n as ast.BranchStmt).label !== null) {
          this.complexity++;
        }
        break;
      case "CallExpr": {
        // Direct recursion, by the parser's object resolution.
        const fun = (n as ast.CallExpr).fun;
        if (fun !== null && fun.$type === "Ident" && (fun as ast.Ident).obj === this.name.obj && (fun as ast.Ident).name === this.name.name) {
          this.complexity++;
          return null;
        }
        break;
      }
    }
    return this;
  }

  private walk(increment: number, ...targets: (ast.Node | null)[]): void {
    this.complexity += increment + this.nestingLevel;
    const nesting = this.nestingLevel;
    this.nestingLevel++;
    for (const t of targets) {
      if (t !== null) {
        walk(this, t);
      }
    }
    this.nestingLevel = nesting;
  }

  // Only the first if of an if-else-if chain adds the nesting level.
  private walkIfElse(n: ast.IfStmt): void {
    const w = (n: ast.IfStmt): void => {
      walk(this, n.cond!);
      walk(this, n.body!);
      if (n.else !== null) {
        if (n.else.$type === "IfStmt") {
          this.complexity++;
          w(n.else as ast.IfStmt);
        } else {
          walk(this, n.else);
        }
      }
    };
    this.complexity += 1 + this.nestingLevel;
    this.nestingLevel++;
    w(n);
    this.nestingLevel--;
  }
}

// Each sequence of like boolean operators costs one, and so does the first
// operator inside parentheses.
function binExprComplexity(n: ast.BinaryExpr): number {
  let complexity = 0;
  const ops: token.Token[] = [];
  let subexpStarted = false;
  const stack: ast.Node[] = [];
  ast.inspect(n, (node) => {
    if (node === null) {
      const done = stack.pop()!;
      if (done.$type === "BinaryExpr" && isBoolOp((done as ast.BinaryExpr).op)) {
        ops.pop();
      } else if (done.$type === "ParenExpr") {
        subexpStarted = false;
      }
      return true;
    }
    stack.push(node);
    if (node.$type === "BinaryExpr") {
      const op = (node as ast.BinaryExpr).op;
      if (isBoolOp(op)) {
        if (ops.length === 0 || subexpStarted || op !== ops[ops.length - 1]) {
          complexity++;
          subexpStarted = false;
        }
        ops.push(op);
      }
    } else if (node.$type === "ParenExpr") {
      subexpStarted = true;
    }
    return true;
  });
  return complexity;
}

function isBoolOp(op: token.Token): boolean {
  return op === token.LAND || op === token.LOR;
}
