import * as ast from "go/ast";
import * as types from "go/types";
import type * as ctrlflowPass from "golang.org/x/tools/go/analysis/passes/ctrlflow";
import * as cfg from "golang.org/x/tools/go/cfg";
import { defineAnalyzer, type Pass } from "tsk";
import { ctrlflow, inspect } from "tsk/passes";

interface Config {
  /** Checks to run: "end", "set-status", and "record-error". */
  checks: string[];
  /** Patterns for functions whose call counts as handling an error. */
  ignoreCheckSignatures: string[];
  /** Extra span starters, as "regex:opentelemetry" or "regex:opencensus". */
  extraStartSpanSignatures: string[];
}

type SpanType = "opentelemetry" | "opencensus";

interface Matcher {
  signature: RegExp;
  spanType: SpanType;
}

interface SpanVar {
  stmt: ast.Node;
  id: ast.Ident;
  name: string;
  spanType: SpanType;
}

const defaultStartSpanSignatures = [
  "\\(go.opentelemetry.io/otel/trace.Tracer\\).Start:opentelemetry",
  "go.opencensus.io/trace.StartSpan:opencensus",
  "go.opencensus.io/trace.StartSpanWithRemoteParent:opencensus",
];

// nestedBlockKinds are the CFG blocks searched for paths to a return.
const nestedBlockKinds = new Set([
  cfg.KindBody,
  cfg.KindForBody,
  cfg.KindForLoop,
  cfg.KindIfElse,
  cfg.KindIfThen,
  cfg.KindLabel,
  cfg.KindRangeBody,
  cfg.KindRangeLoop,
  cfg.KindSelectCaseBody,
  cfg.KindSelectAfterCase,
  cfg.KindSwitchCaseBody,
  cfg.KindSwitchNextCase,
]);

export default defineAnalyzer<Config>({
  name: "spancheck",
  doc: "Checks for mistakes with OpenTelemetry/Census spans.",
  url: "https://github.com/jjti/go-spancheck",
  requires: [ctrlflow, inspect],
  config: { checks: ["end"], ignoreCheckSignatures: [], extraStartSpanSignatures: [] },
  run(pass) {
    const checker = new Checker(pass);
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.FuncLit, ast.FuncDecl)) {
      checker.checkFunc(cursor.node() as ast.FuncLit | ast.FuncDecl);
    }
  },
});

class Checker {
  private readonly matchers: Matcher[] = [];
  // customStarters matches functions configured as span starters, whose own
  // spans are their callers' to end.
  private readonly customStarters: RegExp | null;
  private readonly ignore: RegExp | null;
  private readonly checks: Set<string>;
  private readonly cfgs: ctrlflowPass.CFGs;
  private readonly errorType = types.Universe!.lookup("error")!.type()!.underlying() as types.Interface;

  constructor(private readonly pass: Pass<Config>) {
    const c = pass.config;
    const custom: string[] = [];
    [...defaultStartSpanSignatures, ...c.extraStartSpanSignatures].forEach((signature, i) => {
      const parts = signature.split(":");
      if (parts.length !== 2 || parts[0] === "" || (parts[1] !== "opentelemetry" && parts[1] !== "opencensus")) {
        return;
      }
      this.matchers.push({ signature: new RegExp(parts[0]), spanType: parts[1] });
      if (i >= defaultStartSpanSignatures.length) {
        custom.push(parts[0]);
      }
    });
    this.customStarters = custom.length > 0 ? new RegExp(`(${custom.join("|")})`) : null;
    const ignore = c.ignoreCheckSignatures;
    this.ignore = ignore.length === 0 || (ignore.length === 1 && ignore[0] === "") ? null : new RegExp(`(${ignore.join("|")})`);
    this.checks = new Set((c.checks.length > 0 ? c.checks : ["end"]).map((check) => check.trim()));
    this.cfgs = pass.resultOf(ctrlflow);
  }

