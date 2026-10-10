// Ports revive's internal/ifelse package, shared by the early-return,
// indent-error-flow, and superfluous-else rules.

import type * as ast from "go/ast";
import * as token from "go/token";
import { type Visitor, walk } from "./astutils";
import type { Failure } from "./lint";

/** Classifies how an if-else branch ends. */
export enum BranchKind {
  Empty,
  Return,
  Continue,
  Break,
  Goto,
  Panic,
  Exit,
  Regular,
}

/** Reports whether control does not flow to the statement after the chain. */
export function deviates(kind: BranchKind): boolean {
  return kind !== BranchKind.Empty && kind !== BranchKind.Regular;
}

const kindStrings: Record<BranchKind, string> = {
  [BranchKind.Empty]: "",
  [BranchKind.Regular]: "",
  [BranchKind.Return]: "return",
  [BranchKind.Continue]: "continue",
  [BranchKind.Break]: "break",
  [BranchKind.Goto]: "goto",
  [BranchKind.Panic]: "panic()",
  [BranchKind.Exit]: "os.Exit()",
};

/** A brief form of kind, as BranchKind.String. */
export function kindString(kind: BranchKind): string {
  return kindStrings[kind];
}

const kindLongStrings: Record<BranchKind, string> = {
  [BranchKind.Empty]: "an empty block",
  [BranchKind.Regular]: "a regular statement",
  [BranchKind.Return]: "a return statement",
  [BranchKind.Continue]: "a continue statement",
  [BranchKind.Break]: "a break statement",
  [BranchKind.Goto]: "a goto statement",
  [BranchKind.Panic]: "a function call that panics",
  [BranchKind.Exit]: "a function call that exits the program",
};

/** The function called at the end of a Panic or Exit branch. */
export interface Call {
  readonly pkg: string;
  readonly name: string;
}

function callString(call: Call): string {
  return call.pkg === "" ? call.name : `${call.pkg}.${call.name}`;
}

const deviatingFuncs = new Map<string, BranchKind>([
  ["os.Exit", BranchKind.Exit],
  ["log.Fatal", BranchKind.Exit],
  ["log.Fatalf", BranchKind.Exit],
  ["log.Fatalln", BranchKind.Exit],
  ["panic", BranchKind.Panic],
  ["log.Panic", BranchKind.Panic],
  ["log.Panicf", BranchKind.Panic],
  ["log.Panicln", BranchKind.Panic],
]);

function exprCall(stmt: ast.ExprStmt): Call | undefined {
  const x = stmt.x;
  if (x === null || x.$type !== "CallExpr") {
    return undefined;
  }
  const fun = (x as ast.CallExpr).fun!;
  if (fun.$type === "Ident") {
    return { pkg: "", name: (fun as ast.Ident).name };
  }
  if (fun.$type === "SelectorExpr") {
    const sel = fun as ast.SelectorExpr;
    if (sel.x!.$type === "Ident") {
      return { pkg: (sel.x as ast.Ident).name, name: sel.sel!.name };
    }
  }
  return undefined;
}

/** What happens at the end of a branch of an if-else chain. */
export class Branch {
  constructor(
    readonly kind: BranchKind,
    readonly call: Call = { pkg: "", name: "" },
    readonly block: readonly (ast.Stmt | null)[] = [],
  ) {}

  isEmpty(): boolean {
    return this.kind === BranchKind.Empty;
  }

  returns(): boolean {
    return this.kind === BranchKind.Return;
  }

  deviates(): boolean {
    return deviates(this.kind);
  }

  /** A brief form, such as "{ ... return }". */
  toString(): string {
    switch (this.kind) {
      case BranchKind.Empty:
        return "{ }";
      case BranchKind.Regular:
        return "{ ... }";
      case BranchKind.Panic:
      case BranchKind.Exit:
        return `{ ... ${callString(this.call)}() }`;
      default:
        return `{ ... ${kindString(this.kind)} }`;
    }
  }

  longString(): string {
    if (this.kind === BranchKind.Panic || this.kind === BranchKind.Exit) {
      return `call to ${callString(this.call)} function`;
    }
    return kindLongStrings[this.kind];
  }

  /** Reports whether the branch has any top-level declarations. */
  hasDecls(): boolean {
    return this.block.some(
      (stmt) => stmt!.$type === "DeclStmt" || (stmt!.$type === "AssignStmt" && (stmt as ast.AssignStmt).tok === token.DEFINE),
    );
  }

  /** Reports whether the branch is empty or consists of a single statement. */
  isShort(): boolean {
    switch (this.block.length) {
      case 0:
        return true;
      case 1:
        return isShortStmt(this.block[0]!);
      case 2:
        return isShortStmt(this.block[1]!);
    }
    return false;
  }
}

const longStmts = new Set(["BlockStmt", "IfStmt", "SwitchStmt", "TypeSwitchStmt", "SelectStmt", "ForStmt", "RangeStmt"]);

function isShortStmt(stmt: ast.Stmt): boolean {
  return !longStmts.has(stmt.$type);
}

/** The Branch of a block. */
export function blockBranch(block: ast.BlockStmt): Branch {
  if (block.list.length === 0) {
    return new Branch(BranchKind.Empty);
  }
  const branch = stmtBranch(block.list[block.list.length - 1]!);
  return new Branch(branch.kind, branch.call, block.list);
}

