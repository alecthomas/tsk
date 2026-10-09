import * as ast from "go/ast";
import type * as types from "go/types";
import { defineAnalyzer, formatNode, type Pass } from "tsk";

interface Pattern {
  /** A regular expression matching forbidden identifiers, as `^fmt\.Errorf$`. */
  pattern: string;
  /** A regular expression the identifier's package path must match; needs analyze-types. */
  pkg?: string;
  /** Explains the prohibition in the message. */
  msg?: string;
}

interface Config {
  /** Forbidden identifiers. With none, fmt.Print, fmt.Printf, fmt.Println, print, and println. */
  forbid: Pattern[];
  /** Skip Godoc examples, which may print. */
  excludeGodocExamples: boolean;
  /** Match identifiers by package and type, as `fmt.Errorf` for an aliased import or `pkg.Type.Method` for a method. */
  analyzeTypes: boolean;
}

interface Compiled {
  re: RegExp;
  source: string;
  pkg: RegExp | null;
  msg: string;
}

const defaultPattern = String.raw`^(fmt\.Print(|f|ln)|print|println)$`;

export default defineAnalyzer<Config>({
  name: "forbidigo",
  doc: `forbid identifiers

Reports identifiers matching any forbidden pattern. Declared names, such as
those of functions, types, and fields, are not checked, only uses.`,
  config: { forbid: [], excludeGodocExamples: true, analyzeTypes: false },
  run(pass) {
    const patterns = (pass.config.forbid.length === 0 ? [{ pattern: defaultPattern }] : pass.config.forbid).map(compile);
    for (const file of pass.files) {
      const isTest = pass.fset.position(file.pos()).filename.endsWith("_test.go");
      if (pass.config.excludeGodocExamples && isTest && isWholeFileExample(file)) {
        continue;
      }
      new Visitor(pass, patterns, isTest).walk(file);
    }
  },
});

function compile(p: Readonly<Pattern>): Compiled {
  return { re: new RegExp(p.pattern), source: p.pattern, pkg: p.pkg ? new RegExp(p.pkg) : null, msg: commentIn(p.pattern) || (p.msg ?? "") };
}

// commentIn returns the message a pattern carries in a (# message) group,
// as upstream reads it from the parsed expression.
function commentIn(pattern: string): string {
  const match = /\(#([^)]*)\)/.exec(pattern);
  return match === null ? "" : match[1].trim();
}

// isWholeFileExample reports whether a test file is a whole-file Godoc
// example: one example function, no tests or benchmarks, and other declarations.
function isWholeFileExample(file: ast.File): boolean {
  if (file.decls.length <= 1) {
    return false;
  }
  let examples = 0;
  for (const decl of file.decls) {
    if (decl?.$type !== "FuncDecl" || decl.recv !== null || decl.name === null) {
      continue;
    }
    const name = decl.name.name;
    if (name.startsWith("Test") || name.startsWith("Benchmark")) {
      return false;
    }
    if (name.startsWith("Example")) {
      examples++;
    }
  }
  return examples === 1;
}

class Visitor {
  constructor(
    private readonly pass: Pass<Config>,
    private readonly patterns: Compiled[],
    private readonly isTest: boolean,
  ) {}

  walk(node: ast.Node | null): void {
    if (node === null) {
      return;
    }
    ast.inspect(node, (n) => (n === null ? false : this.visit(n)));
  }

  // visit checks a node and reports whether to descend into its children.
  // Declared names are skipped by walking only the parts that use names.
  private visit(node: ast.Node): boolean {
    switch (node.$type) {
      case "FuncDecl":
        if (this.pass.config.excludeGodocExamples && this.isTest && node.recv === null && node.name?.name.startsWith("Example")) {
          return false;
        }
        this.walk(node.type);
        this.walk(node.body);
        return false;
      case "ValueSpec":
        this.walk(node.type);
        node.values.forEach((value) => {
          this.walk(value);
        });
        return false;
      case "ImportSpec":
        return false;
      case "TypeSpec":
        this.walk(node.typeParams);
        this.walk(node.type);
        return false;
      case "Field":
        this.walk(node.type);
        return false;
      case "SelectorExpr":
      case "Ident":
        this.check(node);
        // Descend into a selector's left side unless it is an identifier.
        return node.$type === "SelectorExpr" && node.x?.$type !== "Ident";
    }
    return true;
  }

  private check(node: ast.SelectorExpr | ast.Ident): void {
    const text = formatNode(node, this.pass.fset);
    const [matchTexts, pkg] = this.pass.config.analyzeTypes ? this.expand(node, text) : [[text], ""];
    for (const p of this.patterns) {
      if (matchTexts.some((t) => p.re.test(t)) && (p.pkg === null || p.pkg.test(pkg))) {
        const explanation = p.msg === "" ? ` by pattern \`${p.source}\`` : ` because ${JSON.stringify(p.msg)}`;
        this.pass.report({ pos: node.pos(), message: `use of \`${text}\` forbidden${explanation}` });
      }
    }
  }

  // expand returns the texts to match a use against, qualified by package
  // and type, and the package path, as pkg.Function or pkg.Type.Method.
  private expand(node: ast.SelectorExpr | ast.Ident, text: string): [string[], string] {
    const info = this.pass.typesInfo;
    if (node.$type === "Ident") {
      const object = info.uses.get(node);
      const pkg = object?.pkg() ?? null;
      if (object == null || pkg === null) {
        return [[text], ""];
      }
      const t = object.type();
      const isMethod = t?.$type === "Signature" && t.recv() !== null;
      return [isMethod ? [text] : [`${pkg.name()}.${text}`, text], pkg.path()];
    }
    const field = node.sel!.name;
    let matchTexts = [text];
    let pkg = "";
    const tv = info.types.get(node.x!);
    if (tv !== undefined) {
      const named = typeNameWithPackage(tv.type);
      matchTexts = named === null ? [] : [`${named[0]}.${field}`];
      pkg = named?.[1] ?? "";
    }
    if (node.x?.$type === "Ident") {
      const object = info.uses.get(node.x);
      if (object?.$type === "PkgName") {
        pkg = object.imported()!.path();
        matchTexts = [`${object.imported()!.name()}.${field}`];
      } else if (object?.$type === "Var") {
        const named = typeNameWithPackage(object.type());
        matchTexts = named === null ? [] : [`${named[0]}.${field}`];
        pkg = named?.[1] ?? pkg;
      }
    }
    return [matchTexts, pkg];
  }
}

// typeNameWithPackage returns a selector operand's type as pkg.Type, and its
// package path, through a pointer or alias.
function typeNameWithPackage(t: types.Type | null): [string, string] | null {
  if (t?.$type === "Pointer") {
    t = t.elem();
  }
  if (t?.$type === "Alias") {
    return typeNameWithPackage(t.rhs());
  }
  if (t?.$type !== "Named") {
    return null;
  }
  const object = t.obj()!;
  const pkg = object.pkg();
  return pkg === null ? [object.name(), ""] : [`${pkg.name()}.${object.name()}`, pkg.path()];
}
