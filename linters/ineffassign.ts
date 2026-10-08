import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer } from "tsk";

interface Config {
  /** Also check variables of type error whose address is taken, at the risk of false positives. */
  checkEscapingErrors: boolean;
}

// Block is a basic block of the flow graph, with the uses and assignments of
// each variable in order.
interface Block {
  children: Block[];
  ops: Map<ast.Object, { id: ast.Ident; assign: boolean }[]>;
}

interface Variable {
  // fundept counts the function literals entered since the variable's
  // first use; a variable used in a closure escapes.
  fundept: number;
  escapes: boolean;
}

interface Branch {
  label: ast.Object | null;
  srcs: Block[];
  dst: Block | null;
}

export default defineAnalyzer<Config>({
  name: "ineffassign",
  doc: `detect assignments to existing variables that are never used

Builds a flow graph of each function from its syntax and reports
assignments overwritten or left unread on every path. Variables whose
address is taken, or that are used by closures, are not checked.`,
  url: "https://github.com/gordonklaus/ineffassign",
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: { checkEscapingErrors: false },
  run(pass) {
    for (const file of pass.files) {
      if (ast.isGenerated(file)) {
        continue;
      }
      const builder = new Builder(pass.config.checkEscapingErrors);
      builder.walk(file);
      const ineffectual: ast.Ident[] = [];
      const seen = new Set<Block>();
      for (const root of builder.roots) {
        check(root, builder.vars, seen, ineffectual);
      }
      ineffectual.sort((a, b) => a.pos() - b.pos());
      for (const id of ineffectual) {
        pass.report({ pos: id.pos(), end: id.end(), message: `ineffectual assignment to ${id.name}` });
      }
    }
  },
});

class Builder {
  readonly roots: Block[] = [];
  readonly vars = new Map<ast.Object, Variable>();
  private block: Block | null = null;
  private readonly results: (ast.FieldList | null)[] = [];
  private readonly defers: boolean[] = [];
  private readonly breaks = new BranchStack();
  private readonly continues = new BranchStack();
  private readonly gotos = new BranchStack();
  private labelStmt: ast.LabeledStmt | null = null;

  constructor(private readonly checkEscapingErrors: boolean) {}

  walk(node: ast.Node | null): void {
    if (node !== null) {
      ast.inspect(node, (n) => n !== null && this.visit(n));
    }
  }

