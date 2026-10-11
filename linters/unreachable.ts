// Port of golang.org/x/tools/go/analysis/passes/unreachable at v0.50.0.
import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

export default defineAnalyzer({
  name: "unreachable",
  doc: `check for unreachable code

The unreachable analyzer finds statements that execution can never reach
because they are preceded by a return statement, a call to panic, an
infinite loop, or similar constructs.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/unreachable",
  group: "govet",
  requires: [inspect],
  runDespiteErrors: true,
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.FuncDecl, ast.FuncLit)) {
      const body = (cursor.node() as ast.FuncDecl | ast.FuncLit).body;
      if (body === null) {
        continue;
      }
      const d = new DeadState(pass);
      d.findLabels(body);
      d.findDead(body);
    }
  },
});

type BreakTarget = ast.ForStmt | ast.RangeStmt | ast.SelectStmt | ast.SwitchStmt | ast.TypeSwitchStmt;

class DeadState {
  private readonly hasBreak = new Set<ast.Stmt>();
  private readonly hasGoto = new Set<string>();
  private readonly labels = new Map<string, ast.Stmt>();
  private breakTarget: ast.Stmt | null = null;
  private reachable = true;

  constructor(private readonly pass: Pass<unknown>) {}

  // findLabels records the labels stmt defines and uses, and which
  // statements are the targets of a break.
  findLabels(stmt: ast.Stmt): void {
    switch (stmt.$type) {
      case "BlockStmt":
        for (const s of stmt.list) {
          this.findLabels(s!);
        }
        break;
      case "BranchStmt":
        if (stmt.tok === token.GOTO) {
          if (stmt.label !== null) {
            this.hasGoto.add(stmt.label.name);
          }
        } else if (stmt.tok === token.BREAK) {
          const target = stmt.label !== null ? (this.labels.get(stmt.label.name) ?? null) : this.breakTarget;
          if (target !== null) {
            this.hasBreak.add(target);
          }
        }
        break;
      case "IfStmt":
        this.findLabels(stmt.body!);
        if (stmt.else !== null) {
          this.findLabels(stmt.else);
        }
        break;
      case "LabeledStmt":
        this.labels.set(stmt.label!.name, stmt.stmt!);
        this.findLabels(stmt.stmt!);
        break;
      case "ForStmt":
      case "RangeStmt":
      case "SelectStmt":
      case "SwitchStmt":
      case "TypeSwitchStmt":
        this.findBodyLabels(stmt);
        break;
      case "CommClause":
      case "CaseClause":
        for (const s of stmt.body) {
          this.findLabels(s!);
        }
        break;
    }
  }

  private findBodyLabels(stmt: BreakTarget): void {
    const outer = this.breakTarget;
    this.breakTarget = stmt;
    this.findLabels(stmt.body!);
    this.breakTarget = outer;
  }

  // findDead reports stmt if it is unreachable on entry, then records
  // whether the statement following it is reachable.
  findDead(stmt: ast.Stmt): void {
    // A goto target is assumed reachable, without checking the goto is.
    if (stmt.$type === "LabeledStmt" && this.hasGoto.has(stmt.label!.name)) {
      this.reachable = true;
    }
    if (!this.reachable && stmt.$type !== "EmptyStmt") {
      // Upstream's "Remove" fix is dropped: its statement deletion logic is
      // large and only the diagnostic is needed.
      this.pass.report({ pos: stmt.pos(), end: stmt.end(), message: "unreachable code" });
      // Silence the report about the next statement.
      this.reachable = true;
    }

    switch (stmt.$type) {
      case "BlockStmt":
        for (const s of stmt.list) {
          this.findDead(s!);
        }
        break;
      case "BranchStmt":
        // Continue redirects control flow just as the others do.
        if (stmt.tok === token.BREAK || stmt.tok === token.GOTO || stmt.tok === token.FALLTHROUGH || stmt.tok === token.CONTINUE) {
          this.reachable = false;
        }
        break;
      case "ExprStmt": {
        const call = stmt.x;
        if (call?.$type === "CallExpr" && call.fun?.$type === "Ident" && call.fun.name === "panic" && call.fun.obj === null) {
          this.reachable = false;
        }
        break;
      }
      case "ForStmt":
        this.findDead(stmt.body!);
        this.reachable = stmt.cond !== null || this.hasBreak.has(stmt);
        break;
      case "IfStmt":
        this.findDead(stmt.body!);
        if (stmt.else !== null) {
          const r = this.reachable;
          this.reachable = true;
          this.findDead(stmt.else);
          this.reachable = this.reachable || r;
        } else {
          // The if statement might not have run its body.
          this.reachable = true;
        }
        break;
      case "LabeledStmt":
        this.findDead(stmt.stmt!);
        break;
      case "RangeStmt":
        this.findDead(stmt.body!);
        this.reachable = true;
        break;
      case "ReturnStmt":
        this.reachable = false;
        break;
      case "SelectStmt": {
        // A select without a default blocks until a case runs, so unlike a
        // switch, a missing default does not make the end reachable.
        let anyReachable = false;
        for (const comm of stmt.body!.list) {
          this.reachable = true;
          for (const s of (comm as ast.CommClause).body) {
            this.findDead(s!);
          }
          anyReachable ||= this.reachable;
        }
        this.reachable = anyReachable || this.hasBreak.has(stmt);
        break;
      }
      case "SwitchStmt":
      case "TypeSwitchStmt": {
        let anyReachable = false;
        let hasDefault = false;
        for (const cas of stmt.body!.list) {
          const cc = cas as ast.CaseClause;
          if (cc.list.length === 0) {
            hasDefault = true;
          }
          this.reachable = true;
          for (const s of cc.body) {
            this.findDead(s!);
          }
          anyReachable ||= this.reachable;
        }
        this.reachable = anyReachable || this.hasBreak.has(stmt) || !hasDefault;
        break;
      }
    }
  }
}
