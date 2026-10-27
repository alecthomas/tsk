// Port of golang.org/x/tools/go/analysis/passes/asmdecl at v0.50.0.
import type * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, goarch, type Pass } from "tsk";
import { byteLength } from "./internal/utf8";

// A kind of assembly variable. The kinds 1, 2, 4, 8 stand for values of that
// size; the special kinds below are not valid sizes.
type AsmKind = number;

const asmString = 100;
const asmSlice = 101;
const asmArray = 102;
const asmInterface = 103;
const asmEmptyInterface = 104;
const asmStruct = 105;
const asmComplex = 106;

// An architecture's assembly parameters.
interface AsmArch {
  name: string;
  bigEndian: boolean;
  stack: string;
  lr: boolean;
  // The first integer and floating-point result registers of ABIInternal;
  // accessing either counts as writing the result.
  retRegs: string[];
  // Instructions that write a result register implicitly.
  writeResult: string[];
  sizes: types.Sizes;
  intSize: number;
  ptrSize: number;
  maxAlign: number;
}

type ArchParams = Pick<AsmArch, "name" | "bigEndian" | "stack" | "lr" | "retRegs" | "writeResult">;

const archParams: ArchParams[] = [
  { name: "386", bigEndian: false, stack: "SP", lr: false, retRegs: [], writeResult: [] },
  { name: "arm", bigEndian: false, stack: "R13", lr: true, retRegs: [], writeResult: [] },
  { name: "arm64", bigEndian: false, stack: "RSP", lr: true, retRegs: ["R0", "F0"], writeResult: ["SVC"] },
  { name: "amd64", bigEndian: false, stack: "SP", lr: false, retRegs: ["AX", "X0"], writeResult: ["SYSCALL"] },
  { name: "mips", bigEndian: true, stack: "R29", lr: true, retRegs: [], writeResult: [] },
  { name: "mipsle", bigEndian: false, stack: "R29", lr: true, retRegs: [], writeResult: [] },
  { name: "mips64", bigEndian: true, stack: "R29", lr: true, retRegs: [], writeResult: [] },
  { name: "mips64le", bigEndian: false, stack: "R29", lr: true, retRegs: [], writeResult: [] },
  { name: "ppc64", bigEndian: true, stack: "R1", lr: true, retRegs: ["R3", "F1"], writeResult: ["SYSCALL"] },
  { name: "ppc64le", bigEndian: false, stack: "R1", lr: true, retRegs: ["R3", "F1"], writeResult: ["SYSCALL"] },
  { name: "riscv64", bigEndian: false, stack: "SP", lr: true, retRegs: ["X10", "F10"], writeResult: ["ECALL"] },
  { name: "s390x", bigEndian: true, stack: "R15", lr: true, retRegs: [], writeResult: [] },
  { name: "wasm", bigEndian: false, stack: "SP", lr: false, retRegs: [], writeResult: [] },
  { name: "loong64", bigEndian: false, stack: "R3", lr: true, retRegs: ["R4", "F0"], writeResult: ["SYSCALL"] },
];

// Built on first use; the architectures' sizes never change.
let archCache: AsmArch[] | undefined;

function arches(): AsmArch[] {
  if (archCache === undefined) {
    archCache = archParams.map((params) => {
      // Upstream assumes 64-bit norms for an architecture go/types does not know.
      const sizes = types.sizesFor("gc", params.name) ?? types.sizesFor("gc", "amd64")!;
      return {
        ...params,
        sizes,
        intSize: sizes.sizeof(types.Typ[types.Int]!),
        ptrSize: sizes.sizeof(types.Typ[types.UnsafePointer]!),
        maxAlign: sizes.alignof(types.Typ[types.Int64]!),
      };
    });
  }
  return archCache;
}

// The expected variables of a function on one architecture.
interface AsmFunc {
  arch: AsmArch;
  // The size of all arguments.
  size: number;
  vars: Map<string, AsmVar>;
  varByOffset: Map<number, AsmVar>;
}

// A single assembly variable.
interface AsmVar {
  name: string;
  kind: AsmKind;
  typ: string;
  off: number;
  size: number;
  inner: AsmVar[];
}

