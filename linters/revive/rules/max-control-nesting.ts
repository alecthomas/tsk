import type * as ast from "go/ast";
import { type Visitor, walk } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "max-control-nesting";

export interface Options {
  /** The deepest control structures may nest. */
  max: number;
}

export const defaults: Options = { max: 5 };

export function create(options: DeepReadonly<Options>): Rule {
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      walk(new NestingVisitor(options.max, failures), file.ast);
      return failures;
    },
  };
}

// Only if, for, and case clauses nest, as in revive; range statements do not.
class NestingVisitor implements Visitor {
  private nesting = 0;
  private lastCtrlStmt: ast.Node | null = null;

  constructor(
    private readonly max: number,
    private readonly failures: Failure[],
  ) {}

  visit(n: ast.Node | null): Visitor | null {
    if (this.nesting > this.max) {
      // Revive reports a nil node if max is negative; this reports n instead.
      const node = this.lastCtrlStmt ?? n!;
      this.failures.push({ failure: `control flow nesting exceeds ${this.max}`, node, confidence: 1 });
      return null;
    }
    switch (n?.$type) {
      case "IfStmt": {
        const stmt = n as ast.IfStmt;
        this.lastCtrlStmt = stmt;
        this.walkControlled(stmt.body!);
        if (stmt.else !== null) {
          this.walkControlled(stmt.else);
        }
        return null;
      }
      case "ForStmt":
        this.lastCtrlStmt = n;
        this.walkControlled((n as ast.ForStmt).body!);
        return null;
      case "CaseClause":
      case "CommClause":
        this.lastCtrlStmt = n;
        for (const s of (n as ast.CaseClause | ast.CommClause).body) {
          this.walkControlled(s!);
        }
        return null;
      case "FuncLit":
        walk(new NestingVisitor(this.max, this.failures), (n as ast.FuncLit).body!);
        return null;
    }
    return this;
  }

  private walkControlled(node: ast.Node): void {
    const old = this.nesting;
    this.nesting++;
    walk(this, node);
    this.nesting = old;
  }
}