  // visit records a node's operations and reports whether to walk its
  // children, as ast.Walk does when a Visitor returns itself.
  private visit(n: ast.Node): boolean {
    switch (n.$type) {
      case "FuncDecl":
        if (n.body !== null) {
          this.fun(n.recv, n.type!, n.body);
        }
        return false;
      case "FuncLit":
        this.fun(null, n.type!, n.body!);
        return false;
      case "IfStmt": {
        this.walk(n.init);
        this.walk(n.cond);
        let b0 = this.block;
        this.newBlock(b0);
        this.walk(n.body);
        const b1 = this.block;
        if (n.else !== null) {
          this.newBlock(b0);
          this.walk(n.else);
          b0 = this.block;
        }
        this.newBlock(b0, b1);
        return false;
      }
      case "ForStmt": {
        const label = this.stmtLabel(n);
        const brk = this.breaks.push(label);
        const cont = this.continues.push(label);
        this.walk(n.init);
        const start = this.newBlock(this.block);
        this.walk(n.cond);
        const cond = this.block;
        this.newBlock(cond);
        this.walk(n.body);
        setDestination(cont, this.newBlock(this.block));
        this.walk(n.post);
        this.block!.children.push(start);
        setDestination(brk, this.newBlock(cond));
        this.breaks.pop();
        this.continues.pop();
        return false;
      }
      case "RangeStmt": {
        const label = this.stmtLabel(n);
        const brk = this.breaks.push(label);
        const cont = this.continues.push(label);
        this.walk(n.x);
        const pre = this.newBlock(this.block);
        const start = this.newBlock(pre);
        if (n.key !== null) {
          // Upstream walks key, value := <value>, whose value is no variable.
          this.assignment(n.value === null ? [n.key] : [n.key, n.value], n.tok, []);
        }
        this.walk(n.body);
        this.block!.children.push(start);
        setDestination(cont, pre);
        setDestination(brk, this.newBlock(pre, this.block));
        this.breaks.pop();
        this.continues.pop();
        return false;
      }
      case "SwitchStmt":
        this.walk(n.init);
        this.walk(n.tag);
        this.switchCases(n, n.body!.list);
        return false;
      case "TypeSwitchStmt":
        this.walk(n.init);
        this.walk(n.assign);
        this.switchCases(n, n.body!.list);
        return false;
      case "SelectStmt": {
        const brk = this.breaks.push(this.stmtLabel(n));
        for (const clause of n.body!.list) {
          const comm = (clause as ast.CommClause).comm;
          this.walk(comm?.$type === "AssignStmt" ? comm.rhs[0] : comm);
        }
        const b0 = this.block;
        const exits: (Block | null)[] = [];
        let hasDefault = false;
        for (const clause of n.body!.list) {
          const commClause = clause as ast.CommClause;
          this.newBlock(b0);
          this.walk(commClause);
          exits.push(this.block);
          hasDefault = hasDefault || commClause.comm === null;
        }
        if (!hasDefault) {
          exits.push(b0);
        }
        setDestination(brk, this.newBlock(...exits));
        this.breaks.pop();
        return false;
      }
      case "DeferStmt":
        this.walk(n.call!.fun);
        for (const arg of n.call!.args) {
          this.walk(arg);
        }
        this.defers[this.defers.length - 1] = true;
        return false;
      case "LabeledStmt":
        setDestination(this.gotos.get(n.label), this.newBlock(this.block));
        this.labelStmt = n;
        this.walk(n.stmt);
        return false;
      case "BranchStmt": {
        const stack = n.tok === token.BREAK ? this.breaks : n.tok === token.CONTINUE ? this.continues : n.tok === token.GOTO ? this.gotos : null;
        if (stack !== null) {
          addSource(stack.get(n.label), this.block!);
          this.newBlock();
        }
        return false;
      }
      case "AssignStmt":
        if (n.tok === token.QUO_ASSIGN || n.tok === token.REM_ASSIGN) {
          this.maybePanic();
        }
        for (const x of n.rhs) {
          this.walk(x);
        }
        this.assignment(n.lhs, n.tok, n.rhs);
        return false;
      case "GenDecl":
        if (n.tok === token.VAR) {
          for (const spec of n.specs) {
            const valueSpec = spec as ast.ValueSpec;
            for (const x of valueSpec.values) {
              this.walk(x);
            }
            for (const id of valueSpec.names) {
              this.newOp(id!, valueSpec.values.length > 0);
            }
          }
        }
        return false;
      case "IncDecStmt": {
        const id = ident(n.x);
        if (id !== null) {
          this.newOp(id, false);
          this.newOp(id, true);
        } else {
          this.walk(n.x);
        }
        return false;
      }
      case "Ident":
        this.newOp(n, false);
        return false;
      case "ReturnStmt": {
        for (const x of n.results) {
          this.walk(x);
        }
        for (const field of this.results[this.results.length - 1]?.list ?? []) {
          for (const id of field!.names) {
            // A return with results assigns the named results first.
            if (n.results.length > 0) {
              this.newOp(id!, true);
            }
            this.newOp(id!, false);
          }
        }
        this.newBlock();
        return false;
      }
      case "BinaryExpr":
        if (n.op === token.EQL || n.op === token.QUO || n.op === token.REM) {
          this.maybePanic();
        }
        return true;
      case "SendStmt":
      case "CallExpr":
      case "IndexExpr":
      case "StarExpr":
      case "TypeAssertExpr":
        this.maybePanic();
        return true;
      case "UnaryExpr": {
        // Without type information, taking the address of any element of
        // an indexed variable counts as taking its address.
        const id = n.x?.$type === "IndexExpr" ? ident(n.x.x) : ident(n.x);
        if (id !== null && n.op === token.AND) {
          this.escape(id);
        }
        return true;
      }
      case "SelectorExpr":
      case "SliceExpr": {
        this.maybePanic();
        // A method call may take its receiver's address, and slicing may
        // alias an array; without types, both count as escaping.
        const id = ident(n.x);
        if (id !== null) {
          this.escape(id);
        }
        return true;
      }
    }
    return true;
  }

