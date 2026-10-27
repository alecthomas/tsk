// Port of golang.org/x/tools/go/analysis/passes/nilness at v0.50.0.
import * as token from "go/token";
import * as types from "go/types";
import type * as ssa from "golang.org/x/tools/go/ssa";
import { defineAnalyzer, type Pass } from "tsk";
import { buildssa } from "tsk/passes";
import { coreType, normalTerms } from "./internal/typeparams";

const isNonNil = -1;
const unknown = 0;
const isNil = 1;
type Nilness = typeof isNonNil | typeof unknown | typeof isNil;

const nilnessStrings = ["non-nil", "unknown", "nil"];

// Fact records that a block is dominated by the condition value == nil or
// value != nil.
interface Fact {
  value: ssa.Value;
  nilness: Nilness;
}

export default defineAnalyzer({
  name: "nilness",
  doc: `check for redundant or impossible nil comparisons

The nilness checker inspects the control-flow graph of each function in
a package and reports nil pointer dereferences, degenerate nil
pointers, and panics with nil values. A degenerate comparison is of the form
x==nil or x!=nil where x is statically known to be nil or non-nil. These are
often a mistake, especially in control flow related to errors. Panics with nil
values are checked because they are not detectable by

	if r := recover(); r != nil {

This check reports conditions such as:

	if f == nil { // impossible condition (f is a function)
	}

and:

	p := &v
	...
	if p != nil { // tautological condition
	}

and:

	if p == nil {
		print(*p) // nil dereference
	}

and:

	if p == nil {
		panic(p)
	}`,
  group: "govet",
  enabledByDefault: false,
  requires: [buildssa],
  run(pass) {
    for (const fn of pass.resultOf(buildssa).srcFuncs) {
      runFunc(pass, fn!);
    }
  },
});

function runFunc(pass: Pass<unknown>, fn: ssa.Function): void {
  // cgo functions with //go:cgo_unsafe_args behave in ways SSA does not capture.
  if (hasCgoUnsafeArgs(fn)) {
    return;
  }
  const reportf = (category: string, pos: token.Pos, message: string) => {
    // Nil-checking instructions without syntax are ignored.
    if (pos !== token.NoPos) {
      pass.report({ pos, category, message });
    }
  };
  const notNil = (stack: Fact[], instr: ssa.Instruction, v: ssa.Value, descr: string) => {
    if (nilnessOf(stack, v) === isNil) {
      reportf("nilderef", instr.pos(), descr);
    }
  };

  // visit walks reachable blocks in dominance order, keeping a stack of
  // dominating nilness facts that can be dropped once a subtree is done.
  const seen = new Set<number>();
  const visit = (b: ssa.BasicBlock, stack: Fact[]): void => {
    if (seen.has(b.index)) {
      return;
    }
    seen.add(b.index);

    for (const instr of b.instrs) {
      checkDeref(instr!, stack, notNil);
    }
    for (const instr of b.instrs) {
      if (instr?.$type === "Panic") {
        if (nilnessOf(stack, instr.x!) === isNil) {
          reportf("nilpanic", instr.pos(), "panic with nil value");
        }
      } else if (instr?.$type === "SliceToArrayPointer") {
        if (nilnessOf(stack, instr.x!) === isNil && slice2ArrayPtrLen(instr) > 0) {
          reportf("conversionpanic", instr.pos(), "nil slice being cast to an array of len > 0 will always panic");
        }
      }
    }

    const dominees = b.dominees() as ssa.BasicBlock[];
    const comparison = eq(b);
    if (comparison !== null) {
      const { binop, tsucc, fsucc } = comparison;
      const xnil = nilnessOf(stack, binop.x!);
      const ynil = nilnessOf(stack, binop.y!);
      if (ynil !== unknown && xnil !== unknown && (xnil === isNil || ynil === isNil)) {
        const adj = (xnil === ynil) === (binop.op === token.EQL) ? "tautological" : "impossible";
        const message = `${adj} condition: ${nilnessStrings[xnil + 1]} ${token.Token.string(binop.op)} ${nilnessStrings[ynil + 1]}`;
        reportf("cond", binop.pos(), message);
        // The successor whose sole incoming edge is impossible is unreachable,
        // so prune it and the blocks it dominates.
        const skip = xnil === ynil ? fsucc : tsucc;
        for (const d of dominees) {
          if (!(d === skip && d.preds.length === 1)) {
            visit(d, stack);
          }
        }
        return;
      }
      if (xnil === isNil || ynil === isNil) {
        const newFacts = expandFacts({ value: xnil === isNil ? binop.y! : binop.x!, nilness: isNil });
        for (const d of dominees) {
          // Successors learn facts only along non-critical edges.
          let s = stack;
          if (d.preds.length === 1) {
            if (d === tsucc) {
              s = [...stack, ...newFacts];
            } else if (d === fsucc) {
              s = [...stack, ...newFacts.map(negate)];
            }
          }
          visit(d, s);
        }
        return;
      }
    }

    // In "if ptr, ok := x.(*T); ok { ... } else { fsucc }", fsucc learns
    // that ptr, the zero value, is nil.
    const last = b.instrs[b.instrs.length - 1];
    if (last?.$type === "If") {
      let cond = last.cond!;
      let fsucc = b.succs[1];
      if (cond.$type === "UnOp" && cond.op === token.NOT) {
        cond = cond.x!;
        fsucc = b.succs[0];
      }
      if (cond.$type === "Extract" && cond.index === 1) {
        const assert = cond.tuple;
        if (assert?.$type === "TypeAssert" && isNillable(assert.assertedType!)) {
          for (const ref of assert.referrers() ?? []) {
            if (ref?.$type === "Extract" && ref.index === 0 && ref.tuple === cond.tuple) {
              for (const d of dominees) {
                if (d.preds.length === 1 && d === fsucc) {
                  visit(d, [...stack, { value: ref, nilness: isNil }]);
                }
              }
            }
          }
        }
      }
    }

    for (const d of dominees) {
      visit(d, stack);
    }
  };

  // No need to visit fn.recover.
  if (fn.blocks.length > 0) {
    visit(fn.blocks[0]!, []);
  }
}

