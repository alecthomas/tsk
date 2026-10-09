import type * as ast from "go/ast";
import * as token from "go/token";
import * as os from "os";
import * as filepath from "path/filepath";
import { defineAnalyzer, type Pass } from "tsk";

interface Config {
  /** The minimum size of a duplicate, in syntax tree nodes. */
  threshold: number;
}

export default defineAnalyzer<Config>({
  name: "dupl",
  doc: `detect duplicate fragments of code

Each package's syntax trees are serialized into one sequence of node types, and
a suffix tree finds repeated runs at least threshold nodes long. Runs are
trimmed to whole statements and declarations before they are reported.`,
  config: { threshold: 150 },
  run(pass) {
    const data: SyntaxNode[] = [];
    for (const file of pass.files) {
      if (pass.fset.position(file.pos()).filename.endsWith(".go")) {
        serialize(syntaxTree(file, file), data);
      }
    }
    const tree = new SuffixTree();
    for (const node of data) {
      tree.update(node.type);
    }
    // Terminate the sequence so every suffix ends at a leaf.
    tree.update(-1);
    const groups = new Map<string, SyntaxNode[][]>();
    for (const match of tree.findDuplOver(pass.config.threshold)) {
      const units = findSyntaxUnits(data, match, pass.config.threshold);
      if (units !== null) {
        groups.set(units.hash, [...(groups.get(units.hash) ?? []), ...units.fragments]);
      }
    }
    for (const key of [...groups.keys()].sort()) {
      const fragments = unique(groups.get(key)!);
      if (fragments.length > 1) {
        report(pass, fragments);
      }
    }
  },
});

// SyntaxNode is a node of the uniform tree dupl compares: only its type
// counts, so identifiers and literals with different values still match.
interface SyntaxNode {
  type: number;
  file: ast.File;
  pos: token.Pos;
  end: token.Pos;
  children: SyntaxNode[];
  // owns counts the nodes below this one in the serialized sequence.
  owns: number;
}

// The node types, numbered as dupl numbers them.
const nodeTypes = [
  "BadNode",
  "File",
  "ArrayType",
  "AssignStmt",
  "BasicLit",
  "BinaryExpr",
  "BlockStmt",
  "BranchStmt",
  "CallExpr",
  "CaseClause",
  "ChanType",
  "CommClause",
  "CompositeLit",
  "DeclStmt",
  "DeferStmt",
  "Ellipsis",
  "EmptyStmt",
  "ExprStmt",
  "Field",
  "FieldList",
  "ForStmt",
  "FuncDecl",
  "FuncLit",
  "FuncType",
  "GenDecl",
  "GoStmt",
  "Ident",
  "IfStmt",
  "IncDecStmt",
  "IndexExpr",
  "IndexListExpr",
  "InterfaceType",
  "KeyValueExpr",
  "LabeledStmt",
  "MapType",
  "ParenExpr",
  "RangeStmt",
  "ReturnStmt",
  "SelectStmt",
  "SelectorExpr",
  "SendStmt",
  "SliceExpr",
  "StarExpr",
  "StructType",
  "SwitchStmt",
  "TypeAssertExpr",
  "TypeSpec",
  "TypeSwitchStmt",
  "UnaryExpr",
  "ValueSpec",
];
const typeNumbers = new Map(nodeTypes.map((name, i) => [name, i]));

function syntaxTree(file: ast.File, node: ast.Node): SyntaxNode {
  const type = typeNumbers.get(node.$type) ?? 0;
  const children = syntaxChildren(node).map((child) => syntaxTree(file, child));
  return { type, file, pos: node.pos(), end: node.end(), children, owns: 0 };
}

