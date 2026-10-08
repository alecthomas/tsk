import * as types from "go/types";
import type * as ssa from "golang.org/x/tools/go/ssa";
import { defineAnalyzer } from "tsk";
import { buildssa } from "tsk/passes";

export default defineAnalyzer({
  name: "tparallel",
  doc: "tparallel detects inappropriate usage of t.Parallel() method in your Go test codes.",
  url: "https://github.com/moricho/tparallel",
  requires: [buildssa],
  run(pass) {
    const testing = pass.pkg.path() === "testing" ? pass.pkg : pass.pkg.imports().find((pkg) => pkg!.path() === "testing");
    const testType = testing?.scope()?.lookup("T")?.type() ?? null;
    if (!testing || testType === null) {
      return;
    }
    const method = (name: string) => {
      const [object] = types.lookupFieldOrMethod(testType, true, testing, name);
      return object?.$type === "Func" ? object : null;
    };
    const parallel = method("Parallel");
    const cleanup = method("Cleanup");
    const run = method("Run");
    const testPtr = types.newPointer(testType);
    for (const top of pass.resultOf(buildssa).srcFuncs as ssa.Function[]) {
      if (!top.name().startsWith("Test") || top.parent() !== null) {
        continue;
      }
      const subs = subtests(top, run, testPtr);
      if (subs.length === 0) {
        continue;
      }
      const parallelTop = isCalled(top, parallel);
      const parallelSub = subs.some((sub) => isCalled(sub, parallel));
      const hasDefer = top.blocks.some((block) => block!.instrs.some((instr) => instr?.$type === "Defer"));
      if (hasDefer && parallelSub && !isCalled(top, cleanup)) {
        pass.report({ pos: top.pos(), message: `${top.name()} should use t.Cleanup instead of defer` });
      }
      if (parallelSub && !parallelTop) {
        pass.report({ pos: top.pos(), message: `${top.name()} should call t.Parallel on the top level as well as its subtests` });
      } else if (parallelTop && !parallelSub) {
        pass.report({ pos: top.pos(), message: `${top.name()}'s subtests should call t.Parallel` });
      }
    }
  },
});

// calls reports whether an instruction is a call, go, or defer of fn.
function calls(instr: ssa.Instruction | null, fn: types.Func | null): boolean {
  if (instr?.$type !== "Call" && instr?.$type !== "Go" && instr?.$type !== "Defer") {
    return false;
  }
  return fn !== null && instr.call.staticCallee()?.object() === fn;
}

// calledWithin returns the calls of fn within the function an instruction
// calls directly, as upstream's LookupCalled does.
function calledWithin(instr: ssa.Instruction | null, fn: types.Func | null): ssa.Instruction[] {
  const callee = instr?.$type === "Call" ? instr.call.value : null;
  if (callee?.$type !== "Function") {
    return [];
  }
  return callee.blocks.flatMap((block) => block!.instrs.filter((i) => calls(i, fn)) as ssa.Instruction[]);
}

// isCalled reports whether the entry block of f calls fn, directly or in a
// function it calls.
function isCalled(f: ssa.Function, fn: types.Func | null): boolean {
  const entry = f.blocks[0];
  return entry?.instrs.some((instr) => calledWithin(instr, fn).length > 0 || calls(instr, fn)) ?? false;
}

// subtests finds the functions a test runs with t.Run, directly or through
// helpers taking a *testing.T.
function subtests(top: ssa.Function, run: types.Func | null, testPtr: types.Type | null): ssa.Function[] {
  const result: ssa.Function[] = [];
  const add = (instr: ssa.Instruction) => {
    if (instr.$type !== "Call") {
      return;
    }
    for (const arg of instr.call.args) {
      if (arg?.$type === "Function") {
        result.push(arg);
      } else if (arg?.$type === "MakeClosure" && arg.fn?.$type === "Function") {
        result.push(arg.fn);
      }
    }
  };
  for (const block of top.blocks) {
    for (const instr of block!.instrs) {
      if (calls(instr, run)) {
        add(instr!);
      } else if (instr?.$type === "Call" && instr.call.args.some((arg) => types.identical(arg!.type(), testPtr))) {
        calledWithin(instr, run).forEach(add);
      }
    }
  }
  return result;
}
