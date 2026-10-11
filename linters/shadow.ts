// Port of golang.org/x/tools/go/analysis/passes/shadow at v0.50.0.
import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { quote } from "./internal/strconv";

interface Config {
  /** Whether to be strict about shadowing; can be noisy. */
  strict: boolean;
}

// A span is the lexical range from an object's first mention to its last.
// Unless strict, a declaration shadows an object only within its span.
interface Span {
  min: token.Pos;
  max: token.Pos;
}

type Spans = Map<types.Object, Span>;

export default defineAnalyzer<Config>({
  name: "shadow",
  doc: `check for possible unintended shadowing of variables

This analyzer check for shadowed variables.
A shadowed variable is a variable declared in an inner scope
with the same name and type as a variable in an outer scope,
and where the outer variable is mentioned after the inner one
is declared.

(This definition can be refined; the module generates too many
false positives and is not yet enabled by default.)

For example:

	func BadRead(f *os.File, buf []byte) error {
		var err error
		for {
			n, err := f.Read(buf) // shadows the function variable 'err'
			if err != nil {
				break // causes return of wrong value
			}
			foo(buf)
		}
		return err
	}`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/shadow",
  group: "govet",
  enabledByDefault: false,
  requires: [inspect],
  config: { strict: false },
  run(pass) {
    const spans: Spans = new Map();
    if (!pass.config.strict) {
      for (const [id, obj] of pass.typesInfo.defs) {
        // Skip identifiers that denote no object, such as package names.
        if (obj !== null) {
          growSpan(spans, obj, id.pos(), id.end());
        }
      }
      for (const [id, obj] of pass.typesInfo.uses) {
        growSpan(spans, obj!, id.pos(), id.end());
      }
      for (const [node, obj] of pass.typesInfo.implicits) {
        // A type switch's t := x.(type) declares a variable in each case,
        // assumed to be declared at the case's colon.
        if (node.$type === "CaseClause") {
          growSpan(spans, obj!, node.colon, node.colon);
        }
      }
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.AssignStmt, ast.GenDecl)) {
      const node = cursor.node()!;
      if (node.$type === "AssignStmt") {
        checkShadowAssignment(pass, spans, node);
      } else if (node.$type === "GenDecl") {
        checkShadowDecl(pass, spans, node);
      }
    }
  },
});

function growSpan(spans: Spans, obj: types.Object, pos: token.Pos, end: token.Pos): void {
  const s = spans.get(obj);
  if (s === undefined) {
    spans.set(obj, { min: pos, max: end });
    return;
  }
  s.min = Math.min(s.min, pos);
  s.max = Math.max(s.max, end);
}

function reportRange(pass: Pass<Config>, node: ast.Node, message: string): void {
  pass.report({ pos: node.pos(), end: node.end(), message });
}

// checkShadowAssignment checks for shadowing in a short variable declaration.
function checkShadowAssignment(pass: Pass<Config>, spans: Spans, a: ast.AssignStmt): void {
  if (a.tok !== token.DEFINE || idiomaticShortRedecl(pass, a)) {
    return;
  }
  for (const expr of a.lhs) {
    if (expr?.$type !== "Ident") {
      reportRange(pass, expr!, "invalid AST: short variable declaration of non-identifier");
      return;
    }
    checkShadowing(pass, spans, expr);
  }
}

// idiomaticShortRedecl reports whether a short declaration's redeclarations
// are deliberate, as in i := i or switch n := n.(type).
function idiomaticShortRedecl(pass: Pass<Config>, a: ast.AssignStmt): boolean {
  if (a.rhs.length !== a.lhs.length) {
    return false;
  }
  for (const [i, lhs] of a.lhs.entries()) {
    if (lhs?.$type !== "Ident") {
      reportRange(pass, lhs!, "invalid AST: short variable declaration of non-identifier");
      return true;
    }
    const rhs = a.rhs[i]!;
    if (rhs.$type === "Ident") {
      if (lhs.name !== rhs.name) {
        return false;
      }
    } else if (rhs.$type === "TypeAssertExpr") {
      if (rhs.x?.$type === "Ident" && lhs.name !== rhs.x.name) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

// idiomaticRedecl reports whether a declaration's redeclarations are
// deliberate, as in var i, j = i, j.
function idiomaticRedecl(d: ast.ValueSpec): boolean {
  if (d.names.length !== d.values.length) {
    return false;
  }
  return d.names.every((lhs, i) => {
    const rhs = d.values[i];
    return rhs?.$type === "Ident" && lhs!.name === rhs.name;
  });
}

// checkShadowDecl checks for shadowing in a general variable declaration.
function checkShadowDecl(pass: Pass<Config>, spans: Spans, d: ast.GenDecl): void {
  if (d.tok !== token.VAR) {
    return;
  }
  for (const spec of d.specs) {
    if (spec?.$type !== "ValueSpec") {
      reportRange(pass, spec!, "invalid AST: var GenDecl not ValueSpec");
      return;
    }
    // As upstream, one deliberate redeclaration skips the rest of the declaration.
    if (idiomaticRedecl(spec)) {
      return;
    }
    for (const ident of spec.names) {
      checkShadowing(pass, spans, ident!);
    }
  }
}

// checkShadowing checks whether the identifier shadows one in an outer scope.
function checkShadowing(pass: Pass<Config>, spans: Spans, ident: ast.Ident): void {
  if (ident.name === "_") {
    return;
  }
  const obj = pass.typesInfo.defs.get(ident);
  if (obj === null || obj === undefined) {
    return;
  }
  const [, shadowed] = obj.parent()!.parent()!.lookupParent(obj.name(), obj.pos());
  // Shadowing a universe-declared identifier is fine.
  if (shadowed === null || shadowed.parent() === types.Universe) {
    return;
  }
  if (pass.config.strict) {
    if (shadowed.pos() > ident.pos()) {
      return;
    }
  } else {
    const span = spans.get(shadowed);
    if (span === undefined) {
      reportRange(pass, ident, `internal error: no range for ${quote(ident.name)}`);
      return;
    }
    if (!(span.min <= ident.pos() && ident.pos() < span.max)) {
      return;
    }
  }
  // Differing types imply the programmer wants two different things.
  if (types.identical(obj.type(), shadowed.type())) {
    const line = pass.fset.position(shadowed.pos()).line;
    reportRange(pass, ident, `declaration of ${quote(obj.name())} shadows declaration at line ${line}`);
  }
}