  checkFunc(node: ast.FuncLit | ast.FuncDecl): void {
    const info = this.pass.typesInfo;
    const scope = info.scopes.get(node.type!) ?? null;
    if (node.$type === "FuncDecl" && this.customStarters?.test(this.signature(node.name!))) {
      return;
    }
    const spanVars = this.findSpanVars(node, scope);
    if (spanVars.length === 0) {
      return;
    }
    const sig = node.$type === "FuncDecl" ? info.defs.get(node.name!)?.type() : info.types.get(node.type!)?.type;
    const graph = node.$type === "FuncDecl" ? this.cfgs.funcDecl(node) : this.cfgs.funcLit(node);
    if (sig?.$type !== "Signature" || graph === null) {
      return;
    }
    const errorReturn = (ret: ast.ReturnStmt | null) => this.errorReturn(ret);
    for (const sv of spanVars) {
      const missing = [
        { check: "end", sel: "End", checkErr: (ret: ast.ReturnStmt | null) => ret, ignore: null, suffix: ", possible memory leak" },
        { check: "set-status", sel: "SetStatus", checkErr: errorReturn, ignore: this.ignore, suffix: "" },
        { check: "record-error", sel: "RecordError", checkErr: errorReturn, ignore: this.ignore, suffix: "" },
      ];
      for (const { check, sel, checkErr, ignore, suffix } of missing) {
        // RecordError only exists in OpenTelemetry.
        if (!this.checks.has(check) || (check === "record-error" && sv.spanType !== "opentelemetry")) {
          continue;
        }
        const ret = this.missingSpanCall(graph, sv, sel, checkErr, ignore);
        if (ret !== null) {
          this.reportRange(sv.stmt, `${sv.name}.${sel} is not called on all paths${suffix}`);
          this.reportRange(ret, `return can be reached without calling ${sv.name}.${sel}`);
        }
      }
    }
  }

  // findSpanVars finds the spans a function starts, outside nested function
  // literals, reporting any that are discarded.
  private findSpanVars(node: ast.Node, scope: types.Scope | null): SpanVar[] {
    const info = this.pass.typesInfo;
    const spanVars: SpanVar[] = [];
    const stack: ast.Node[] = [];
    ast.inspect(node, (n) => {
      if (n === null) {
        stack.pop();
        return true;
      }
      if (n.$type === "FuncLit" && stack.length > 0) {
        return false;
      }
      stack.push(n);
      const spanType = this.spanStart(n);
      if (spanType === null || stack[stack.length - 2]?.$type !== "CallExpr") {
        return true;
      }
      const stmt = stack[stack.length - 3];
      const id = stmt === undefined ? null : spanID(stmt);
      if (id === null) {
        this.reportRange(n, "span is unassigned, probable memory leak");
        return true;
      }
      if (id.name === "_") {
        this.reportRange(id, "span is unassigned, probable memory leak");
        return true;
      }
      const used = info.uses.get(id);
      if (used !== undefined) {
        // Spans declared outside the function are not checked.
        if (used?.$type === "Var" && scope?.contains(used.pos())) {
          spanVars.push({ stmt: stmt!, id, name: used.name(), spanType });
        }
        return true;
      }
      const defined = info.defs.get(id);
      if (defined?.$type === "Var") {
        spanVars.push({ stmt: stmt!, id, name: defined.name(), spanType });
      }
      return true;
    });
    return spanVars;
  }

  private spanStart(node: ast.Node): SpanType | null {
    if (node.$type !== "SelectorExpr") {
      return null;
    }
    const signature = this.signature(node.sel!);
    return this.matchers.find((m) => m.signature.test(signature))?.spanType ?? null;
  }

  private signature(ident: ast.Ident): string {
    return this.pass.typesInfo.objectOf(ident)?.string() ?? "";
  }

  // missingSpanCall finds a path from the span's statement to a return that
  // does not call sel on the span.
  private missingSpanCall(
    graph: cfg.CFG,
    sv: SpanVar,
    sel: string,
    checkErr: (ret: ast.ReturnStmt | null) => ast.ReturnStmt | null,
    ignore: RegExp | null,
  ): ast.ReturnStmt | null {
    let defBlock: cfg.Block | null = null;
    let rest: ast.Node[] = [];
    for (const block of graph.blocks) {
      const i = block!.nodes.indexOf(sv.stmt);
      if (i >= 0) {
        defBlock = block;
        rest = block!.nodes.slice(i + 1) as ast.Node[];
        break;
      }
    }
    if (defBlock === null || this.usesCall(rest, sv, sel, ignore, 0)) {
      return null;
    }
    const defReturn = defBlock.return();
    if (defReturn !== null) {
      return checkErr(defReturn);
    }
    const memo = new Map<cfg.Block, boolean>();
    const blockUses = (block: cfg.Block) => {
      let uses = memo.get(block);
      if (uses === undefined) {
        uses = this.usesCall(block.nodes as ast.Node[], sv, sel, ignore, 0);
        memo.set(block, uses);
      }
      return uses;
    };
    const seen = new Set<cfg.Block>();
    // Upstream only reports paths that return an error, whatever the check.
    const search = (blocks: cfg.Block[]): ast.ReturnStmt | null => {
      for (const block of blocks) {
        if (seen.has(block)) {
          continue;
        }
        seen.add(block);
        if (!nestedBlockKinds.has(block.kind) || blockUses(block)) {
          continue;
        }
        const ret = this.errorReturn(block.return()) ?? this.errorReturn(search(block.succs as cfg.Block[]));
        if (ret !== null) {
          return ret;
        }
      }
      return null;
    };
    return search(defBlock.succs as cfg.Block[]);
  }