// syntaxChildren lists the children dupl compares, in its order; for
// example, an assignment's right-hand side comes before its left.
function syntaxChildren(node: ast.Node): ast.Node[] {
  const present = (...nodes: (ast.Node | null)[]) => nodes.filter((n): n is ast.Node => n !== null);
  switch (node.$type) {
    case "ArrayType":
      return present(node.len, node.elt);
    case "AssignStmt":
      return present(...node.rhs, ...node.lhs);
    case "BinaryExpr":
      return present(node.x, node.y);
    case "BlockStmt":
      return present(...node.list);
    case "BranchStmt":
      return present(node.label);
    case "CallExpr":
      return present(node.fun, ...node.args);
    case "CaseClause":
      return present(...node.list, ...node.body);
    case "ChanType":
      return present(node.value);
    case "CommClause":
      return present(node.comm, ...node.body);
    case "CompositeLit":
      return present(node.type, ...node.elts);
    case "DeclStmt":
      return present(node.decl);
    case "DeferStmt":
    case "GoStmt":
      return present(node.call);
    case "Ellipsis":
      return present(node.elt);
    case "ExprStmt":
    case "IncDecStmt":
    case "ParenExpr":
    case "StarExpr":
    case "UnaryExpr":
      return present(node.x);
    case "Field":
      return present(...node.names, node.type);
    case "FieldList":
      return present(...node.list);
    case "File":
      return present(...node.decls.filter((decl) => decl?.$type !== "GenDecl" || decl.tok !== token.IMPORT));
    case "ForStmt":
      return present(node.init, node.cond, node.post, node.body);
    case "FuncDecl":
      return present(node.recv, node.name, node.type, node.body);
    case "FuncLit":
      return present(node.type, node.body);
    case "FuncType":
      return present(node.typeParams, node.params, node.results);
    case "GenDecl":
      return present(...node.specs);
    case "IfStmt":
      return present(node.init, node.cond, node.body, node.else);
    case "IndexExpr":
      return present(node.x, node.index);
    case "IndexListExpr":
      return present(node.x, ...node.indices);
    case "InterfaceType":
      return present(node.methods);
    case "KeyValueExpr":
      return present(node.key, node.value);
    case "LabeledStmt":
      return present(node.label, node.stmt);
    case "MapType":
      return present(node.key, node.value);
    case "RangeStmt":
      return present(node.key, node.value, node.x, node.body);
    case "ReturnStmt":
      return present(...node.results);
    case "SelectStmt":
      return present(node.body);
    case "SelectorExpr":
      return present(node.x, node.sel);
    case "SendStmt":
      return present(node.chan, node.value);
    case "SliceExpr":
      return present(node.x, node.low, node.high, node.max);
    case "StructType":
      return present(node.fields);
    case "SwitchStmt":
      return present(node.init, node.tag, node.body);
    case "TypeAssertExpr":
      return present(node.x, node.type);
    case "TypeSpec":
      return present(node.name, node.typeParams, node.type);
    case "TypeSwitchStmt":
      return present(node.init, node.assign, node.body);
    case "ValueSpec":
      return present(...node.names, node.type, ...node.values);
  }
  return [];
}

// Children past this many are left out of the sequence, as dupl does, so
// gigantic composite literals stay cheap.
const maxChildrenSerial = 10_000;

function serialize(node: SyntaxNode, stream: SyntaxNode[]): number {
  stream.push(node);
  let count = 0;
  for (let i = 0; i < node.children.length && i <= maxChildrenSerial; i++) {
    count += serialize(node.children[i], stream);
  }
  node.owns = count;
  return count + 1;
}

interface Match {
  positions: number[];
  length: number;
}

const infinity = 2 ** 31 - 1;

interface State {
  transitions: Transition[];
  link: State | null;
}

interface Transition {
  start: number;
  end: number;
  state: State;
}

// SuffixTree is Ukkonen's online suffix tree over node types, as dupl builds it.
class SuffixTree {
  private readonly data: number[] = [];
  private readonly root: State = { transitions: [], link: null };
  private readonly aux: State = { transitions: [], link: null };
  // The active point, (s, (start, end)).
  private s: State;
  private start = 0;
  private end = 0;

  constructor() {
    this.root.link = this.aux;
    this.s = this.root;
  }

