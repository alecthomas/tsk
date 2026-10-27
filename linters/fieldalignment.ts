// Port of golang.org/x/tools/go/analysis/passes/fieldalignment at v0.50.0.
import * as ast from "go/ast";
import * as parser from "go/parser";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";

export default defineAnalyzer({
  name: "fieldalignment",
  doc: `find structs that would use less memory if their fields were sorted

This analyzer finds structs that can be rearranged to use less memory, and provides
a suggested edit with the most compact order.

Note that there are two different diagnostics reported. One checks struct size,
and the other reports "pointer bytes" used. Pointer bytes is how many bytes of the
object that the garbage collector has to potentially scan for pointers, for example:

	struct { uint32; string }

have 16 pointer bytes because the garbage collector has to scan up through the string's
inner pointer.

	struct { string; *uint32 }

has 24 pointer bytes because it has to scan further through the *uint32.

	struct { string; uint32 }

has 8 because it can stop immediately after the string pointer.

Be aware that the most compact order is not always the most efficient.
In rare cases it may cause two variables each updated by its own goroutine
to occupy the same CPU cache line, inducing a form of memory contention
known as "false sharing" that slows down both goroutines.`,
  group: "govet",
  enabledByDefault: false,
  requires: [inspect],
  run(pass) {
    if (pass.typesSizes === null) {
      return;
    }
    const unsafePointer = types.Typ[types.UnsafePointer]!;
    const sizes = new GCSizes(pass.typesSizes.sizeof(unsafePointer), pass.typesSizes.alignof(unsafePointer));
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.StructType)) {
      const parent = cursor.parent().node();
      const name = parent?.$type === "TypeSpec" ? parent.name!.name : "struct";
      fieldalignment(pass, sizes, cursor.node() as ast.StructType, name);
    }
  },
});

function fieldalignment(pass: Pass<unknown>, sizes: GCSizes, node: ast.StructType, name: string): void {
  const typ = pass.typesInfo.typeOf(node);
  if (typ?.$type !== "Struct") {
    return;
  }
  const fieldTypes = [...typ.fields()].map((field) => field!.type()!);
  const indexes = optimalOrder(fieldTypes, sizes);
  const optimal = indexes.map((i) => fieldTypes[i]);

  const actualSize = sizes.structSizeof(fieldTypes);
  const actualPtrs = sizes.structPtrdata(fieldTypes);
  const optimalSize = sizes.structSizeof(optimal);
  const optimalPtrs = sizes.structPtrdata(optimal);

  let message: string;
  if (actualSize !== optimalSize) {
    message = `${name} has size ${actualSize}`;
    let actualClass = classSize(actualSize);
    if (actualClass === -1) {
      actualClass = actualSize;
      message += " (uses global allocator)";
    } else if (actualClass !== actualSize) {
      message += ` (allocator size class ${actualClass})`;
    }
    message += ` but the optimal size is ${optimalSize}`;
    let optimalClass = classSize(optimalSize);
    if (optimalClass === -1) {
      optimalClass = optimalSize;
    } else if (optimalClass !== optimalSize) {
      message += ` (allocator size class ${optimalClass})`;
    }
    const wastage = actualClass - optimalClass;
    if (wastage > 0) {
      message += ` leading to a waste of ${wastage} bytes (${Math.trunc((wastage * 100) / actualClass)}%)`;
    }
  } else if (actualPtrs !== optimalPtrs) {
    message = `${name} has ${actualPtrs} leading bytes of pointer data but optimal value is ${optimalPtrs}`;
  } else {
    return;
  }

  const newText = reorderedStruct(pass, node, indexes);
  if (newText === null) {
    return;
  }
  pass.report({
    pos: node.pos(),
    end: node.pos() + "struct".length,
    message,
    suggestedFixes: [{ message: "Rearrange fields", textEdits: [{ pos: node.pos(), end: node.end(), newText }] }],
  });
}

// reorderedStruct formats the struct with its fields in the given order. As
// upstream, it drops comments and splits fields that declare several names.
function reorderedStruct(pass: Pass<unknown>, node: ast.StructType, indexes: number[]): string | null {
  const flat: string[] = [];
  for (const f of node.fields!.list) {
    const typ = formatNode(f!.type!, pass.fset);
    if (f!.names.length <= 1) {
      const tag = f!.tag === null ? "" : ` ${f!.tag.value}`;
      flat.push(`${f!.names.length === 1 ? `${f!.names[0]!.name} ` : ""}${typ}${tag}`);
      continue;
    }
    for (const name of f!.names) {
      flat.push(`${name!.name} ${typ}`);
    }
  }
  const src = `struct {\n${indexes.map((i) => flat[i]).join("\n")}\n}`;
  const fset = token.newFileSet()!;
  try {
    return formatNode(parser.parseExprFrom(fset, "", src, 0)!, fset);
  } catch {
    return null;
  }
}

interface Elem {
  index: number;
  alignof: number;
  sizeof: number;
  ptrdata: number;
}