// checkDeref reports an instruction that dereferences a provably nil value.
function checkDeref(instr: ssa.Instruction, stack: Fact[], notNil: (stack: Fact[], instr: ssa.Instruction, v: ssa.Value, descr: string) => void): void {
  switch (instr.$type) {
    case "Call":
    case "Defer":
    case "Go": {
      // A nil receiver may be okay for type params.
      const cc = instr.call;
      if (!(cc.isInvoke() && isTypeParam(cc.value!.type()))) {
        notNil(stack, instr, cc.value!, `nil dereference in ${cc.description()}`);
      }
      break;
    }
    case "FieldAddr":
      notNil(stack, instr, instr.x!, "nil dereference in field selection");
      break;
    case "IndexAddr": {
      const core = coreType(instr.x!.type()!);
      if (core?.$type === "Pointer") {
        notNil(stack, instr, instr.x!, "nil dereference in array index operation");
      } else if (core?.$type === "Slice") {
        // Not necessarily a runtime error, since a bounds check usually dominates it.
        notNil(stack, instr, instr.x!, isRangeIndex(instr) ? "range of nil slice" : "index of nil slice");
      }
      break;
    }
    case "MapUpdate":
      notNil(stack, instr, instr.map!, "nil dereference in map update");
      break;
    case "Range":
      notNil(stack, instr, instr.x!, "range over nil map");
      break;
    case "Slice":
      // A nil check occurs in ptr[:] only if ptr is a pointer to an array.
      if (instr.x!.type()!.underlying()?.$type === "Pointer") {
        notNil(stack, instr, instr.x!, "nil dereference in slice operation");
      }
      break;
    case "Store":
      notNil(stack, instr, instr.addr!, "nil dereference in store");
      break;
    case "TypeAssert":
      if (!instr.commaOk) {
        notNil(stack, instr, instr.x!, "nil dereference in type assertion");
      }
      break;
    case "UnOp":
      if (instr.op === token.MUL) {
        notNil(stack, instr, instr.x!, "nil dereference in load");
      } else if (instr.op === token.ARROW) {
        notNil(stack, instr, instr.x!, "receive from nil channel");
      }
      break;
    case "Send":
      notNil(stack, instr, instr.chan!, "send to nil channel");
      break;
  }
}

