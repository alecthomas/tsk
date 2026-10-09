import type * as ast from "go/ast";
import type * as token from "go/token";
import { defineAnalyzer, type Pass } from "tsk";

interface Config {
  /**
   * Which comments to check: "declarations", top-level declaration docs and
   * comments in top-level blocks; "toplevel", every top-level comment;
   * "noinline", every comment not after code; or "all".
   */
  scope: "declarations" | "toplevel" | "noinline" | "all";
  /** Regular expressions of comment lines to skip. */
  exclude: string[];
  /** Check that the last sentence ends in a period. */
  period: boolean;
  /** Check that each sentence starts with a capital letter. */
  capital: boolean;
}

// Comment is a comment group with the source lines it spans.
interface Comment {
  // lines are the whole source lines, shared by checks so fixes combine.
  lines: string[];
  // text is the comment's text, special lines replaced by specialReplacer.
  text: string;
  start: token.Position;
  decl: boolean;
}

const specialReplacer = "<godotSpecialReplacer>";
const lastChars = [".", "?", "!", ".)", "?)", "!)", "。", "？", "！", "。）", "？）", "！）", specialReplacer];
const abbreviations = ["i.e.", "i. e.", "e.g.", "e. g.", "etc.", "I.e.", "I. e.", "E.g.", "E. g.", "Etc.", "I.E.", "I. E.", "E.G.", "E. G.", "ETC."];
const tags = /^\+?[a-z0-9-]+:/;
const hashtags = /^#[a-z]+($|\s)/;
const endURL = /[a-z]+:\/\/[^\s]+$/;

export default defineAnalyzer<Config>({
  name: "godot",
  doc: `check if comments end in a period

Checks that the last sentence of each comment in scope ends in a period, and
optionally that sentences start with a capital letter. Indented lines, tags
such as //nolint:, and lines ending in URLs are skipped.`,
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: { scope: "declarations", exclude: [], period: true, capital: false },
  run(pass) {
    const exclude = pass.config.exclude.map((pattern) => new RegExp(pattern));
    for (const file of pass.files) {
      if (file.comments.length === 0) {
        continue;
      }
      const tokenFile = pass.fset.file(file.pos())!;
      if (!tokenFile.name().endsWith(".go")) {
        continue;
      }
      const lines = pass.readFile(tokenFile.name()).split("\n");
      const issues: { line: number; message: string; replacement: string }[] = [];
      for (const comment of comments(pass, file, lines, exclude)) {
        if (pass.config.period) {
          const issue = checkPeriod(comment);
          if (issue !== null) {
            issues.push(issue);
          }
        }
        if (pass.config.capital) {
          issues.push(...checkCapital(comment));
        }
      }
      issues.sort((a, b) => a.line - b.line);
      for (const issue of issues) {
        const start = tokenFile.lineStart(issue.line);
        const end = start + utf8Length(lines[issue.line - 1]);
        pass.report({
          pos: start,
          end,
          message: issue.message,
          suggestedFixes: [{ message: "", textEdits: [{ pos: start, end, newText: issue.replacement }] }],
        });
      }
    }
  },
});

function comments(pass: Pass<Config>, file: ast.File, lines: string[], exclude: RegExp[]): Comment[] {
  const make = (group: ast.CommentGroup): Comment | null => {
    const first = pass.fset.position(group.pos());
    const last = pass.fset.position(group.end()).line;
    if (first.line < 1 || last < first.line || last > lines.length) {
      // The //line directive broke the positions.
      return null;
    }
    const start = pass.fset.position(group.list[0]!.slash);
    return { lines: lines.slice(first.line - 1, last), text: textOf(group, exclude), start, decl: false };
  };
  const all = file.comments.filter((group) => group!.list.length > 0).map((group) => group!);
  const declarations = file.decls
    .map((decl) => (decl?.$type === "GenDecl" || decl?.$type === "FuncDecl" ? decl.doc : null))
    .filter((doc): doc is ast.CommentGroup => doc !== null && doc.list.length > 0)
    .map(make)
    .filter((c): c is Comment => c !== null);
  let result: Comment[];
  switch (pass.config.scope) {
    case "all":
      result = all.map(make).filter((c): c is Comment => c !== null);
      break;
    case "noinline":
      result = all.map(make).filter((c): c is Comment => c !== null && !(c.lines.length === 1 && byteSlice(c.lines[0], c.start.column - 1).trim() !== ""));
      break;
    case "toplevel":
      result = [
        ...blockComments(pass, file, all, make),
        ...all
          .filter((g) => pass.fset.position(g.pos()).column === 1)
          .map(make)
          .filter((c): c is Comment => c !== null),
      ];
      break;
    default:
      result = [...blockComments(pass, file, all, make), ...declarations];
  }
  for (const d of declarations) {
    const match = result.find((c) => c.start.offset === d.start.offset);
    if (match !== undefined) {
      match.decl = true;
    }
  }
  return result;
}

// blockComments returns the comments at the top level of var (...), const
// (...), and other parenthesised top-level blocks.
function blockComments(pass: Pass<Config>, file: ast.File, all: ast.CommentGroup[], make: (g: ast.CommentGroup) => Comment | null): Comment[] {
  const result: Comment[] = [];
  for (const decl of file.decls) {
    if (decl?.$type !== "GenDecl" || decl.lparen === 0) {
      continue;
    }
    for (const group of all) {
      if (decl.lparen > group.pos() || group.pos() > decl.rparen || pass.fset.position(group.pos()).column !== 2) {
        continue;
      }
      const comment = make(group);
      if (comment !== null) {
        result.push(comment);
      }
    }
  }
  return result;
}