// optimalOrder returns the field indexes in their most compact order.
function optimalOrder(fieldTypes: types.Type[], sizes: GCSizes): number[] {
  const elems: Elem[] = fieldTypes.map((ft, index) => ({ index, alignof: sizes.alignof(ft), sizeof: sizes.sizeof(ft), ptrdata: sizes.ptrdata(ft) }));
  elems.sort((ei, ej) => {
    // Zero-sized objects come first.
    const zeroi = ei.sizeof === 0;
    const zeroj = ej.sizeof === 0;
    if (zeroi !== zeroj) {
      return zeroi ? -1 : 1;
    }
    // Then more tightly aligned objects.
    if (ei.alignof !== ej.alignof) {
      return ej.alignof - ei.alignof;
    }
    // Then pointerful objects before pointer-free ones.
    const noptrsi = ei.ptrdata === 0;
    const noptrsj = ej.ptrdata === 0;
    if (noptrsi !== noptrsj) {
      return noptrsj ? -1 : 1;
    }
    if (!noptrsi) {
      // Among pointerful objects, those with fewer trailing non-pointer bytes first.
      const traili = ei.sizeof - ei.ptrdata;
      const trailj = ej.sizeof - ej.ptrdata;
      if (traili !== trailj) {
        return traili - trailj;
      }
    }
    return ej.sizeof - ei.sizeof;
  });
  return elems.map((e) => e.index);
}

const basicSizes = new Map<types.BasicKind, number>([
  [types.Bool, 1],
  [types.Int8, 1],
  [types.Int16, 2],
  [types.Int32, 4],
  [types.Int64, 8],
  [types.Uint8, 1],
  [types.Uint16, 2],
  [types.Uint32, 4],
  [types.Uint64, 8],
  [types.Float32, 4],
  [types.Float64, 8],
  [types.Complex64, 8],
  [types.Complex128, 16],
]);

// GCSizes implements cmd/compile layout rules, providing ptrdata (GC scanning
// limits) and trailing zero-size field padding not available in types.Sizes.
class GCSizes {
  constructor(
    private readonly wordSize: number,
    private readonly maxAlign: number,
  ) {}

  alignof(t: types.Type): number {
    const u = t.underlying()!;
    switch (u.$type) {
      case "Array":
        return this.alignof(u.elem()!);
      case "Struct": {
        let max = 1;
        for (const field of u.fields()) {
          max = Math.max(max, this.alignof(field!.type()!));
        }
        return max;
      }
    }
    const a = this.sizeof(t);
    return Math.min(Math.max(a, 1), this.maxAlign);
  }

  sizeof(t: types.Type): number {
    const u = t.underlying()!;
    switch (u.$type) {
      case "Basic": {
        const size = basicSizes.get(u.kind());
        if (size !== undefined) {
          return size;
        }
        if (u.kind() === types.String) {
          return this.wordSize * 2;
        }
        break;
      }
      case "Array":
        return u.len() * this.sizeof(u.elem()!);
      case "Slice":
        return this.wordSize * 3;
      case "Struct":
        return this.structSizeof([...u.fields()].map((field) => field!.type()!));
      case "Interface":
        return this.wordSize * 2;
    }
    return this.wordSize;
  }

  structSizeof(fieldTypes: types.Type[]): number {
    if (fieldTypes.length === 0) {
      return 0;
    }
    let o = 0;
    let max = 1;
    fieldTypes.forEach((ft, i) => {
      const a = this.alignof(ft);
      let sz = this.sizeof(ft);
      max = Math.max(max, a);
      if (i === fieldTypes.length - 1 && sz === 0 && o !== 0) {
        sz = 1;
      }
      o = align(o, a) + sz;
    });
    return align(o, max);
  }

  ptrdata(t: types.Type): number {
    const u = t.underlying()!;
    switch (u.$type) {
      case "Basic":
        return u.kind() === types.String || u.kind() === types.UnsafePointer ? this.wordSize : 0;
      case "Chan":
      case "Map":
      case "Pointer":
      case "Signature":
      case "Slice":
        return this.wordSize;
      case "Interface":
        return 2 * this.wordSize;
      case "Array": {
        const n = u.len();
        if (n === 0) {
          return 0;
        }
        const a = this.ptrdata(u.elem()!);
        if (a === 0) {
          return 0;
        }
        return (n - 1) * this.sizeof(u.elem()!) + a;
      }
      case "Struct":
        return this.structPtrdata([...u.fields()].map((field) => field!.type()!));
    }
    throw new Error("impossible");
  }

  structPtrdata(fieldTypes: types.Type[]): number {
    let o = 0;
    let p = 0;
    for (const ft of fieldTypes) {
      const fp = this.ptrdata(ft);
      o = align(o, this.alignof(ft));
      if (fp !== 0) {
        p = o + fp;
      }
      o += this.sizeof(ft);
    }
    return p;
  }
}

// align returns the smallest y >= x such that y % a == 0.
function align(x: number, a: number): number {
  const y = x + a - 1;
  return y - (y % a);
}

// The runtime's malloc size classes, from internal/runtime/gc/sizeclasses.go.
const sizeClasses = [
  0, 8, 16, 24, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 288, 320, 352, 384, 416, 448, 480, 512, 576, 640, 704, 768, 896, 1024,
  1152, 1280, 1408, 1536, 1792, 2048, 2304, 2688, 3072, 3200, 3456, 4096, 4864, 5376, 6144, 6528, 6784, 6912, 8192, 9472, 9728, 10240, 10880, 12288, 13568,
  14336, 16384, 18432, 19072, 20480, 21760, 24576, 27264, 28672, 32768,
];

// classSize returns the allocator size class for an object of the given size,
// or -1 if it is too large for one. Upstream asks the running Go runtime.
function classSize(size: number): number {
  if (size > 1 << 15) {
    return -1;
  }
  return sizeClasses.find((c) => c >= size)!;
}