  update(value: number): void {
    this.data.push(value);
    let oldr = this.root;
    let s = this.s;
    let start = this.start;
    let r: State;
    for (;;) {
      const [state, endPoint] = this.testAndSplit(s, start, this.end - 1);
      r = state;
      if (endPoint) {
        break;
      }
      r.transitions.push({ start: this.end, end: infinity, state: { transitions: [], link: null } });
      if (oldr !== this.root) {
        oldr.link = r;
      }
      oldr = r;
      [s, start] = this.canonize(s.link!, start, this.end - 1);
    }
    if (oldr !== this.root) {
      oldr.link = r;
    }
    [this.s, this.start] = this.canonize(s, start, this.end);
    this.end++;
  }

  private findTransition(s: State, value: number): Transition | null {
    return s.transitions.find((t) => this.data[t.start] === value) ?? null;
  }

  private testAndSplit(s: State, start: number, end: number): [State, boolean] {
    const c = this.data[this.end];
    if (start <= end) {
      const t = this.findTransition(s, this.data[start])!;
      const splitPoint = t.start + end - start + 1;
      if (this.data[splitPoint] === c) {
        return [s, true];
      }
      const split: State = { transitions: [{ start: splitPoint, end: t.end, state: t.state }], link: null };
      t.end = splitPoint - 1;
      t.state = split;
      return [split, false];
    }
    return [s, s === this.aux || this.findTransition(s, c) !== null];
  }

  private canonize(s: State, start: number, end: number): [State, number] {
    if (s === this.aux) {
      s = this.root;
      start++;
    }
    if (start > end) {
      return [s, start];
    }
    let t: Transition | null = null;
    for (;;) {
      if (start <= end) {
        t = this.findTransition(s, this.data[start]);
        if (t === null) {
          throw new Error(`dupl: no transition for ${this.data[start]} at ${start}`);
        }
      }
      if (t!.end - t!.start > end - start) {
        break;
      }
      start += t!.end - t!.start + 1;
      s = t!.state;
    }
    return [s, start];
  }

  // findDuplOver finds maximal repeats at least threshold long, preceded by
  // different values, so each is not part of a longer repeat.
  findDuplOver(threshold: number): Match[] {
    const matches: Match[] = [];
    // Each context list maps the value before a suffix to the suffixes' starts.
    const walk = (parent: Transition, length: number): Map<number, number[]> => {
      const state = parent.state;
      const contexts = new Map<number, number[]>();
      if (state.transitions.length === 0) {
        const start = parent.end + 1 - length;
        contexts.set(start > 0 ? this.data[start - 1] : 0, [start]);
        return contexts;
      }
      for (const t of state.transitions) {
        const childLength = length + t.end - t.start + 1;
        const child = walk(t, childLength);
        if (childLength >= threshold) {
          for (const [key, positions] of child) {
            const existing = contexts.get(key);
            if (existing === undefined) {
              contexts.set(key, positions);
            } else {
              existing.push(...positions);
            }
          }
        }
      }
      if (length >= threshold && contexts.size > 1) {
        const keys = [...contexts.keys()].sort((a, b) => a - b);
        matches.push({ positions: keys.flatMap((key) => contexts.get(key)!), length });
      }
      return contexts;
    };
    walk({ start: 0, end: 0, state: this.root }, 0);
    return matches;
  }
}

interface Units {
  hash: string;
  fragments: SyntaxNode[][];
}

// findSyntaxUnits trims a match to the complete syntax units it holds in
// every occurrence, or returns null if none remain.
function findSyntaxUnits(data: SyntaxNode[], match: Match, threshold: number): Units | null {
  if (match.positions.length === 0) {
    return null;
  }
  const first = data.slice(match.positions[0], match.positions[0] + match.length);
  let indexes = unitIndexes(first, threshold);
  if (indexes.length > 0) {
    const last = indexes[indexes.length - 1];
    for (let i = 1; i < match.positions.length; i++) {
      if (first[last].owns !== data[match.positions[i] + last].owns) {
        indexes = indexes.slice(0, -1);
        break;
      }
    }
  }
  if (indexes.length === 0 || isCyclic(indexes, first) || spansFiles(indexes, first)) {
    return null;
  }
  const fragments = match.positions.map((pos) => indexes.map((index) => data[pos + index]));
  const last = indexes[indexes.length - 1];
  const hash = first
    .slice(indexes[0], last + first[last].owns)
    .map((node) => node.type)
    .join(",");
  return { hash, fragments };
}