const asmPlusBuild = /\/\/\s+\+build\s+([^\n]+)/;
const asmTEXT = /\bTEXT\b(.*)·([^(]+)\(SB\)(?:\s*,\s*([0-9A-Z|+()]+))?(?:\s*,\s*\$(-?[0-9]+)(?:-([0-9]+))?)?/u;
const asmDATA = /\b(DATA|GLOBL)\b/;
const asmNamedFP = /\$?([a-zA-Z0-9_\xFF-\u{10FFFF}]+)(?:\+([0-9]+))\(FP\)/gu;
const asmUnnamedFP = /[^+\-0-9](([0-9]+)\(FP\))/gu;
const asmSP = /[^+\-0-9](([0-9]+)\(([A-Z0-9]+)\))/gu;
const asmOpcode = /^\s*(?:[A-Z0-9a-z_]+:)?\s*([A-Z]+)\s*([^,]*)(?:,\s*(.*))?/;
const ppc64Suff = /([BHWD])(ZU|Z|U|BR)?$/;
const abiSuff = /^(.+)<(ABI.+)>$/;

export default defineAnalyzer({
  name: "asmdecl",
  doc: "report mismatches between assembly files and Go declarations",
  group: "govet",
  run(pass) {
    const sfiles = pass.otherFiles.filter((name) => name.endsWith(".s"));
    if (sfiles.length === 0) {
      return;
    }
    // knownFunc[name][arch] describes a function declared without a body.
    const knownFunc = new Map<string, Map<string, AsmFunc>>();
    for (const f of pass.files) {
      for (const decl of f.decls) {
        if (decl?.$type === "FuncDecl" && decl.body === null) {
          knownFunc.set(decl.name!.name, asmParseDecl(pass, decl));
        }
      }
    }
    for (const fname of sfiles) {
      checkFile(pass, knownFunc, fname);
    }
  },
});

function checkFile(pass: Pass<unknown>, knownFunc: Map<string, Map<string, AsmFunc>>, fname: string): void {
  const [content, tf] = readFile(pass, fname);

  // Determine architecture from file name if possible.
  let archDef = arches().find((a) => fname.endsWith(`_${a.name}.s`));
  let arch = archDef?.name ?? "";

  let fn: AsmFunc | undefined;
  let fnName = "";
  let abi = "";
  let localSize = 0;
  let argSize = 0;
  let wroteSP = false;
  let noframe = false;
  let haveRetArg = false;
  let retLine: number[] = [];

  const flushRet = () => {
    const v = fn?.vars.get("ret");
    if (v !== undefined && !haveRetArg && retLine.length > 0) {
      const resultStr = abi === "ABIInternal" ? "result register" : `${v.size}-byte ret+${v.off}(FP)`;
      for (const line of retLine) {
        pass.report({ pos: tf.lineStart(line), message: `[${arch}] ${fnName}: RET without writing to ${resultStr}` });
      }
    }
    retLine = [];
  };

  const lines = splitAfterNewline(content);
  for (let i = 0; i < lines.length; i++) {
    const lineno = i + 1;
    let line = lines[i];
    const badf = (message: string) => {
      pass.report({ pos: tf.lineStart(lineno), message: `[${arch}] ${fnName}: ${message}` });
    };

    if (arch === "") {
      // Determine architecture from a +build line if possible, preferring
      // GOARCH among several.
      const m = asmPlusBuild.exec(line);
      if (m !== null) {
        const fields = m[1].split(/\s+/).filter((f) => f !== "");
        let candidates = fields.flatMap((fld) => arches().filter((a) => a.name === fld));
        const target = candidates.find((a) => a.name === goarch());
        if (target !== undefined) {
          candidates = [target];
        }
        if (candidates.length > 0) {
          archDef = candidates[0];
          arch = archDef.name;
        }
      }
    }

    // Ignore comments and commented-out code.
    const c = line.indexOf("//");
    if (c >= 0) {
      line = line.slice(0, c);
    }

    const text = asmTEXT.exec(line);
    if (text !== null) {
      flushRet();
      if (archDef === undefined) {
        // Arch not specified by filename or build tags, so fall back to GOARCH.
        archDef = arches().find((a) => a.name === goarch());
        if (archDef === undefined) {
          return;
        }
        arch = archDef.name;
      }
      fnName = text[2];
      let pkgPath = text[1].trim();
      if (pkgPath !== "") {
        // The assembler uses Unicode division slash for the directory separator.
        pkgPath = pkgPath.replace(/∕/g, "/");
        if (pkgPath !== pass.pkg.path()) {
          fn = undefined;
          fnName = "";
          abi = "";
          continue;
        }
      }
      // Trim off optional ABI selector.
      const abiMatch = abiSuff.exec(fnName);
      if (abiMatch !== null) {
        fnName = abiMatch[1];
        abi = abiMatch[2];
      } else {
        abi = "";
      }
      const flag = text[3] ?? "";
      fn = knownFunc.get(fnName)?.get(arch);
      if (fn !== undefined) {
        const size = atoi(text[5]);
        if (size !== fn.size && ((flag !== "7" && !flag.includes("NOSPLIT")) || size !== 0)) {
          badf(`wrong argument size ${size}; expected $...-${fn.size}`);
        }
      }
      localSize = atoi(text[4]) + archDef.intSize;
      if (archDef.lr && !flag.includes("NOFRAME")) {
        // Account for caller's saved LR.
        localSize += archDef.intSize;
      }
      argSize = atoi(text[5]);
      noframe = flag.includes("NOFRAME");
      if (fn === undefined && !fnName.includes("<>") && !noframe) {
        badf(`function ${fnName} missing Go declaration`);
      }
      wroteSP = false;
      haveRetArg = false;
      continue;
    } else if (line.includes("TEXT") && line.includes("SB")) {
      // A function not visible from Go (it did not match asmTEXT), so stop checking.
      flushRet();
      fn = undefined;
      fnName = "";
      abi = "";
      continue;
    }

    if (line.includes("RET") && !line.includes("(SB)")) {
      // RET f(SB) is a tail call. It is okay to not write the results.
      retLine.push(lineno);
    }

    if (fnName === "") {
      continue;
    }

    if (asmDATA.test(line)) {
      fn = undefined;
    }

    if (archDef === undefined) {
      continue;
    }

    const stack = archDef.stack;
    if (line.includes(`, ${stack}`) || line.includes(`,\t${stack}`) || line.includes(`NOP ${stack}`) || line.includes(`NOP\t${stack}`)) {
      wroteSP = true;
      continue;
    }

    if (arch === "wasm" && line.includes("CallImport")) {
      // CallImport is a call out to magic that can write the result.
      haveRetArg = true;
    }

    if (abi === "ABIInternal" && !haveRetArg) {
      if (archDef.writeResult.some((ins) => line.includes(ins)) || archDef.retRegs.some((reg) => line.includes(reg))) {
        haveRetArg = true;
      }
    }

    for (const m of line.matchAll(asmSP)) {
      if (m[3] !== stack || wroteSP || noframe) {
        continue;
      }
      const off = atoi(m[2]);
      if (off >= localSize) {
        const v = fn?.varByOffset.get(off - localSize);
        if (v !== undefined) {
          badf(`${m[1]} should be ${v.name}+${off - localSize}(FP)`);
          continue;
        }
        if (off >= localSize + argSize) {
          badf(`use of ${m[1]} points beyond argument frame`);
          continue;
        }
        badf(`use of ${m[1]} to access argument frame`);
      }
    }

    if (fn === undefined) {
      continue;
    }

    for (const m of line.matchAll(asmUnnamedFP)) {
      const off = atoi(m[2]);
      const v = fn.varByOffset.get(off);
      if (v !== undefined) {
        badf(`use of unnamed argument ${m[1]}; offset ${off} is ${v.name}+${v.off}(FP)`);
      } else {
        badf(`use of unnamed argument ${m[1]}`);
      }
    }

    for (const m of line.matchAll(asmNamedFP)) {
      const name = m[1];
      const off = atoi(m[2]);
      if (name === "ret" || name.startsWith("ret_")) {
        haveRetArg = true;
      }
      const v = fn.vars.get(name);
      if (v === undefined) {
        // Allow argframe+0(FP).
        if (name === "argframe" && off === 0) {
          continue;
        }
        const at = fn.varByOffset.get(off);
        if (at !== undefined) {
          badf(`unknown variable ${name}; offset ${off} is ${at.name}+${at.off}(FP)`);
        } else {
          badf(`unknown variable ${name}`);
        }
        continue;
      }
      asmCheckVar(badf, fn, line, m[0], off, v, archDef);
    }
  }
  flushRet();
}

function asmKindForType(t: types.Type, size: number): AsmKind {
  const u = t.underlying()!;
  switch (u.$type) {
    case "Basic":
      switch (u.kind()) {
        case types.String:
          return asmString;
        case types.Complex64:
        case types.Complex128:
          return asmComplex;
      }
      return size;
    case "Pointer":
    case "Chan":
    case "Map":
    case "Signature":
      return size;
    case "Struct":
      return asmStruct;
    case "Interface":
      return u.empty() ? asmEmptyInterface : asmInterface;
    case "Array":
      return asmArray;
    case "Slice":
      return asmSlice;
  }
  throw new Error("unreachable");
}

// An assembly-addressable component of a composite type, or the type itself.
interface Component {
  size: number;
  offset: number;
  kind: AsmKind;
  typ: string;
  // Such as _base for a string's base, or _0_lo for the low half of the first
  // element of [1]uint64 on a 32-bit machine.
  suffix: string;
  // The suffix of the immediately containing composite type.
  outer: string;
}

function component(suffix: string, kind: AsmKind, typ: string, offset: number, size: number, outer: string): Component {
  return { suffix, kind, typ, offset, size, outer };
}

// componentsOfType lists the components of t; for a string, they are the
// string itself, its base, and its length.
function componentsOfType(arch: AsmArch, t: types.Type): Component[] {
  const cc: Component[] = [];
  appendComponentsRecursive(arch, t, cc, "", 0);
  return cc;
}

function appendComponentsRecursive(arch: AsmArch, t: types.Type, cc: Component[], suffix: string, off: number): void {
  const s = t.string();
  const size = arch.sizes.sizeof(t);
  const kind = asmKindForType(t, size);
  cc.push(component(suffix, kind, s, off, size, suffix));

  switch (kind) {
    case 8:
      if (arch.ptrSize === 4) {
        const [w1, w2] = arch.bigEndian ? ["hi", "lo"] : ["lo", "hi"];
        cc.push(component(`${suffix}_${w1}`, 4, `half ${s}`, off, 4, suffix));
        cc.push(component(`${suffix}_${w2}`, 4, `half ${s}`, off + 4, 4, suffix));
      }
      break;
    case asmEmptyInterface:
      cc.push(component(`${suffix}_type`, arch.ptrSize, "interface type", off, arch.ptrSize, suffix));
      cc.push(component(`${suffix}_data`, arch.ptrSize, "interface data", off + arch.ptrSize, arch.ptrSize, suffix));
      break;
    case asmInterface:
      cc.push(component(`${suffix}_itable`, arch.ptrSize, "interface itable", off, arch.ptrSize, suffix));
      cc.push(component(`${suffix}_data`, arch.ptrSize, "interface data", off + arch.ptrSize, arch.ptrSize, suffix));
      break;
    case asmSlice:
      cc.push(component(`${suffix}_base`, arch.ptrSize, "slice base", off, arch.ptrSize, suffix));
      cc.push(component(`${suffix}_len`, arch.intSize, "slice len", off + arch.ptrSize, arch.intSize, suffix));
      cc.push(component(`${suffix}_cap`, arch.intSize, "slice cap", off + arch.ptrSize + arch.intSize, arch.intSize, suffix));
      break;
    case asmString:
      cc.push(component(`${suffix}_base`, arch.ptrSize, "string base", off, arch.ptrSize, suffix));
      cc.push(component(`${suffix}_len`, arch.intSize, "string len", off + arch.ptrSize, arch.intSize, suffix));
      break;
    case asmComplex: {
      const fsize = size / 2;
      cc.push(component(`${suffix}_real`, fsize, `real(complex${size * 8})`, off, fsize, suffix));
      cc.push(component(`${suffix}_imag`, fsize, `imag(complex${size * 8})`, off + fsize, fsize, suffix));
      break;
    }
    case asmStruct: {
      const tu = t.underlying() as types.Struct;
      const fields: types.Var[] = [];
      for (let i = 0; i < tu.numFields(); i++) {
        fields.push(tu.field(i)!);
      }
      const offsets = arch.sizes.offsetsof(fields);
      fields.forEach((f, i) => {
        appendComponentsRecursive(arch, f.type()!, cc, `${suffix}_${f.name()}`, off + offsets[i]);
      });
      break;
    }
    case asmArray: {
      const tu = t.underlying() as types.Array;
      const elem = tu.elem()!;
      // Calculate the offset of each element.
      const fields = [types.newField(token.NoPos, null, "fake0", elem, false), types.newField(token.NoPos, null, "fake1", elem, false)];
      const elemoff = arch.sizes.offsetsof(fields)[1];
      for (let i = 0; i < tu.len(); i++) {
        appendComponentsRecursive(arch, elem, cc, `${suffix}_${i}`, off + i * elemoff);
      }
      break;
    }
  }
}

// asmParseDecl parses a function declaration for the expected assembly
// variables on each architecture.
function asmParseDecl(pass: Pass<unknown>, decl: ast.FuncDecl): Map<string, AsmFunc> {
  const m = new Map<string, AsmFunc>();
  for (const arch of arches()) {
    const fn: AsmFunc = { arch, size: 0, vars: new Map(), varByOffset: new Map() };
    let offset = 0;

    // addParams adds variables for each parameter in list, or each result if isret.
    const addParams = (list: readonly (ast.Field | null)[], isret: boolean) => {
      let argnum = 0;
      for (const fld of list) {
        const expr = fld!.type!;
        let t = pass.typesInfo.types.get(expr)?.type ?? null;
        // Work around https://golang.org/issue/28277.
        if (t === null && expr.$type === "Ellipsis") {
          t = types.newSlice(pass.typesInfo.types.get(expr.elt!)?.type ?? null);
        }
        const align = arch.sizes.alignof(t);
        const size = arch.sizes.sizeof(t);
        offset += -offset & (align - 1);
        const cc = componentsOfType(arch, t!);

        // Anonymous parameters are called arg, arg1, arg2, ..., and results ret, ret1, ret2, ...
        let names = fld!.names.map((id) => id!.name);
        if (names.length === 0) {
          const base = isret ? "ret" : "arg";
          names = [argnum > 0 ? `${base}${argnum}` : base];
        }
        argnum += names.length;

        for (const name of names) {
          for (const c of cc) {
            const v: AsmVar = { name: name + c.suffix, kind: c.kind, typ: c.typ, off: offset + c.offset, size: c.size, inner: [] };
            fn.vars.get(name + c.outer)?.inner.push(v);
            fn.vars.set(v.name, v);
            for (let i = 0; i < v.size; i++) {
              fn.varByOffset.set(v.off + i, v);
            }
          }
          offset += size;
        }
      }
    };

    addParams(decl.type!.params!.list, false);
    const results = decl.type!.results;
    if (results !== null && results.list.length > 0) {
      offset += -offset & (arch.maxAlign - 1);
      addParams(results.list, true);
    }
    fn.size = offset;
    m.set(arch.name, fn);
  }
  return m;
}

// asmCheckVar checks a single variable reference.
function asmCheckVar(badf: (message: string) => void, fn: AsmFunc, line: string, expr: string, off: number, v: AsmVar, archDef: AsmArch): void {
  const m = asmOpcode.exec(line);
  if (m === null) {
    if (!line.trim().startsWith("//")) {
      badf("cannot find assembly opcode");
    }
    return;
  }

  let addr = expr.startsWith("$");

  // Determine operand sizes from the instruction. Typically the suffix
  // suffices, but there are exceptions.
  let src: AsmKind = 0;
  let dst: AsmKind = 0;
  let kind: AsmKind;
  const op = m[1];
  switch (`${fn.arch.name}.${op}`) {
    case "386.FMOVLP":
      src = 8;
      dst = 4;
      break;
    case "arm.MOVD":
      src = 8;
      break;
    case "arm.MOVW":
      src = 4;
      break;
    case "arm.MOVH":
    case "arm.MOVHU":
      src = 2;
      break;
    case "arm.MOVB":
    case "arm.MOVBU":
      src = 1;
      break;
    // LEA* opcodes don't really read the second arg; they take its address.
    case "386.LEAL":
      dst = 4;
      addr = true;
      break;
    case "amd64.LEAQ":
      dst = 8;
      addr = true;
      break;
    default:
      src = defaultSrcSize(fn.arch.name, op);
  }
  if (dst === 0) {
    dst = src;
  }

  // Determine whether the match is the first or second argument.
  if (line.indexOf(expr) > line.indexOf(",")) {
    kind = dst;
  } else {
    kind = src;
  }

  let vk = v.kind;
  let vs = v.size;
  let vt = v.typ;
  switch (vk) {
    case asmInterface:
    case asmEmptyInterface:
    case asmString:
    case asmSlice:
      // Allow reference to the first word (pointer).
      vk = v.inner[0].kind;
      vs = v.inner[0].size;
      vt = v.inner[0].typ;
      break;
    case asmComplex:
      // Allow a single instruction to load both parts of a complex.
      if (kind === vs) {
        kind = asmComplex;
      }
      break;
  }
  if (addr) {
    vk = archDef.ptrSize;
    vs = archDef.ptrSize;
    vt = "address";
  }

  if (off !== v.off) {
    let inner = "";
    v.inner.forEach((vi, i) => {
      if (v.inner.length > 1) {
        inner += ",";
      }
      inner += " ";
      if (i === v.inner.length - 1) {
        inner += "or ";
      }
      inner += `${vi.name}+${vi.off}(FP)`;
    });
    badf(`invalid offset ${expr}; expected ${v.name}+${v.off}(FP)${inner}`);
    return;
  }
  if (kind !== 0 && kind !== vk) {
    let inner = "";
    if (v.inner.length > 0) {
      inner += " containing";
      v.inner.forEach((vi, i) => {
        if (i > 0 && v.inner.length > 2) {
          inner += ",";
        }
        inner += " ";
        if (i > 0 && i === v.inner.length - 1) {
          inner += "and ";
        }
        inner += `${vi.name}+${vi.off}(FP)`;
      });
    }
    badf(`invalid ${op} of ${expr}; ${vt} is ${vs}-byte value${inner}`);
  }
}

// defaultSrcSize returns the operand size an opcode implies on an
// architecture, or 0 if unknown.
function defaultSrcSize(arch: string, op: string): AsmKind {
  switch (arch) {
    case "386":
    case "amd64":
      if (op.startsWith("F") && (op.endsWith("D") || op.endsWith("DP"))) {
        // FMOVDP, FXCHD, etc.
        return 8;
      }
      if (op.startsWith("P") && op.endsWith("RD")) {
        // PINSRD, PEXTRD, etc.
        return 4;
      }
      if (op.startsWith("F") && (op.endsWith("F") || op.endsWith("FP"))) {
        // FMOVFP, FXCHF, etc.
        return 4;
      }
      if (op.endsWith("SD")) {
        // MOVSD, SQRTSD, etc.
        return 8;
      }
      if (op.endsWith("SS")) {
        // MOVSS, SQRTSS, etc.
        return 4;
      }
      if (op === "MOVO" || op === "MOVOU") {
        return 16;
      }
      if (op.startsWith("SET")) {
        // SETEQ, etc.
        return 1;
      }
      switch (op[op.length - 1]) {
        case "B":
          return 1;
        case "W":
          return 2;
        case "L":
          return 4;
        case "D":
        case "Q":
          return 8;
      }
      return 0;
    case "ppc64":
    case "ppc64le": {
      // Strip standard suffixes to reveal the size letter.
      const m = ppc64Suff.exec(op);
      switch (m?.[1]) {
        case "B":
          return 1;
        case "H":
          return 2;
        case "W":
          return 4;
        case "D":
          return 8;
      }
      return 0;
    }
    case "loong64":
    case "mips":
    case "mipsle":
    case "mips64":
    case "mips64le":
      switch (op) {
        case "MOVB":
        case "MOVBU":
          return 1;
        case "MOVH":
        case "MOVHU":
          return 2;
        case "MOVW":
        case "MOVWU":
        case "MOVF":
          return 4;
        case "MOVV":
        case "MOVD":
          return 8;
      }
      return 0;
    case "s390x":
      switch (op) {
        case "MOVB":
        case "MOVBZ":
          return 1;
        case "MOVH":
        case "MOVHZ":
          return 2;
        case "MOVW":
        case "MOVWZ":
        case "FMOVS":
          return 4;
        case "MOVD":
        case "FMOVD":
          return 8;
      }
      return 0;
  }
  return 0;
}

// atoi parses s as strconv.Atoi does, returning 0 when it is not a number.
function atoi(s: string | undefined): number {
  return s !== undefined && /^[+-]?[0-9]+$/.test(s) ? Number.parseInt(s, 10) : 0;
}

// readFile reads a non-Go file and adds it to the file set, as upstream's
// analyzerutil.ReadFile does, so findings can point into it.
function readFile(pass: Pass<unknown>, filename: string): [content: string, file: token.File] {
  const content = pass.readFile(filename);
  const tf = pass.fset.addFile(filename, -1, byteLength(content));
  if (tf === null) {
    throw new Error(`cannot add ${filename} to the file set`);
  }
  tf.setLinesForContent(content);
  return [content, tf];
}

// splitAfterNewline splits s after each newline, as strings.SplitAfter does.
function splitAfterNewline(s: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", start)) {
    lines.push(s.slice(start, i + 1));
    start = i + 1;
  }
  lines.push(s.slice(start));
  return lines;
}
