import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer, type Pass } from "tsk";

type Rule = "pkg-doc" | "single-pkg-doc" | "require-pkg-doc" | "start-with-name" | "require-doc" | "deprecated" | "no-unused-link";

interface Config {
  /** The rules on before enable and disable apply: "basic", "all", or "none". */
  default: "basic" | "all" | "none";
  /** Rules to turn on. */
  enable: Rule[];
  /** Rules to turn off. */
  disable: Rule[];
  options: {
    requireDoc: {
      /** Do not require docs on exported symbols. */
      ignoreExported: boolean;
      /** Do not require docs on unexported symbols. */
      ignoreUnexported: boolean;
    };
    startWithName: {
      /** Also check unexported symbols' docs. */
      includeUnexported: boolean;
    };
  };
}

const allRules: Rule[] = ["pkg-doc", "single-pkg-doc", "require-pkg-doc", "start-with-name", "require-doc", "deprecated", "no-unused-link"];
const basicRules: Rule[] = ["pkg-doc", "single-pkg-doc", "start-with-name", "deprecated"];

// includeTests is whether each rule checks test files, as golangci-lint fixes it.
const includeTests: Record<Rule, boolean> = {
  "pkg-doc": false,
  "single-pkg-doc": true,
  "require-pkg-doc": false,
  "start-with-name": false,
  "require-doc": true,
  deprecated: false,
  "no-unused-link": true,
};

interface Disabled {
  all: boolean;
  rules: Set<string>;
}

interface Doc {
  group: ast.CommentGroup;
  text: string;
  disabled: Disabled;
}

type Kind = "func" | "const" | "var" | "type" | "bad";

interface Symbol {
  kind: Kind;
  name: string;
  ident: ast.Ident | null;
  isMethod: boolean;
  receiver: string;
  doc: Doc | null;
  trailingDoc: Doc | null;
  parentDoc: Doc | null;
  multiName: boolean;
}

interface FileInfo {
  file: ast.File;
  isTest: boolean;
  disabled: Disabled;
  packageDoc: Doc | null;
  symbols: Symbol[];
}

export default defineAnalyzer<Config>({
  name: "godoclint",
  doc: `check Go documentation practice

Checks that package docs start with "Package <name>", that a package has
one doc, that symbol docs start with the symbol's name, and that deprecation
notes read "Deprecated: ". Optional rules require docs and report unused
link definitions. //godoclint:disable [rules...] in a doc, or a top-level
comment, turns rules off. The max-len and require-stdlib-doclink rules are
not supported.`,
  url: "https://github.com/godoc-lint/godoc-lint",
  config: {
    default: "basic",
    enable: [],
    disable: [],
    options: { requireDoc: { ignoreExported: false, ignoreUnexported: true }, startWithName: { includeUnexported: false } },
  },
  run(pass) {
    const base = pass.config.default === "all" ? allRules : pass.config.default === "none" ? [] : basicRules;
    const rules = new Set<Rule>([...base, ...pass.config.enable].filter((rule) => !pass.config.disable.includes(rule)));
    const files = pass.files.map((file) => inspectFile(pass, file));
    const applicable = (rule: Rule) => files.filter((f) => (includeTests[rule] || !f.isTest) && !f.disabled.all && !f.disabled.rules.has(rule));
    if (rules.has("pkg-doc")) {
      checkPkgDoc(pass, applicable("pkg-doc"));
    }
    if (rules.has("single-pkg-doc")) {
      checkSinglePkgDoc(pass, applicable("single-pkg-doc"));
    }
    if (rules.has("require-pkg-doc")) {
      checkRequirePkgDoc(pass, applicable("require-pkg-doc"));
    }
    if (rules.has("start-with-name")) {
      checkStartWithName(pass, applicable("start-with-name"));
    }
    if (rules.has("require-doc")) {
      checkRequireDoc(pass, applicable("require-doc"));
    }
    if (rules.has("deprecated")) {
      checkDocs(applicable("deprecated"), true, (doc) => checkDeprecation(pass, doc));
    }
    if (rules.has("no-unused-link")) {
      checkDocs(applicable("no-unused-link"), false, (doc) => checkUnusedLinks(pass, doc));
    }
  },
});

