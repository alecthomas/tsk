// Port of golang.org/x/tools/go/analysis/passes/framepointer at v0.50.0.
import type * as token from "go/token";
import { defineAnalyzer, goarch, goos, type Pass } from "tsk";
import { byteLength } from "./internal/utf8";

// Per-architecture checks for instructions, with comments and surrounding
// spaces already removed.
interface Arch {
  isFPWrite(s: string): boolean;
  isFPRead(s: string): boolean;
  isUnconditionalBranch(s: string): boolean;
}

const pairWrites = ["LDP", "LDAXP", "LDXP", "CASP"];

const arches = new Map<string, Arch>([
  [
    "amd64",
    {
      isFPWrite: (s) => /,\s*BP$/.test(s),
      isFPRead: (s) => /\bBP\b/.test(s),
      isUnconditionalBranch: (s) => s.startsWith("JMP") || s.startsWith("RET"),
    },
  ],
  [
    "arm64",
    {
      isFPWrite: (s) => {
        const i = s.lastIndexOf(",");
        if (i > 0 && s.slice(i).endsWith("R29")) {
          return true;
        }
        if (pairWrites.some((p) => s.startsWith(p))) {
          // Instructions writing a pair of registers, e.g. LDP 8(R0), (R26, R29).
          const lp = s.lastIndexOf("(");
          const rp = s.lastIndexOf(")");
          if (lp > -1 && lp < rp) {
            const operand = s.slice(lp, rp);
            return operand.includes(",") && operand.includes("R29");
          }
        }
        return false;
      },
      isFPRead: (s) => /\bR29\b/.test(s),
      isUnconditionalBranch: (s) => {
        const i = s.search(/\s/);
        const op = i > 0 ? s.slice(0, i) : s;
        return op === "B" || op === "JMP" || op === "RET";
      },
    },
  ],
]);

export default defineAnalyzer({
  name: "framepointer",
  doc: "report assembly that clobbers the frame pointer before saving it",
  group: "govet",
  run(pass) {
    const arch = arches.get(goarch());
    if (arch === undefined || (goos() !== "linux" && goos() !== "darwin")) {
      return;
    }
    if (pass.pkg.path() === "runtime") {
      return;
    }
    for (const fname of pass.otherFiles) {
      if (fname.endsWith(".s")) {
        checkFile(pass, arch, fname);
      }
    }
  },
});

function checkFile(pass: Pass<unknown>, arch: Arch, fname: string): void {
  const [content, tf] = readFile(pass, fname);
  let active = false;
  content.split("\n").forEach((raw, i) => {
    // Ignore comments and commented-out code.
    const c = raw.indexOf("//");
    const line = (c >= 0 ? raw.slice(0, c) : raw).trim();
    if (line === "") {
      return;
    }
    // Checking starts at the TEXT line of a frameless function.
    if (line.startsWith("TEXT") && line.includes("(SB)") && line.includes("$0")) {
      active = true;
      return;
    }
    if (!active) {
      return;
    }
    if (arch.isFPWrite(line)) {
      pass.report({ pos: tf.lineStart(i + 1), message: "frame pointer is clobbered before saving" });
      active = false;
    } else if (arch.isFPRead(line) || arch.isUnconditionalBranch(line)) {
      active = false;
    }
  });
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
