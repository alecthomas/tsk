import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import type * as ssa from "golang.org/x/tools/go/ssa";
import { defineAnalyzer, type Pass } from "tsk";
import { buildssa } from "tsk/passes";

export default defineAnalyzer({
  name: "nilerr",
  doc: `Find the code that returns nil even if it checks that the error is not nil.

A "//lint:ignore nilerr reason" comment on the return suppresses a finding.`,
  url: "https://github.com/gostaticanalysis/nilerr",
  requires: [buildssa],
  run(pass) {
    const checker = new Checker(pass);
    for (const fn of pass.resultOf(buildssa).srcFuncs) {
      for (const block of fn!.blocks) {
        checker.check(block!);
      }
    }
  },
});

class Checker {
  private readonly errorType = types.Universe!.lookup("error")!.type()!.underlying() as types.Interface;
  private commentMaps: ast.CommentMap[] | null = null;

  constructor(private readonly pass: Pass<unknown>) {}

  check(block: ssa.BasicBlock): void {
    const notNil = this.comparedError(block, token.NEQ);
    if (notNil !== null) {
      const ret = this.returnsNil(block.succs[0]!);
      if (ret !== null && !usesError(block.succs[0]!, notNil)) {
        this.report(notNil, ret, "error is not nil (%s) but it returns nil");
      }
      return;
    }
    const isNil = this.comparedError(block, token.EQL);
    // With several predecessors, the error may not be nil on every path.
    if (isNil !== null && block.succs[0]!.preds.length === 1) {
      const ret = returnsValue(block.succs[0]!, isNil);
      if (ret !== null) {
        this.report(isNil, ret, "error is nil (%s) but it returns error");
      }
    }
  }

  // comparedError returns the error a block ending in "if err <op> nil"
  // compares, or null.
  private comparedError(block: ssa.BasicBlock, op: token.Token): ssa.Value | null {
    const last = block.instrs[block.instrs.length - 1];
    if (last?.$type !== "If" || last.cond?.$type !== "BinOp" || last.cond.op !== op) {
      return null;
    }
    const { x, y } = last.cond;
    if (!this.isError(x!.type()) || !this.isError(y!.type())) {
      return null;
    }
    const xConst = x!.$type === "Const";
    const yConst = y!.$type === "Const";
    if (xConst === yConst) {
      return null;
    }
    return yConst ? x : y;
  }

  // returnsNil returns a block's return if it has an error result and every
  // error result is nil.
  private returnsNil(block: ssa.BasicBlock): ssa.Return | null {
    const last = block.instrs[block.instrs.length - 1];
    if (last?.$type !== "Return") {
      return null;
    }
    const errors = last.results.filter((result) => this.isError(result!.type()));
    if (errors.length === 0 || errors.some((result) => result!.$type !== "Const" || !result.isNil())) {
      return null;
    }
    return last;
  }

  private isError(t: types.Type | null): boolean {
    return types.implements_(t, this.errorType);
  }

  private report(err: ssa.Value, ret: ssa.Return, format: string): void {
    if (this.ignored(ret.pos())) {
      return;
    }
    const lines = this.lines(err, new Set());
    const text = lines.length === 1 ? `line ${lines[0]}` : `lines [${lines.join(" ")}]`;
    this.pass.report({ pos: ret.pos(), message: format.replace("%s", text) });
  }

  // lines returns the lines where an error value is set, following phi
  // edges. seen holds visited value names, so cycles end.
  private lines(value: ssa.Value, seen: Set<string>): number[] {
    if (value.$type === "Phi") {
      const result: number[] = [];
      for (const edge of value.edges) {
        if (seen.has(edge!.name())) {
          if (edge!.pos() !== token.NoPos) {
            result.push(this.line(edge!.pos()));
          }
          continue;
        }
        seen.add(edge!.name());
        result.push(...this.lines(edge!, seen));
      }
      return result.sort((a, b) => a - b);
    }
    const pos = value.$type === "Extract" ? value.tuple!.pos() : value.pos();
    return pos === token.NoPos ? [] : [this.line(pos)];
  }

  private line(pos: token.Pos): number {
    return this.pass.fset.position(pos).line;
  }

  // ignored reports whether the AST node starting at pos has a comment such
  // as "//lint:ignore nilerr reason".
  private ignored(pos: token.Pos): boolean {
    if (this.commentMaps === null) {
      this.commentMaps = this.pass.files.map((file) => ast.newCommentMap(this.pass.fset, file, file!.comments));
    }
    for (const map of this.commentMaps) {
      for (const [node, groups] of map) {
        if (node.pos() === pos) {
          return groups.some((group) => group!.list.some((comment) => ignoresNilerr(comment!.text)));
        }
      }
    }
    return false;
  }
}

function ignoresNilerr(text: string): boolean {
  if (!text.startsWith("//")) {
    return false;
  }
  const fields = text.slice(2).trim().split(" ");
  return fields.length >= 3 && fields[0] === "lint:ignore" && fields[1].split(",").includes("nilerr");
}

// returnsValue returns a block's return if one of its results is value.
function returnsValue(block: ssa.BasicBlock, value: ssa.Value): ssa.Return | null {
  const last = block.instrs[block.instrs.length - 1];
  return last?.$type === "Return" && last.results.includes(value) ? last : null;
}

// usesError reports whether a block passes the error to a call, directly or
// within a variadic slice.
function usesError(block: ssa.BasicBlock, err: ssa.Value): boolean {
  return block.instrs.some(
    (instr) => instr?.$type === "Call" && instr.call.args.some((arg) => isUsedIn(arg!, err) || (arg!.$type === "Slice" && isUsedInSlice(arg, err))),
  );
}

// isUsedInSlice reports whether the error is stored into the array a slice
// is made from, as for a variadic argument.
function isUsedInSlice(slice: ssa.Slice, err: ssa.Value): boolean {
  const values: ssa.Value[] = [];
  const nodes: ssa.Instruction[] = [];
  const visited = new Set<ssa.Instruction>();
  const addReferrers = (value: ssa.Value) => {
    for (const ref of value.referrers() ?? []) {
      if (ref !== null && !visited.has(ref)) {
        visited.add(ref);
        nodes.push(ref);
      }
    }
  };
  for (const operand of slice.operands([])) {
    if (operand !== null) {
      addReferrers(operand);
      values.push(operand);
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.$type === "IndexAddr") {
      addReferrers(node);
    } else if (node.$type === "Store" && node.val !== null) {
      values.push(node.val);
    }
  }
  return values.some((value) => isUsedIn(value, err));
}

function isUsedIn(value: ssa.Value, err: ssa.Value): boolean {
  if (value === err) {
    return true;
  }
  switch (value.$type) {
    case "ChangeInterface":
    case "MakeInterface":
      return isUsedIn(value.x!, err);
    case "Call":
      return value.call.isInvoke() && isUsedIn(value.call.value!, err);
    default:
      return false;
  }
}