  // usesCall reports whether statements call sel on the span, following
  // function literals two levels deep. It follows upstream's traversal
  // closely, since its result depends on visiting order.
  private usesCall(stmts: ast.Node[], sv: SpanVar, sel: string, ignore: RegExp | null, depth: number): boolean {
    if (depth > 1) {
      return false;
    }
    const declOf = (id: ast.Ident) => id.obj?.decl;
    const svDecl = declOf(sv.id);
    let found = false;
    let reassigned = false;
    for (const stmt of stmts) {
      const stack: ast.Node[] = [];
      ast.inspect(stmt, (n) => {
        if (n === null) {
          if (stack.length > 0) {
            stack.pop();
            return true;
          }
          return false;
        }
        if (n.$type === "FuncLit" && stack.length > 0) {
          const g = this.cfgs.funcLit(n);
          return g !== null && g.blocks.length > 0 ? this.usesCall(g.blocks[0]!.nodes as ast.Node[], sv, sel, ignore, depth + 1) : false;
        }
        if (n.$type === "CallExpr" && n.fun?.$type === "Ident" && ignore?.test(this.signature(n.fun))) {
          found = true;
          return false;
        }
        if (n.$type === "DeferStmt" && n.call?.fun?.$type === "FuncLit") {
          const g = this.cfgs.funcLit(n.call.fun);
          if (g !== null && g.blocks.length > 0) {
            if (sel === "End") {
              // Every returning block of the deferred function must end the span.
              if (g.blocks.some((b) => b!.return() !== null && !this.usesCall(b!.nodes as ast.Node[], sv, sel, ignore, depth + 1))) {
                return false;
              }
              found = true;
              return false;
            }
            if (g.blocks.some((b) => this.usesCall(b!.nodes as ast.Node[], sv, sel, ignore, depth + 1))) {
              found = true;
              return false;
            }
          }
        }
        stack.push(n);
        // A new span assigned over the old one ends this search.
        if (this.spanStart(n) !== null && stack.length >= 3) {
          const id = spanID(stack[stack.length - 3]);
          if (id !== null && id.obj !== null && declOf(id) === svDecl) {
            reassigned = true;
            return false;
          }
        }
        if (n.$type === "SelectorExpr") {
          if (n.sel!.name === sel) {
            const x = n.x;
            found = x?.$type === "Ident" && x.obj !== null && declOf(x) === svDecl;
          }
          if (ignore?.test(this.signature(n.sel!))) {
            found = true;
          }
        }
        return !found;
      });
    }
    return found && !reassigned;
  }

  // errorReturn returns a return statement if it returns an error.
  private errorReturn(ret: ast.ReturnStmt | null): ast.ReturnStmt | null {
    if (ret === null) {
      return null;
    }
    const info = this.pass.typesInfo;
    const isError = (t: types.Type | null) => types.implements_(t, this.errorType);
    for (const result of ret.results) {
      if (isError(info.typeOf(result!))) {
        return ret;
      }
      if (result?.$type === "CallExpr") {
        const t = info.types.get(result)?.type ?? null;
        if (t?.$type === "Named" || t?.$type === "Pointer") {
          if (isError(t)) {
            return ret;
          }
        } else if (t?.$type === "Tuple") {
          for (let i = 0; i < t.len(); i++) {
            const et = t.at(i)!.type();
            if ((et?.$type === "Named" || et?.$type === "Pointer") && isError(et)) {
              return ret;
            }
          }
        }
      }
    }
    return null;
  }

  private reportRange(node: ast.Node, message: string): void {
    this.pass.report({ pos: node.pos(), end: node.end(), message });
  }
}

// spanID returns the variable a span start is assigned to: the second name,
// after the context, or the only one.
function spanID(stmt: ast.Node): ast.Ident | null {
  if (stmt.$type === "ValueSpec") {
    return stmt.names[stmt.names.length > 1 ? 1 : 0] ?? null;
  }
  if (stmt.$type === "AssignStmt") {
    const lhs = stmt.lhs[stmt.lhs.length > 1 ? 1 : 0];
    return lhs?.$type === "Ident" ? lhs : null;
  }
  return null;
}