/** The Branch of a statement. */
export function stmtBranch(stmt: ast.Stmt): Branch {
  switch (stmt.$type) {
    case "ReturnStmt":
      return new Branch(BranchKind.Return);
    case "BlockStmt":
      return blockBranch(stmt as ast.BlockStmt);
    case "BranchStmt":
      switch ((stmt as ast.BranchStmt).tok) {
        case token.BREAK:
          return new Branch(BranchKind.Break);
        case token.CONTINUE:
          return new Branch(BranchKind.Continue);
        case token.GOTO:
          return new Branch(BranchKind.Goto);
      }
      break;
    case "ExprStmt": {
      const call = exprCall(stmt as ast.ExprStmt);
      const kind = call === undefined ? undefined : deviatingFuncs.get(callString(call));
      if (kind !== undefined) {
        return new Branch(kind, call);
      }
      break;
    }
    case "EmptyStmt":
      return new Branch(BranchKind.Empty);
    case "LabeledStmt":
      return stmtBranch((stmt as ast.LabeledStmt).stmt!);
  }
  return new Branch(BranchKind.Regular);
}

/** Information about an if-else chain. */
export interface Chain {
  /** What happens at the end of the "if" block. */
  if: Branch;
  hasElse: boolean;
  /** What happens at the end of the "else" block. */
  else: Branch;
  /** Whether there is an if-initializer somewhere in the chain. */
  hasInitializer: boolean;
  /** Whether a prior "if" block does not deviate control flow. */
  hasPriorNonDeviating: boolean;
  /** Whether the chain is the last statement of the surrounding block. */
  atBlockEnd: boolean;
  /** Control flow at the end of the surrounding block. */
  blockEndKind: BranchKind;
}

/** Returns the proposed refactor's message, or undefined if there is none. */
export type CheckFunc = (chain: Chain) => string | undefined;

/** Which node a failure points at. */
export enum Target {
  If,
  Else,
}

/**
 * Evaluates check on the if-else chains in node. Only the last "if" of each
 * chain is checked, as upstream's rules have nothing to say about the others.
 */
export function apply(check: CheckFunc, node: ast.Node, target: Target, allowJump: boolean): Failure[] {
  const failures: Failure[] = [];

  const visitor: Visitor = {
    visit(n) {
      if (n === null) {
        return null;
      }
      switch (n.$type) {
        case "FuncDecl":
          visitBody((n as ast.FuncDecl).body, BranchKind.Return);
          return null;
        case "FuncLit":
          visitBody((n as ast.FuncLit).body, BranchKind.Return);
          return null;
        case "ForStmt":
          visitBody((n as ast.ForStmt).body, BranchKind.Continue);
          return null;
        case "RangeStmt":
          visitBody((n as ast.RangeStmt).body, BranchKind.Continue);
          return null;
        case "CaseClause":
          visitBlock((n as ast.CaseClause).body, BranchKind.Break);
          return null;
        case "BlockStmt":
          visitBlock((n as ast.BlockStmt).list, BranchKind.Regular);
          return null;
      }
      return visitor;
    },
  };

  const visitBody = (body: ast.BlockStmt | null, endKind: BranchKind) => {
    if (body !== null) {
      visitBlock(body.list, endKind);
    }
  };

  const visitBlock = (stmts: readonly (ast.Stmt | null)[], endKind: BranchKind) => {
    stmts.forEach((stmt, i) => {
      if (stmt!.$type !== "IfStmt") {
        walk(visitor, stmt!);
        return;
      }
      const atBlockEnd = i === stmts.length - 1;
      visitIf(stmt as ast.IfStmt, {
        if: new Branch(BranchKind.Empty),
        hasElse: false,
        else: new Branch(BranchKind.Empty),
        hasInitializer: false,
        hasPriorNonDeviating: false,
        atBlockEnd,
        blockEndKind: atBlockEnd ? endKind : BranchKind.Empty,
      });
    });
  };

  const visitIf = (ifStmt: ast.IfStmt, outer: Chain) => {
    const chain = { ...outer };
    // Look for other if-else chains nested inside this if block.
    visitBlock(ifStmt.body!.list, chain.blockEndKind);
    const init = ifStmt.init;
    if (init !== null && init.$type === "AssignStmt" && (init as ast.AssignStmt).tok === token.DEFINE) {
      chain.hasInitializer = true;
    }
    chain.if = blockBranch(ifStmt.body!);
    const els = ifStmt.else;
    if (els === null) {
      if (allowJump) {
        checkRule(ifStmt, chain);
      }
      return;
    }
    if (els.$type === "IfStmt") {
      if (!chain.if.deviates()) {
        chain.hasPriorNonDeviating = true;
      }
      visitIf(els as ast.IfStmt, chain);
      return;
    }
    const elseBlock = els as ast.BlockStmt;
    visitBlock(elseBlock.list, chain.blockEndKind);
    chain.hasElse = true;
    chain.else = blockBranch(elseBlock);
    checkRule(ifStmt, chain);
  };

  const checkRule = (ifStmt: ast.IfStmt, chain: Chain) => {
    let msg = check(chain);
    if (msg === undefined) {
      return;
    }
    if (chain.hasInitializer) {
      // The body may reference the := initializer, which would have to move.
      msg += " (move short variable declaration to its own line if necessary)";
    }
    failures.push({ failure: msg, confidence: 1, node: target === Target.If ? ifStmt : ifStmt.else! });
  };

  walk(visitor, node);
  return failures;
}