const orphanCommentGroups = /(?:^\/\/.*\r?\n)+(?:\r?\n|$)/gm;
const disableDirective = /\/\/godoclint:disable(?: *([^\r\n]+))?\r?$/gm;

function disabledIn(text: string): Disabled {
  const disabled: Disabled = { all: false, rules: new Set() };
  for (const match of text.matchAll(disableDirective)) {
    if (match[1] === undefined || match[1] === "") {
      disabled.all = true;
      continue;
    }
    for (const name of match[1].trim().split(" ")) {
      if ((allRules as string[]).includes(name)) {
        disabled.rules.add(name);
      }
    }
  }
  return disabled;
}

function docOf(group: ast.CommentGroup | null): Doc | null {
  if (group === null) {
    return null;
  }
  return { group, text: group.text(), disabled: disabledIn(group.list.map((c) => c!.text).join("\n")) };
}

// inspectFile collects a file's package doc, top-level directives, and
// top-level symbol declarations with their docs.
function inspectFile(pass: Pass<Config>, file: ast.File): FileInfo {
  const filename = pass.fset.file(file.pos())!.name();
  const disabled: Disabled = { all: false, rules: new Set() };
  for (const match of pass.readFile(filename).matchAll(orphanCommentGroups)) {
    const found = disabledIn(match[0]);
    disabled.all = disabled.all || found.all;
    for (const rule of found.rules) {
      disabled.rules.add(rule);
    }
  }
  const symbols: Symbol[] = [];
  const add = (symbol: Partial<Symbol> & { kind: Kind }) =>
    symbols.push({ name: "", ident: null, isMethod: false, receiver: "", doc: null, trailingDoc: null, parentDoc: null, multiName: false, ...symbol });
  for (const decl of file.decls) {
    if (decl?.$type === "FuncDecl") {
      const recv = decl.recv?.list[0];
      add({
        kind: "func",
        name: decl.name!.name,
        ident: decl.name,
        isMethod: decl.recv !== null,
        receiver: recv ? receiverName(recv.type) : "",
        doc: docOf(decl.doc),
      });
    } else if (decl?.$type === "BadDecl") {
      add({ kind: "bad" });
    } else if (decl?.$type === "GenDecl" && (decl.tok === token.CONST || decl.tok === token.VAR || decl.tok === token.TYPE)) {
      const grouped = decl.lparen !== token.NoPos;
      const parentDoc = grouped ? docOf(decl.doc) : null;
      for (const spec of decl.specs) {
        if (spec?.$type === "TypeSpec") {
          add({
            kind: "type",
            name: spec.name!.name,
            ident: spec.name,
            doc: docOf(grouped ? spec.doc : decl.doc),
            trailingDoc: docOf(spec.comment),
            parentDoc,
          });
        } else if (spec?.$type === "ValueSpec") {
          const kind = decl.tok === token.CONST ? "const" : "var";
          for (const name of spec.names) {
            add({
              kind,
              name: name!.name,
              ident: name,
              doc: docOf(grouped ? spec.doc : decl.doc),
              trailingDoc: docOf(spec.comment),
              parentDoc,
              multiName: spec.names.length > 1,
            });
          }
        }
      }
    }
  }
  return { file, isTest: filename.endsWith("_test.go"), disabled, packageDoc: docOf(file.doc), symbols };
}

function receiverName(expr: ast.Expr | null): string {
  switch (expr?.$type) {
    case "Ident":
      return expr.name;
    case "StarExpr":
    case "IndexExpr":
    case "IndexListExpr":
      return receiverName(expr.x);
  }
  return "";
}

function isDisabled(doc: Doc, rule: Rule): boolean {
  return doc.disabled.all || doc.disabled.rules.has(rule);
}