// textOf extracts a comment group's text, replacing special lines, such as
// indented code and tags, with specialReplacer.
function textOf(group: ast.CommentGroup, exclude: RegExp[]): string {
  const first = group.list[0]!.text;
  if (isSpecialBlock(first)) {
    return "";
  }
  const out: string[] = [];
  for (const c of group.list) {
    let text = c!.text;
    const isBlock = text.startsWith("/*");
    if (isBlock) {
      text = text.replace(/^\/\*/, "").replace(/\*\/$/, "");
    }
    for (let line of text.split("\n")) {
      if (isSpecialLine(line)) {
        out.push(specialReplacer);
        continue;
      }
      if (!isBlock) {
        line = line.replace(/^\/\//, "");
      }
      out.push(exclude.some((re) => re.test(line)) ? specialReplacer : line);
    }
  }
  return out.join("\n");
}

function isSpecialBlock(comment: string): boolean {
  if (comment.startsWith("/*") && (comment.includes("#include") || comment.includes("#define"))) {
    return true;
  }
  return comment.startsWith("// Output:") || comment.startsWith("// Unordered output:");
}

function isSpecialLine(comment: string): boolean {
  if (comment.startsWith("//export ")) {
    return true;
  }
  comment = comment.replace(/^\/\//, "").replace(/^\/\*/, "");
  // Indented lines may be code examples.
  if (comment.startsWith("  ") || comment.startsWith(" \t") || comment.startsWith("\t")) {
    return true;
  }
  comment = comment.trim();
  return tags.test(comment) || hashtags.test(comment) || endURL.test(comment) || comment.startsWith("+build");
}

function checkPeriod(c: Comment): { line: number; message: string; replacement: string } | null {
  const lines = c.text.split("\n");
  if (!lines.some((line) => /\p{L}/u.test(line))) {
    return null;
  }
  let index = lines.length - 1;
  while (index >= 0 && lines[index].trimEnd() === "") {
    index--;
  }
  if (index < 0) {
    return null;
  }
  const line = lines[index].trimEnd();
  if (lastChars.some((suffix) => line.endsWith(suffix))) {
    return null;
  }
  // The text lacks the comment markers and indentation of the source line.
  const column = line.length + c.lines[index].indexOf(lines[index]);
  const original = c.lines[index];
  if (original.length < column) {
    return null;
  }
  const replacement = `${original.slice(0, column)}.${original.slice(column)}`;
  c.lines[index] = replacement;
  return { line: c.start.line + index, message: "Comment should end in a period", replacement };
}

function checkCapital(c: Comment): { line: number; message: string; replacement: string }[] {
  let text = c.text;
  for (const abbreviation of abbreviations) {
    text = text.split(abbreviation).join(abbreviation.split(".").join("_"));
  }
  const empty = 1;
  const endChar = 2;
  const endOfSentence = 3;
  // A declaration's doc starts with its name, which may be lower case.
  let state = c.decl ? empty : endOfSentence;
  const found: { line: number; column: number }[] = [];
  let line = 1;
  let column = 0;
  for (const char of text) {
    column++;
    if (char === "\n") {
      line++;
      column = 0;
      if (state === endChar) {
        state = endOfSentence;
      }
      continue;
    }
    if (char === "." || char === "!" || char === "?") {
      state = endChar;
      continue;
    }
    if (char === ")" && state === endChar) {
      continue;
    }
    if (char === " ") {
      if (state === endChar) {
        state = endOfSentence;
      }
      continue;
    }
    if (state === endOfSentence && /\p{Ll}/u.test(char)) {
      found.push({ line, column });
    }
    state = empty;
  }
  const isBlock = c.lines[0].startsWith("/*");
  const startColumn = byteIndex(c.lines[0], c.start.column - 1);
  const issues: { line: number; message: string; replacement: string }[] = [];
  for (const position of found) {
    const original = c.lines[position.line - 1];
    // The column counts characters of the text, which lacks the markers.
    let index = [...original].slice(0, position.column - 1).join("").length;
    if ((isBlock && position.line === 1) || !isBlock) {
      index += 2;
    }
    index += startColumn;
    if (index >= original.length) {
      continue;
    }
    const replacement = original.slice(0, index) + original[index].toUpperCase() + original.slice(index + 1);
    c.lines[position.line - 1] = replacement;
    issues.push({ line: c.start.line + position.line - 1, message: "Sentence should start with a capital letter", replacement });
  }
  return issues;
}

// byteIndex converts a UTF-8 byte offset in a line to a string index.
function byteIndex(line: string, bytes: number): number {
  let count = 0;
  let index = 0;
  for (const char of line) {
    if (count >= bytes) {
      break;
    }
    count += utf8Length(char);
    index += char.length;
  }
  return index;
}

// byteSlice returns the start of a line up to a UTF-8 byte offset.
function byteSlice(line: string, bytes: number): string {
  return line.slice(0, byteIndex(line, bytes));
}

function utf8Length(text: string): number {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return length;
}