function negate(fact: Fact): Fact {
  return { value: fact.value, nilness: -fact.nilness as Nilness };
}

// nilnessOf reports whether v is nil, non-nil, or unknown, given the
// dominating facts.
function nilnessOf(stack: Fact[], v: ssa.Value): Nilness {
  // Unwrap values whose nilness is intrinsic to the value they wrap.
  switch (v.$type) {
    case "ChangeInterface":
    case "Slice": {
      const underlying = nilnessOf(stack, v.x!);
      if (underlying !== unknown) {
        return underlying;
      }
      break;
    }
    case "MakeInterface": {
      const tparam = types.unalias(v.x!.type());
      if (tparam?.$type !== "TypeParam") {
        return isNonNil;
      }
      // Boxing a type parameter that cannot be an interface type is non-nil.
      const terms = normalTerms(tparam.constraint()!);
      if (terms !== null && terms.length > 0) {
        return isNonNil;
      }
      break;
    }
    case "SliceToArrayPointer": {
      const nn = nilnessOf(stack, v.x!);
      if (slice2ArrayPtrLen(v) > 0) {
        // A nil slice makes the conversion itself panic, so report that
        // rather than later dereferences.
        return nn === isNil ? unknown : isNonNil;
      }
      if (nn !== unknown) {
        return nn;
      }
      break;
    }
  }
  switch (v.$type) {
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
      return v.isNil() ? isNil : unknown;
  }
  return stack.find((f) => f.value === v)?.nilness ?? unknown;
}

function slice2ArrayPtrLen(v: ssa.SliceToArrayPointer): number {
  const ptr = v.type() as types.Pointer;
  return (ptr.elem()!.underlying() as types.Array).len();
}

// eq returns a block's closing equality comparison with its true (equal) and
// false (not equal) successors.
function eq(b: ssa.BasicBlock): { binop: ssa.BinOp; tsucc: ssa.BasicBlock; fsucc: ssa.BasicBlock } | null {
  const last = b.instrs[b.instrs.length - 1];
  if (last?.$type !== "If" || last.cond?.$type !== "BinOp") {
    return null;
  }
  const [first, second] = b.succs as ssa.BasicBlock[];
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

function isTypeParam(t: types.Type | null): boolean {
  return types.unalias(t)?.$type === "TypeParam";
}

function isNillable(t: types.Type): boolean {
  const core = coreType(t);
  switch (core?.$type) {
    case "Pointer":
    case "Map":
    case "Signature":
    case "Chan":
    case "Interface":
    case "Slice":
      return true;
    case "Basic":
      return core === types.Typ[types.UnsafePointer];
    default:
      return false;
  }
}

// isRangeIndex reports whether instr is slice[i] within a "for range slice"
// loop, by matching go/ssa's lowering of range-over-slice.
function isRangeIndex(instr: ssa.IndexAddr): boolean {
  const incr = instr.index;
  if (incr?.$type !== "BinOp" || incr.op !== token.ADD) {
    return false;
  }
  const b = incr.block()!;
  if (b.comment !== "rangeindex.loop") {
    return false;
  }
  const last = b.instrs[b.instrs.length - 1];
  if (last?.$type !== "If") {
    return false;
  }
  const cond = last.cond as ssa.BinOp;
  if (cond.x !== incr || cond.op !== token.LSS || cond.y?.$type !== "Call") {
    return false;
  }
  const common = cond.y.call;
  if (common.value?.$type === "Builtin" && common.value.name() === "len") {
    return common.args[0] === instr.x;
  }
  return false;
}

function hasCgoUnsafeArgs(fn: ssa.Function | null): boolean {
  for (; fn !== null; fn = fn.parent()) {
    const decl = fn.syntax();
    if (decl?.$type === "FuncDecl") {
      for (const c of decl.doc?.list ?? []) {
        if (/^\/\/go:cgo_unsafe_args( |$)/.test(c!.text)) {
          return true;
        }
      }
    }
  }
  return false;
}
