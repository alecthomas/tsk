import * as ast from "go/ast";
import * as build from "go/build";
import * as parser from "go/parser";
import * as token from "go/token";

export type Directive = "ignore" | "enforce" | "optional";

// Optionality is what a field's directives say about whether a literal has to
// write it.
export interface Optionality {
  optional: boolean;
  enforced: boolean;
}

export function optionality(ds: readonly Directive[]): Optionality {
  return { optional: ds.includes("optional"), enforced: ds.includes("enforce") };
}

export interface DirectiveDiagnostic {
  pos: token.Pos;
  message: string;
}

interface Position {
  filename: string;
  line: number;
}

// Scanner reads directives by file and line. A package's own files come from
// its syntax trees; any other file is parsed from disk on first lookup.
export class Scanner {
  private readonly files = new Map<string, Map<number, Directive[]>>();

  constructor(private readonly fset: token.FileSet) {}

  // processFiles scans the package's own files and returns their diagnostics.
  processFiles(files: readonly ast.File[]): DirectiveDiagnostic[] {
    const diagnostics: DirectiveDiagnostic[] = [];
    for (const file of files) {
      const filename = this.fset.positionFor(file.pos(), false).filename;
      if (this.files.has(filename)) {
        continue;
      }
      const { lines, diags } = parseFileDirectives(this.fset, file);
      this.files.set(filename, lines);
      diagnostics.push(...diags);
    }
    return diagnostics;
  }

  // lookupPos returns the directives at the physical line of pos, ignoring
  // //line directives, which may name files that do not exist.
  lookupPos(pos: token.Pos): Directive[] {
    const position = this.fset.positionFor(pos, false);
    return this.lookup({ filename: position.filename, line: position.line });
  }

  lookup(position: Position): Directive[] {
    if (position.filename === "") {
      return [];
    }
    let lines = this.files.get(position.filename);
    if (lines === undefined) {
      lines = parseExternal(position.filename);
      this.files.set(position.filename, lines);
    }
    return lines.get(position.line) ?? [];
  }
}

// parseExternal reads the directives of a file another package owns, which
// reports its own diagnostics. Unreadable files and the Go distribution carry
// none.
function parseExternal(filename: string): Map<number, Directive[]> {
  if (isGoRootFile(filename)) {
    return new Map();
  }
  const fset = token.newFileSet()!;
  try {
    const file = parser.parseFile(fset, filename, null, parser.ParseComments | parser.SkipObjectResolution);
    return file === null ? new Map() : parseFileDirectives(fset, file).lines;
  } catch {
    return new Map();
  }
}

function isGoRootFile(filename: string): boolean {
  return hasPathPrefix(filename, "$GOROOT") || hasPathPrefix(filename, build.Default.goroot);
}

function hasPathPrefix(path: string, prefix: string): boolean {
  const trimmed = prefix.replace(/\\/g, "/").replace(/\/$/, "");
  if (trimmed === "") {
    return false;
  }
  const slashed = path.replace(/\\/g, "/");
  return slashed.startsWith(trimmed) && (slashed.length === trimmed.length || slashed[trimmed.length] === "/");
}

interface ParsedDirective {
  pos: token.Pos;
  line: number;
  endLine: number;
  targetLine: number;
  directives: Directive[];
}

