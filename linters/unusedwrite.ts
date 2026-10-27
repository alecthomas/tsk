// Port of golang.org/x/tools/go/analysis/passes/unusedwrite at v0.50.0.
import * as types from "go/types";
import type * as ssa from "golang.org/x/tools/go/ssa";
import { defineAnalyzer } from "tsk";
import { buildssa } from "tsk/passes";
import { coreType, deref } from "./internal/typeparams";
import { imports } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "unusedwrite",
  doc: `checks for unused writes

The analyzer reports instances of writes to struct fields and
arrays that are never read. Specifically, when a struct object
or an array is copied, its elements are copied implicitly by
the compiler, and any element write to this copy does nothing
with the original object.

For example:

	type T struct { x int }

	func f(input []T) {
		for i, v := range input {  // v is a copy
			v.x = i  // unused write to field x
		}
	}

Another example is about non-pointer receiver:

	type T struct { x int }

	func (t T) f() {  // t is a copy
		t.x = i  // unused write to field x
	}`,
  group: "govet",
  enabledByDefault: false,
  requires: [buildssa],
  run(pass) {
    // The analysis may give false positives with unsafe (golang/go#67684).
    if (imports(pass.pkg, "unsafe")) {
      return;
    }
    for (const fn of pass.resultOf(buildssa).srcFuncs) {
      for (const store of checkStores(fn!)) {
        const addr = store.addr!;
        if (addr.$type === "FieldAddr") {
          const struct = coreType(deref(addr.x!.type()!)) as types.Struct;
          pass.report({ pos: store.pos(), message: `unused write to field ${struct.field(addr.field)!.name()}` });
        } else if (addr.$type === "IndexAddr") {
          pass.report({ pos: store.pos(), message: `unused write to array index ${addr.index!.string()}` });
        }
      }
    }
  },
});

// checkStores returns the stores in fn to a field or element of a copied,
// unshared object that is never read. Map updates only copy a reference.
function checkStores(fn: ssa.Function): ssa.Store[] {
  const reports: ssa.Store[] = [];
  for (const blk of fn.blocks) {
    for (const instr of blk!.instrs) {
      if (instr?.$type !== "Store") {
        continue;
      }
      const addr = instr.addr;
      if ((addr?.$type === "FieldAddr" || addr?.$type === "IndexAddr") && isDeadStore(instr, addr.x!, addr)) {
        reports.push(instr);
      }
    }
  }
  return reports;
}

// isDeadStore reports whether a store through addr, the field or element
// address of obj, is never used.
function isDeadStore(store: ssa.Store, obj: ssa.Value, addr: ssa.FieldAddr | ssa.IndexAddr): boolean {
  if (!hasStructOrArrayType(obj)) {
    return false;
  }
  for (const ref of obj.referrers() ?? []) {
    if (ref === store || ref === addr) {
      continue;
    }
    switch (ref?.$type) {
      case "Call":
      case "Defer":
      case "Go":
        return false;
      case "FieldAddr":
        // Only a use of the same field counts.
        if (ref.x === obj && addr.$type === "FieldAddr" && addr.field === ref.field) {
          return false;
        }
        continue;
      case "IndexAddr":
      case "Lookup":
        if (ref.x === obj) {
          return false;
        }
        continue;
      case "Store":
        if (ref.val === obj) {
          return false;
        }
        continue;
      default:
        return false;
    }
  }
  return true;
}

function isStructOrArray(t: types.Type): boolean {
  const u = t.underlying();
  return u?.$type === "Array" || u?.$type === "Struct";
}

// hasStructOrArrayType reports whether v is a struct or array, or for an
// Alloc, whether the allocated variable is.
function hasStructOrArrayType(v: ssa.Value): boolean {
  if (v.$type === "Alloc") {
    const ptr = types.unalias(v.type());
    return ptr?.$type === "Pointer" && isStructOrArray(ptr.elem()!);
  }
  return isStructOrArray(v.type()!);
}