function unitIndexes(nodes: SyntaxNode[], threshold: number): number[] {
  let indexes: number[] = [];
  let split = false;
  for (let i = 0; i < nodes.length; ) {
    const node = nodes[i];
    if (node.owns >= nodes.length - i) {
      // Not a complete syntax unit.
      i++;
      split = true;
      continue;
    }
    if (node.owns + 1 < threshold) {
      split = true;
    } else {
      if (split) {
        indexes = [];
        split = false;
      }
      indexes.push(i);
    }
    i += node.owns + 1;
  }
  return indexes;
}

// isCyclic reports whether the units repeat a shorter pattern, which would
// make the clone redundant.
function isCyclic(indexes: number[], nodes: SyntaxNode[]): boolean {
  const count = indexes.length;
  if (count <= 1) {
    return false;
  }
  const alts = new Set<number>();
  for (let i = 1; i <= count / 2; i++) {
    if (count % i === 0) {
      alts.add(i);
    }
  }
  for (let i = 0; i < indexes[Math.floor(count / 2)]; i++) {
    const start = nodes[i + indexes[0]];
    for (const alt of [...alts]) {
      for (let j = alt; j < count; j += alt) {
        const index = i + indexes[j];
        if (index < nodes.length) {
          const other = nodes[index];
          if (start.owns === other.owns && start.type === other.type) {
            continue;
          }
        } else if (i >= indexes[alt]) {
          return true;
        }
        alts.delete(alt);
        break;
      }
    }
    if (alts.size === 0) {
      return false;
    }
  }
  return true;
}

// spansFiles reports whether the units run from one file into the next.
function spansFiles(indexes: number[], nodes: SyntaxNode[]): boolean {
  return indexes.some((index) => nodes[index].file !== nodes[indexes[0]].file);
}

// unique drops fragments starting where an earlier one does.
function unique(group: SyntaxNode[][]): SyntaxNode[][] {
  const seen = new Set<token.Pos>();
  return group.filter((fragment) => {
    const pos = fragment[0].pos;
    if (seen.has(pos)) {
      return false;
    }
    seen.add(pos);
    return true;
  });
}

interface Clone {
  filename: string;
  lineStart: number;
  lineEnd: number;
  pos: token.Pos;
}

// report reports each clone as a duplicate of the next, in file and line order.
function report(pass: Pass<Config>, fragments: SyntaxNode[][]): void {
  const clones: Clone[] = fragments.map((fragment) => {
    const start = pass.fset.position(fragment[0].pos);
    return {
      filename: start.filename,
      lineStart: start.line,
      lineEnd: pass.fset.position(fragment[fragment.length - 1].end - 1).line,
      pos: fragment[0].pos,
    };
  });
  clones.sort((a, b) => (a.filename === b.filename ? a.lineStart - b.lineStart : a.filename < b.filename ? -1 : 1));
  clones.forEach((clone, i) => {
    const next = clones[(i + 1) % clones.length];
    const location = `${relativePath(next.filename)}:${next.lineStart}-${next.lineEnd}`;
    const file = pass.fset.file(clone.pos)!;
    pass.report({
      pos: file.lineStart(clone.lineStart),
      message: `${clone.lineStart}-${clone.lineEnd} lines are duplicate of \`${location}\``,
    });
  });
}

function relativePath(filename: string): string {
  try {
    return filepath.rel(filepath.evalSymlinks(os.getwd()), filepath.evalSymlinks(filename));
  } catch {
    return filename;
  }
}
