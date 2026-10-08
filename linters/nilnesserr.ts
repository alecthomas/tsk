import * as token from "go/token";
import * as types from "go/types";
import type * as ssa from "golang.org/x/tools/go/ssa";
import { defineAnalyzer, type Pass } from "tsk";
import { buildssa } from "tsk/passes";

const isNonNil = -1;
const unknown = 0;
const isNil = 1;
type Nilness = typeof isNonNil | typeof unknown | typeof isNil;

// Fact records that a block is dominated by the condition value == nil or
// value != nil.
interface Fact {
  value: ssa.Value;
  nilness: Nilness;
}

export default defineAnalyzer({
  name: "nilnesserr",
  doc: `Reports constructs that checks for err != nil, but returns a different nil value error.
Powered by nilness and nilerr.`,
  url: "https://github.com/alingse/nilnesserr",
  requires: [buildssa],
  run(pass) {
    const errorType = types.Universe!.lookup("error")!.type()!.underlying() as types.Interface;
    for (const fn of pass.resultOf(buildssa).srcFuncs) {
      new FuncChecker(pass, errorType, fn!).run();
    }
  },
});

// FuncChecker visits a function's blocks in dominance order, as the nilness
// pass does, tracking nilness facts and which errors are known to be non-nil.
class FuncChecker {
  private readonly seen = new Set<number>();

  constructor(
    private readonly pass: Pass<unknown>,
    private readonly errorType: types.Interface,
    private readonly fn: ssa.Function,
  ) {}

  run(): void {
    if (this.fn.blocks.length > 0) {
      this.visit(this.fn.blocks[0]!, [], []);
    }
  }

  private visit(block: ssa.BasicBlock, stack: Fact[], errors: Fact[]): void {
    if (this.seen.has(block.index)) {
      return;
    }
    this.seen.add(block.index);
    this.checkBlock(block, stack, errors);
    const dominees = block.dominees() as ssa.BasicBlock[];
    const comparison = eq(block);
    if (comparison !== null) {
      const { binop, tsucc, fsucc } = comparison;
      const errValue = this.checkedError(binop);
      const xnil = nilnessOf(stack, binop.x!);
      const ynil = nilnessOf(stack, binop.y!);
      if (xnil !== unknown && ynil !== unknown && (xnil === isNil || ynil === isNil)) {
        // A degenerate comparison makes one successor unreachable if that is
        // its only incoming edge.
        const skip = xnil === ynil ? fsucc : tsucc;
        for (const d of dominees) {
          if (!(d === skip && d.preds.length === 1)) {
            this.visit(d, stack, errors);
          }
        }
        return;
      }
      if (xnil === isNil || ynil === isNil) {
        const newFacts = expandFacts({ value: xnil === isNil ? binop.y! : binop.x!, nilness: isNil });
        for (const d of dominees) {
          let s = stack;
          let errs = errors;
          // Successors learn facts only along non-critical edges.
          if (d.preds.length === 1 && d === tsucc) {
            s = [...stack, ...newFacts];
            errs = errValue === null ? errors : [...errors, { value: errValue, nilness: isNil }];
          } else if (d.preds.length === 1 && d === fsucc) {
            s = [...stack, ...newFacts.map(negate)];
            errs = errValue === null ? errors : [...errors, { value: errValue, nilness: isNonNil }];
          }
          this.visit(d, s, errs);
        }
        return;
      }
    }
    this.visitTypeAssertFailure(block, stack, errors, dominees);
    for (const d of dominees) {
      this.visit(d, stack, errors);
    }
  }

  // visitTypeAssertFailure handles "if ptr, ok := x.(*T); ok", whose false
  // successor learns that ptr, the zero value, is nil.
  private visitTypeAssertFailure(block: ssa.BasicBlock, stack: Fact[], errors: Fact[], dominees: ssa.BasicBlock[]): void {
    const last = block.instrs[block.instrs.length - 1];
    if (last?.$type !== "If") {
      return;
    }
    let cond = last.cond!;
    let fsucc = block.succs[1];
    if (cond.$type === "UnOp" && cond.op === token.NOT) {
      cond = cond.x!;
      fsucc = block.succs[0];
    }
    if (cond.$type !== "Extract" || cond.index !== 1) {
      return;
    }
    const assert = cond.tuple;
    if (assert?.$type !== "TypeAssert" || !isNillable(assert.assertedType!)) {
      return;
    }
    for (const ref of assert.referrers() ?? []) {
      if (ref?.$type === "Extract" && ref.index === 0 && ref.tuple === assert) {
        for (const d of dominees) {
          if (d.preds.length === 1 && d === fsucc) {
            this.visit(d, [...stack, { value: ref, nilness: isNil }], errors);
          }
        }
      }
    }
  }

  // checkBlock reports nil errors returned or passed to calls after an
  // error was found to be non-nil.
  private checkBlock(block: ssa.BasicBlock, stack: Fact[], errors: Fact[]): void {
    const check = (value: ssa.Value | null) =>
      value !== null && this.isError(value) && !isConstNil(value) && nilnessOf(stack, value) === isNil && lastNonNil(errors, value) !== null;
    for (const instr of block.instrs) {
      if (instr === null || instr.pos() === token.NoPos) {
        continue;
      }
      const pos = instr.pos();
      if (instr.$type === "Return") {
        for (const value of instr.results) {
          if (check(value)) {
            this.pass.report({ pos, message: "return a nil value error after check error" });
          }
        }
      } else if (instr.$type === "Call") {
        for (const value of instr.call.args) {
          if (check(value)) {
            this.pass.report({ pos, message: "call function with a nil value error after check error" });
          }
        }
        for (const value of variadicArgs(instr)) {
          if (check(value)) {
            this.pass.report({ pos, message: "call variadic function with a nil value error after check error" });
          }
        }
      }
    }
  }