function checkPkgDoc(pass: Pass<Config>, files: FileInfo[]): void {
  for (const f of files) {
    const doc = f.packageDoc;
    const name = f.file.name!.name;
    if (doc === null || isDisabled(doc, "pkg-doc") || name === "main" || name === "main_test" || doc.text === "" || hasDeprecatedParagraph(doc.text)) {
      continue;
    }
    const prefix = `Package ${name}`;
    const rest = doc.text.slice(prefix.length);
    if (!doc.text.startsWith(prefix) || !(rest === "" || /^[ \t\r\n]/.test(rest))) {
      pass.report({ pos: doc.group.pos(), message: `package godoc should start with ${JSON.stringify(`${prefix} `)}` });
    }
  }
}

function checkSinglePkgDoc(pass: Pass<Config>, files: FileInfo[]): void {
  const documented = new Map<string, FileInfo[]>();
  for (const f of files) {
    const doc = f.packageDoc;
    if (doc !== null && doc.text !== "" && !isDisabled(doc, "single-pkg-doc")) {
      const name = f.file.name!.name;
      documented.set(name, [...(documented.get(name) ?? []), f]);
    }
  }
  for (const [name, fs] of documented) {
    if (fs.length >= 2) {
      for (const f of fs) {
        pass.report({ pos: f.packageDoc!.group.pos(), message: `package has more than one godoc (${JSON.stringify(name)})` });
      }
    }
  }
}

function checkRequirePkgDoc(pass: Pass<Config>, files: FileInfo[]): void {
  const byPackage = new Map<string, FileInfo[]>();
  for (const f of files) {
    const name = f.file.name!.name;
    byPackage.set(name, [...(byPackage.get(name) ?? []), f]);
  }
  for (const [name, fs] of byPackage) {
    const documented = fs.some((f) => f.packageDoc !== null && f.packageDoc.text !== "" && !isDisabled(f.packageDoc, "require-pkg-doc"));
    if (!documented) {
      pass.report({ pos: fs[0].file.name!.pos(), message: `package should have a godoc (${JSON.stringify(name)})` });
    }
  }
}

function isExportedSymbol(symbol: Symbol): boolean {
  return ast.isExported(symbol.name) && (!symbol.isMethod || symbol.receiver === "" || ast.isExported(symbol.receiver));
}

const startPattern = /^(?:(A|a|AN|An|an|THE|The|the) )?(.+?)\b/;

function checkStartWithName(pass: Pass<Config>, files: FileInfo[]): void {
  const includeUnexported = pass.config.options.startWithName.includeUnexported;
  for (const f of files) {
    for (const symbol of f.symbols) {
      const doc = symbol.doc;
      if (!isExportedSymbol(symbol) && !includeUnexported) {
        continue;
      }
      if (symbol.name === "_" || symbol.kind === "bad" || doc === null || doc.text === "" || isDisabled(doc, "start-with-name") || symbol.multiName) {
        continue;
      }
      if (hasDeprecatedParagraph(doc.text) || startsWithName(doc.text, symbol.name)) {
        continue;
      }
      pass.report({ pos: doc.group.pos(), end: doc.group.end(), message: `godoc should start with symbol name (${JSON.stringify(symbol.name)})` });
    }
  }
}

function startsWithName(text: string, name: string): boolean {
  const head = text.split("\n")[0].replace(/^\r/, "").split(" ")[0].split("\t")[0];
  return head === name || startPattern.exec(text)?.[2] === name;
}

function checkRequireDoc(pass: Pass<Config>, files: FileInfo[]): void {
  const requireExported = !pass.config.options.requireDoc.ignoreExported;
  const requireUnexported = !pass.config.options.requireDoc.ignoreUnexported;
  for (const f of files) {
    for (const symbol of f.symbols) {
      const exported = isExportedSymbol(symbol);
      if ((exported && !requireExported) || (!exported && !requireUnexported) || symbol.name === "_" || symbol.kind === "bad") {
        continue;
      }
      if (symbol.doc !== null && isDisabled(symbol.doc, "require-doc")) {
        continue;
      }
      const has = (doc: Doc | null) => doc !== null && doc.text !== "";
      const documented = symbol.kind === "func" ? has(symbol.doc) : has(symbol.doc) || has(symbol.trailingDoc) || has(symbol.parentDoc);
      if (!documented) {
        const ident = symbol.ident!;
        pass.report({ pos: ident.pos(), end: ident.end(), message: `symbol should have a godoc (${JSON.stringify(ident.name)})` });
      }
    }
  }
}