  private assignment(lhs: (ast.Expr | null)[], tok: token.Token, rhs: (ast.Expr | null)[]): void {
    lhs.forEach((x, i) => {
      const id = ident(x);
      if (id === null) {
        this.walk(x);
        return;
      }
      if (tok >= token.ADD_ASSIGN && tok <= token.AND_NOT_ASSIGN) {
        this.newOp(id, false);
      }
      // Explicit zero initialization is often shorthand for a declaration.
      const zeroInit = tok === token.DEFINE && i < rhs.length && isZeroInitializer(rhs[i]);
      this.newOp(id, !zeroInit);
    });
  }

  private escape(id: ast.Ident): void {
    if (this.checkEscapingErrors) {
      const decl = id.obj?.decl as ast.Node | null | undefined;
      if (decl?.$type === "ValueSpec" && decl.type?.$type === "Ident" && decl.type.name === "error") {
        return;
      }
    }
    const v = id.obj === null ? undefined : this.vars.get(id.obj);
    if (v !== undefined) {
      v.escapes = true;
    }
  }

  private fun(recv: ast.FieldList | null, type: ast.FuncType, body: ast.BlockStmt): void {
    for (const v of this.vars.values()) {
      v.fundept++;
    }
    this.results.push(type.results);
    this.defers.push(false);
    const saved = this.block;
    this.newBlock();
    this.roots.push(this.block!);
    this.walk(recv);
    this.walk(type);
    this.walk(body);
    this.block = saved;
    this.results.pop();
    this.defers.pop();
    for (const v of this.vars.values()) {
      v.fundept--;
    }
  }

  private switchCases(stmt: ast.Stmt, cases: (ast.Stmt | null)[]): void {
    const brk = this.breaks.push(this.stmtLabel(stmt));
    const b0 = this.block;
    let list = b0;
    const exits: (Block | null)[] = [];
    let defaultBlock: Block | null = null;
    let fallthrough: Block | null = null;
    for (const c of cases) {
      const clause = c as ast.CaseClause;
      const isDefault = clause.list.length === 0;
      if (!isDefault) {
        list = this.newBlock(list);
        for (const x of clause.list) {
          this.walk(x);
        }
      }
      const parents: (Block | null)[] = [];
      if (!isDefault) {
        parents.push(list);
      }
      if (fallthrough !== null) {
        parents.push(fallthrough);
        fallthrough = null;
      }
      this.newBlock(...parents);
      if (isDefault) {
        defaultBlock = this.block;
      }
      for (const s of clause.body) {
        this.walk(s);
        if (s?.$type === "BranchStmt" && s.tok === token.FALLTHROUGH) {
          fallthrough = this.block;
        }
      }
      if (fallthrough === null) {
        exits.push(this.block);
      }
    }
    if (defaultBlock !== null) {
      list!.children.push(defaultBlock);
    } else {
      exits.push(b0);
    }
    setDestination(brk, this.newBlock(...exits));
    this.breaks.pop();
  }

  // maybePanic marks named results used when a deferred call could recover
  // a panic and read them.
  private maybePanic(): void {
    if (this.defers.length === 0 || !this.defers[this.defers.length - 1]) {
      return;
    }
    for (const field of this.results[this.results.length - 1]?.list ?? []) {
      for (const id of field!.names) {
        this.newOp(id!, false);
      }
    }
  }

  private newBlock(...parents: (Block | null)[]): Block {
    this.block = { children: [], ops: new Map() };
    for (const parent of parents) {
      parent?.children.push(this.block);
    }
    return this.block;
  }