  // checkedError returns the error compared with nil, as in err != nil.
  private checkedError(binop: ssa.BinOp): ssa.Value | null {
    if (this.isError(binop.x!) && isConstNil(binop.y!)) {
      return binop.x;
    }
    if (this.isError(binop.y!) && isConstNil(binop.x!)) {
      return binop.y;
    }
    return null;
  }

  private isError(value: ssa.Value): boolean {
    return types.implements_(value.type(), this.errorType);
  }
}

// lastNonNil returns the most recent error known to be non-nil, unless value
// itself was checked more recently.
function lastNonNil(errors: Fact[], value: ssa.Value): ssa.Value | null {
  for (let i = errors.length - 1; i >= 0; i--) {
    if (errors[i].value === value) {
      return null;
    }
    if (errors[i].nilness === isNonNil) {
      return errors[i].value;
    }
  }
  return null;
}

// variadicArgs returns the values stored into the array backing a call's
// variadic slice, as for fmt.Errorf("%w", err).
function variadicArgs(call: ssa.Call): ssa.Value[] {
  const fn = call.call.value;
  const last = call.call.args[call.call.args.length - 1];
  if (fn?.$type !== "Function" || !fn.signature?.variadic() || last?.$type !== "Slice") {
    return [];
  }
  if (last.low !== null || last.high !== null || last.max !== null || last.x?.$type !== "Alloc") {
    return [];
  }
  const allocType = last.x.type();
  if (allocType?.$type !== "Pointer" || allocType.elem()?.$type !== "Array") {
    return [];
  }
  const values: ssa.Value[] = [];
  for (const indexAddr of last.x.referrers() ?? []) {
    if (indexAddr?.$type !== "IndexAddr") {
      continue;
    }
    for (const store of indexAddr.referrers() ?? []) {
      if (store?.$type === "Store" && store.val !== null) {
        values.push(store.val.$type === "ChangeInterface" ? store.val.x! : store.val);
      }
    }
  }
  return values;
}

function isConstNil(value: ssa.Value): boolean {
  return value.$type === "Const" && value.isNil();
}

function negate(fact: Fact): Fact {
  return { value: fact.value, nilness: -fact.nilness as Nilness };
}

// eq returns a block's closing equality comparison with its true (equal) and
// false (not equal) successors.
function eq(block: ssa.BasicBlock): { binop: ssa.BinOp; tsucc: ssa.BasicBlock; fsucc: ssa.BasicBlock } | null {
  const last = block.instrs[block.instrs.length - 1];
  if (last?.$type !== "If" || last.cond?.$type !== "BinOp") {
    return null;
  }
  const [first, second] = block.succs as ssa.BasicBlock[];
  if (last.cond.op === token.EQL) {
    return { binop: last.cond, tsucc: first, fsucc: second };
  }
  if (last.cond.op === token.NEQ) {
    return { binop: last.cond, tsucc: second, fsucc: first };
  }
  return null;
}

// expandFacts adds facts about the values a ChangeInterface wraps, since they
// share its nilness.
function expandFacts(fact: Fact): Fact[] {
  const facts = [fact];
  for (let value = fact.value; value.$type === "ChangeInterface"; value = value.x!) {
    facts.push({ value: value.x!, nilness: fact.nilness });
  }
  return facts;
}

// nilnessOf reports whether a value is nil, non-nil, or unknown, given the
// dominating facts.
function nilnessOf(stack: Fact[], value: ssa.Value): Nilness {
  switch (value.$type) {
    case "ChangeInterface":
    case "Slice": {
      const underlying = nilnessOf(stack, value.x!);
      if (underlying !== unknown) {
        return underlying;
      }
      break;
    }
    case "MakeInterface": {
      // Boxing a type parameter gives nil if it can be an interface type.
      // Upstream checks the constraint's normal terms; a constraint with type
      // terms is close enough.
      const t = types.unalias(value.x!.type());
      if (t?.$type !== "TypeParam") {
        return isNonNil;
      }
      const constraint = t.constraint()?.underlying();
      if (constraint?.$type === "Interface" && !constraint.isMethodSet()) {
        return isNonNil;
      }
      break;
    }
    case "SliceToArrayPointer": {
      const nn = nilnessOf(stack, value.x!);
      const ptr = value.type();
      const array = ptr?.$type === "Pointer" ? ptr.elem()?.underlying() : null;
      if (array?.$type === "Array" && array.len() > 0) {
        // Converting a nil slice to a non-empty array pointer panics.
        return nn === isNil ? unknown : isNonNil;
      }
      if (nn !== unknown) {
        return nn;
      }
      break;
    }
  }
  switch (value.$type) {
    case "Alloc":
    case "FieldAddr":
    case "FreeVar":
    case "Function":
    case "Global":
    case "IndexAddr":
    case "MakeChan":
    case "MakeClosure":
    case "MakeMap":
    case "MakeSlice":
      return isNonNil;
    case "Const":
      return value.isNil() ? isNil : unknown;
  }
  return stack.find((fact) => fact.value === value)?.nilness ?? unknown;
}

// isNillable reports whether a type assertion's failed result is nil. As
// upstream does via core types, interfaces count as not nillable.
function isNillable(t: types.Type): boolean {
  const u = t.underlying();
  switch (u?.$type) {
    case "Pointer":
    case "Map":
    case "Signature":
    case "Chan":
    case "Slice":
      return true;
    case "Basic":
      return u.kind() === types.UnsafePointer;
    default:
      return false;
  }
}
