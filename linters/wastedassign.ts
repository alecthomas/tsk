import * as ast from "go/ast";
import type * as types from "go/types";
import * as ssa from "golang.org/x/tools/go/ssa";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

// Block is the part of a basic block still to be searched.
interface Block {
  index: number;
  instrs: readonly (ssa.Instruction | null)[];
  succs: readonly (ssa.BasicBlock | null)[];
}

const noUseUntilReturn = "noUseUntilReturn";
const reassignedSoon = "reassignedSoon";
const notWasted = "notWasted";
type Reason = typeof noUseUntilReturn | typeof reassignedSoon | typeof notWasted;

export default defineAnalyzer({
  name: "wastedassign",
  doc: "Finds wasted assignment statements.",
  url: "https://github.com/sanposhiho/wastedassign",
  requires: [inspect],
  run(pass: Pass<unknown>) {
    const typeSwitchLines = new Set<number>();
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.TypeSwitchStmt)) {
      typeSwitchLines.add(pass.fset.position(cursor.node()!.pos()).line);
    }
    for (const fn of sourceFunctions(pass)) {
      for (const block of fn.blocks) {
        checkBlock(pass, fn, block!, typeSwitchLines);
      }
    }
  },
});

// sourceFunctions builds the package in naive SSA form, which keeps local
// variables as allocations and their assignments as stores.
function sourceFunctions(pass: Pass<unknown>): ssa.Function[] {
  const prog = ssa.newProgram(pass.fset, ssa.NaiveForm)!;
  const created = new Set<types.Package>();
  const createAll = (pkgs: readonly (types.Package | null)[]) => {
    for (const pkg of pkgs) {
      if (pkg !== null && !created.has(pkg)) {
        created.add(pkg);
        prog.createPackage(pkg, [], null, true);
        createAll(pkg.imports());
      }
    }
  };
  createAll(pass.pkg.imports());
  prog.createPackage(pass.pkg, [...pass.files], pass.typesInfo, false)!.build();

  const fns: ssa.Function[] = [];
  const addAnons = (fn: ssa.Function) => {
    fns.push(fn);
    for (const anon of fn.anonFuncs) {
      addAnons(anon!);
    }
  };
  for (const file of pass.files) {
    for (const decl of file!.decls) {
      // SSA builds no function for a blank name.
      if (decl?.$type === "FuncDecl" && decl.name!.name !== "_") {
        const fn = prog.funcValue(pass.typesInfo.objectOf(decl.name) as types.Func);
        if (fn !== null) {
          addAnons(fn);
        }
      }
    }
  }
  return fns;
}

function checkBlock(pass: Pass<unknown>, fn: ssa.Function, block: ssa.BasicBlock, typeSwitchLines: Set<number>): void {
  block.instrs.forEach((instr, i) => {
    if (instr?.$type !== "Store") {
      return;
    }
    // Upstream's copy keeps the block's index and successors, so the original
    // block can still be revisited through a loop.
    const rest: Block = { index: block.index, instrs: block.instrs.slice(i + 1), succs: block.succs };
    for (const op of instr.operands([])) {
      if (op?.$type !== "Alloc" || !fn.locals.includes(op)) {
        continue;
      }
      const reason = nextOperation([rest], op, new Map());
      if (reason === notWasted || instr.pos() === 0 || typeSwitchLines.has(pass.fset.position(instr.pos()).line)) {
        continue;
      }
      pass.report({
        pos: instr.pos(),
        message:
          reason === noUseUntilReturn
            ? `assigned to ${op.comment}, but never used afterwards`
            : `assigned to ${op.comment}, but reassigned without using the value`,
      });
    }
  });
}

// nextOperation reports whether the next operations on a local, along every
// path, store to it again or never use it.
function nextOperation(blocks: readonly Block[], local: ssa.Alloc, checked: Map<number, number>): Reason {
  const reasons: Reason[] = [];
  const currentReasons: Reason[] = [];
  for (const block of blocks) {
    const count = checked.get(block.index) ?? 0;
    if (count === 2) {
      continue;
    }
    checked.set(block.index, count + 1);
    let stored = false;
    for (const instr of block.instrs) {
      if (stored) {
        break;
      }
      for (const op of instr!.operands([])) {
        if (op !== local) {
          continue;
        }
        if (instr!.$type !== "Store" || instr!.addr!.name() !== local.name()) {
          return notWasted;
        }
        currentReasons.push(reassignedSoon);
        stored = true;
        break;
      }
    }
    if (block.succs.length !== 0 && !stored) {
      const reason = nextOperation(block.succs.filter((succ) => succ !== block) as ssa.BasicBlock[], local, checked);
      if (reason === notWasted) {
        return notWasted;
      }
      reasons.push(reason);
    }
  }
  return [...reasons, ...currentReasons].includes(reassignedSoon) ? reassignedSoon : noUseUntilReturn;
}