  private stmtLabel(stmt: ast.Stmt): ast.Object | null {
    return this.labelStmt !== null && this.labelStmt.stmt === stmt ? this.labelStmt.label!.obj : null;
  }

  private newOp(id: ast.Ident, assign: boolean): void {
    if (id.name === "_" || id.obj === null) {
      return;
    }
    let v = this.vars.get(id.obj);
    if (v === undefined) {
      v = { fundept: 0, escapes: false };
      this.vars.set(id.obj, v);
    }
    v.escapes = v.escapes || v.fundept > 0 || this.block === null;
    if (this.block !== null && !v.escapes) {
      const ops = this.block.ops.get(id.obj) ?? [];
      ops.push({ id, assign });
      this.block.ops.set(id.obj, ops);
    }
  }
}

class BranchStack {
  private readonly branches: Branch[] = [];

  push(label: ast.Object | null): Branch {
    const branch: Branch = { label, srcs: [], dst: null };
    this.branches.push(branch);
    return branch;
  }

  get(label: ast.Ident | null): Branch {
    for (let i = this.branches.length - 1; i >= 0; i--) {
      if (label === null || this.branches[i].label === label.obj) {
        return this.branches[i];
      }
    }
    // Invalid code, such as break outside a loop, gets a detached branch.
    return label === null ? { label: null, srcs: [], dst: null } : this.push(label.obj);
  }

  pop(): void {
    this.branches.pop();
  }
}

function addSource(branch: Branch, src: Block): void {
  branch.srcs.push(src);
  if (branch.dst !== null) {
    src.children.push(branch.dst);
  }
}

function setDestination(branch: Branch, dst: Block): void {
  branch.dst = dst;
  for (const src of branch.srcs) {
    src.children.push(dst);
  }
}

function ident(x: ast.Expr | null): ast.Ident | null {
  if (x?.$type === "ParenExpr") {
    return ident(x.x);
  }
  return x?.$type === "Ident" ? x : null;
}

function isZeroInitializer(x: ast.Expr | null): boolean {
  // A call of one argument is assumed to be a conversion.
  if (x?.$type === "CallExpr") {
    let fun = x.fun;
    if (fun?.$type === "ParenExpr") {
      fun = fun.x;
    }
    if (fun?.$type === "StarExpr") {
      fun = fun.x;
    }
    const conversion = ["Ident", "SelectorExpr", "ArrayType", "StructType", "FuncType", "InterfaceType", "MapType", "ChanType"];
    if (fun === null || !conversion.includes(fun.$type) || x.args.length !== 1) {
      return false;
    }
    x = x.args[0];
  }
  if (x?.$type === "BasicLit") {
    return ["0", "0.0", "0.", ".0", '""'].includes(x.value);
  }
  return x?.$type === "Ident" && (x.name === "false" || x.name === "nil") && x.obj === null;
}

function check(b: Block, vars: Map<ast.Object, Variable>, seen: Set<Block>, ineffectual: ast.Ident[]): void {
  if (seen.has(b)) {
    return;
  }
  seen.add(b);
  for (const [obj, ops] of b.ops) {
    ops.forEach((op, i) => {
      if (!op.assign) {
        return;
      }
      if (i + 1 < ops.length) {
        if (ops[i + 1].assign) {
          ineffectual.push(op.id);
        }
        return;
      }
      const visited = new Set<Block>();
      if (b.children.some((child) => used(obj, child, visited))) {
        return;
      }
      if (!vars.get(obj)!.escapes) {
        ineffectual.push(op.id);
      }
    });
  }
  for (const child of b.children) {
    check(child, vars, seen, ineffectual);
  }
}

function used(obj: ast.Object, b: Block, seen: Set<Block>): boolean {
  if (seen.has(b)) {
    return false;
  }
  seen.add(b);
  const ops = b.ops.get(obj);
  if (ops !== undefined && ops.length > 0) {
    return !ops[0].assign;
  }
  return b.children.some((child) => used(obj, child, seen));
}