function parseFileDirectives(
  fset: token.FileSet,
  file: ast.File,
): { lines: Map<number, Directive[]>; diags: DirectiveDiagnostic[] } {
  const line = (pos: token.Pos) => fset.positionFor(pos, false).line;
  const { directives, diags } = parseCommentDirectives(fset, file);
  if (directives.length === 0) {
    return { lines: new Map(), diags };
  }
  // A directive sharing a line with code targets that code rather than the
  // line below.
  const asked = new Set(directives.flatMap((d) => [d.line, d.endLine]));
  const codeLines = new Map<number, number>();
  ast.inspect(file, (node) => {
    if (node === null || node.$type === "Comment" || node.$type === "CommentGroup") {
      return false;
    }
    const start = line(node.pos());
    const end = line(node.end());
    // A line closing a multi-line construct targets the line it opened on,
    // and the innermost construct wins.
    if (end !== start && asked.has(end)) {
      const target = codeLines.get(end);
      if (target === undefined || start > target) {
        codeLines.set(end, start);
      }
    }
    if (asked.has(start)) {
      codeLines.set(start, start);
    }
    return true;
  });
  for (const d of directives) {
    for (const l of [d.line, d.endLine]) {
      const target = codeLines.get(l);
      if (target !== undefined) {
        d.targetLine = target;
        break;
      }
    }
  }
  // The first directive written for a line wins; the rest conflict.
  const lines = new Map<number, Directive[]>();
  for (const d of [...directives].sort((a, b) => a.pos - b.pos)) {
    if (lines.has(d.targetLine)) {
      diags.push({ pos: d.pos, message: "directive ignored, conflicting directive already exists for the same target line" });
    } else {
      lines.set(d.targetLine, d.directives);
    }
  }
  return { lines, diags };
}

function parseCommentDirectives(
  fset: token.FileSet,
  file: ast.File,
): { directives: ParsedDirective[]; diags: DirectiveDiagnostic[] } {
  const line = (pos: token.Pos) => fset.positionFor(pos, false).line;
  const directives: ParsedDirective[] = [];
  const diags: DirectiveDiagnostic[] = [];
  for (const group of file.comments) {
    let hasDirective = false;
    for (const comment of group!.list) {
      const parsed = parse(comment!.text);
      if (parsed === null) {
        continue;
      }
      const pos = comment!.pos();
      for (const err of parsed.errors) {
        diags.push({ pos, message: err });
      }
      if (parsed.directives.length === 0) {
        continue;
      }
      if (hasDirective) {
        diags.push({ pos, message: "multiple exhaustruct directives in a single comment group, ignoring" });
        continue;
      }
      hasDirective = true;
      directives.push({
        pos,
        line: line(pos),
        endLine: line(comment!.end()),
        // The whole group carries the directive down to the code.
        targetLine: line(group!.end()) + 1,
        directives: parsed.directives,
      });
    }
  }
  return { directives, diags };
}

const directiveNames: readonly string[] = ["ignore", "enforce", "optional"];
const prose = /[ \t\n]/;

// parse reads a //exhaustruct:a,b comment, or returns null if the comment is
// not a directive. Anything after whitespace is prose.
export function parse(text: string): { directives: Directive[]; errors: string[] } | null {
  let body = text;
  if (body.startsWith("//")) {
    body = body.slice(2);
  } else if (body.startsWith("/*")) {
    body = body.slice(2).replace(/\*\/$/, "");
  }
  if (!body.startsWith("exhaustruct:")) {
    return null;
  }
  body = body.slice("exhaustruct:".length);
  const split = body.search(prose);
  const list = split < 0 ? body : body.slice(0, split);
  const rest = split < 0 ? "" : body.slice(split);
  if (list === "") {
    return { directives: [], errors: ["empty directive"] };
  }
  const directives: Directive[] = [];
  const errors: string[] = [];
  let duplicates = false;
  for (const part of list.split(",")) {
    if (part === "") {
      continue;
    }
    if (!directiveNames.includes(part)) {
      errors.push(`unknown directive (directive=${part})`);
    } else if (directives.includes(part as Directive)) {
      duplicates = true;
    } else {
      directives.push(part as Directive);
    }
  }
  if (duplicates) {
    errors.push("duplicate directives");
  }
  if (directives.length === 0 && errors.length === 0) {
    errors.push("empty directive");
  }
  // A list ending in a separator before a directive name in the prose was
  // meant to go on.
  if (list.endsWith(",")) {
    const word = rest.replace(/^[ \t\n]+/, "").split(/[ \t\n,]/)[0];
    if (directiveNames.includes(word)) {
      errors.push(`directive after a space is not read (directive=${word})`);
    }
  }
  return { directives, errors };
}