// checkDocs runs a check on each distinct doc of the files: package docs and
// symbol docs, and with exportedOnly only those of exported symbols.
function checkDocs(files: FileInfo[], exportedOnly: boolean, check: (doc: Doc) => void): void {
  const docs = new Set<ast.CommentGroup>();
  const visit = (doc: Doc | null) => {
    if (doc !== null && !docs.has(doc.group)) {
      docs.add(doc.group);
      check(doc);
    }
  };
  for (const f of files) {
    visit(f.packageDoc);
    for (const symbol of f.symbols) {
      if (!exportedOnly || ast.isExported(symbol.name)) {
        visit(symbol.parentDoc);
        visit(symbol.doc);
      }
    }
  }
}

function checkDeprecation(pass: Pass<Config>, doc: Doc): void {
  if (isDisabled(doc, "deprecated")) {
    return;
  }
  for (const paragraph of paragraphs(doc.text)) {
    const match = /^deprecated:.?/i.exec(paragraph);
    if (match !== null && match[0] !== "Deprecated: ") {
      pass.report({ pos: doc.group.pos(), end: doc.group.end(), message: `deprecation note should be formatted as "Deprecated: "` });
      return;
    }
  }
}

function checkUnusedLinks(pass: Pass<Config>, doc: Doc): void {
  if (isDisabled(doc, "no-unused-link") || doc.text === "") {
    return;
  }
  const { definitions, text } = splitLinks(doc.text);
  for (const name of definitions) {
    if (!text.includes(`[${name}]`)) {
      pass.report({ pos: doc.group.pos(), end: doc.group.end(), message: `godoc has unused link (${JSON.stringify(name)})` });
    }
  }
}

// blocks splits doc text into go/doc/comment's blocks: runs of lines between
// blank lines, with indented lines forming code blocks.
function blocks(text: string): { lines: string[]; code: boolean }[] {
  const result: { lines: string[]; code: boolean }[] = [];
  let current: { lines: string[]; code: boolean } | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      current = null;
      continue;
    }
    const code = /^[ \t]/.test(line);
    if (current === null || current.code !== code) {
      current = { lines: [], code };
      result.push(current);
    }
    current.lines.push(line);
  }
  return result;
}

const linkDefinition = /^\[([^\]]+)\]:\s+(\S+)\s*$/;

// isList reports whether an indented block is a list, whose text may use
// links, rather than code.
function isList(lines: string[]): boolean {
  return /^[ \t]+([-*+•]|\d+[.)])[ \t]/.test(lines[0]);
}

// splitLinks separates link definitions, blocks of [Text]: URL lines, from
// the text that may refer to them.
function splitLinks(text: string): { definitions: string[]; text: string } {
  const definitions: string[] = [];
  const rest: string[] = [];
  for (const block of blocks(text)) {
    if (!block.code && block.lines.every((line) => linkDefinition.test(line))) {
      definitions.push(...block.lines.map((line) => linkDefinition.exec(line)![1]));
    } else if (!block.code || isList(block.lines)) {
      rest.push(...block.lines);
    }
  }
  return { definitions, text: rest.join("\n") };
}

// paragraphs returns the text of each paragraph, leaving out code blocks,
// headings, and link definitions.
function paragraphs(text: string): string[] {
  return blocks(text)
    .filter((block) => !block.code && !(block.lines.length === 1 && /^# \S/.test(block.lines[0])) && !block.lines.every((line) => linkDefinition.test(line)))
    .map((block) => block.lines.join("\n"));
}

function hasDeprecatedParagraph(text: string): boolean {
  return paragraphs(text).some((paragraph) => paragraph.startsWith("Deprecated: "));
}
