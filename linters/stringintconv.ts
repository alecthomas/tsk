// Port of golang.org/x/tools/go/analysis/passes/stringintconv at v0.50.0.
import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, type SuggestedFix, type TextEdit } from "tsk";
import { inspect } from "tsk/passes";
import { quote } from "./internal/strconv";
import { structuralTerms } from "./internal/typeparams";

export default defineAnalyzer({
  name: "stringintconv",
  doc: `check for string(int) conversions

This checker flags conversions of the form string(x) where x is an integer
(but not byte or rune) type. Such conversions are discouraged because they
return the UTF-8 representation of the Unicode code point x, and not a decimal
string representation of x as one might expect. Furthermore, if x denotes an
invalid code point, the conversion cannot be statically rejected.

For conversions that intend on using the code point, consider replacing them
with string(rune(x)). Otherwise, strconv.Itoa and its equivalents return the
string representation of the value in the desired base.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/stringintconv",
  group: "govet",
  requires: [inspect],
  run(pass) {
    const info = pass.typesInfo;
    let file: ast.File | null = null;
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.File, ast.CallExpr)) {
      const n = cursor.node()!;
      if (n.$type === "File") {
        file = n;
        continue;
      }
      const call = n as ast.CallExpr;
      if (call.args.length !== 1) {
        continue;
      }
      const arg = call.args[0]!;
      const fun = call.fun;
      const used = fun?.$type === "Ident" ? info.uses.get(fun) : fun?.$type === "SelectorExpr" ? info.uses.get(fun.sel!) : undefined;
      if (used?.$type !== "TypeName") {
        continue;
      }
      const tname = used;
      const t = tname.type()!;
      const ttypes = structuralTypes(t);
      if (ttypes === null) {
        continue;
      }
      // The string type in the type set of T.
      const t0 = ttypes.find((tt) => {
        const u = tt.underlying();
        return u?.$type === "Basic" && u.kind() === types.String;
      });
      if (t0 === undefined) {
        continue;
      }
      const v = info.typeOf(arg);
      if (v === null) {
        continue;
      }
      const vtypes = structuralTypes(v);
      if (vtypes === null) {
        continue;
      }
      // An integral type, other than byte or rune, in the type set of V.
      const v0 = vtypes.find((vt) => {
        const u = vt.underlying();
        if (u?.$type !== "Basic" || (u.info() & types.IsInteger) === 0) {
          return false;
        }
        const kind = u.kind();
        return kind !== types.Byte && kind !== types.Rune && kind !== types.UntypedRune;
      });
      if (v0 === undefined) {
        continue;
      }
      const target = describe(t0, t, tname.name());
      const source = describe(v0, v, typeName(v));
      if (target === "" || source === "") {
        continue;
      }
      const suggestedFixes: SuggestedFix[] = [];
      if (ttypes.length === 1 && vtypes.length === 1 && types.newMethodSet(v0)!.len() === 0) {
        const { prefix, edits } = addImport(info, file!, "fmt", "fmt", "Sprint", arg.pos());
        if (types.identical(t0, types.Typ[types.String])) {
          suggestedFixes.push({
            message: "Format the number as a decimal",
            textEdits: [...edits, { pos: fun!.pos(), end: fun!.end(), newText: `${prefix}Sprint` }],
          });
        } else {
          suggestedFixes.push({
            message: "Format the number as a decimal",
            textEdits: [
              ...edits,
              { pos: call.lparen + 1, end: call.lparen + 1, newText: `${prefix}Sprint(` },
              { pos: call.rparen, end: call.rparen, newText: ")" },
            ],
          });
        }
      }
      if (vtypes.every((vt) => types.convertibleTo(vt, types.Typ[types.Rune]))) {
        suggestedFixes.push({
          message: "Convert a single rune to a string",
          textEdits: [
            { pos: arg.pos(), end: arg.pos(), newText: "rune(" },
            { pos: arg.end(), end: arg.end(), newText: ")" },
          ],
        });
      }
      pass.report({
        pos: n.pos(),
        message: `conversion from ${source} to ${target} yields a string of one rune, not a string of digits`,
        suggestedFixes,
      });
    }
  },
});

// Describes typ, found in the type set of inType named inName, for a message.
function describe(typ: types.Type, inType: types.Type, inName: string): string {
  let name = inName;
  if (typ !== inType) {
    name = typeName(typ);
  }
  if (name === "") {
    return "";
  }
  const parentheticals: string[] = [];
  const underName = typeName(typ.underlying()!);
  if (underName !== "" && underName !== name) {
    parentheticals.push(underName);
  }
  if (typ !== inType && inName !== "" && inName !== name) {
    parentheticals.push(`in ${inName}`);
  }
  if (parentheticals.length > 0) {
    name += ` (${parentheticals.join(", ")})`;
  }
  return name;
}

function typeName(t: types.Type): string {
  // A basic type may be untyped, such as "untyped int", with no TypeName.
  if (t.$type === "Basic") {
    return t.name();
  }
  return typeNameFor(t)?.name() ?? "";
}

// Port of internal/typesinternal.TypeNameFor for the non-basic cases.
function typeNameFor(t: types.Type): types.TypeName | null {
  switch (t.$type) {
    case "Alias":
    case "Named":
    case "TypeParam":
      return t.obj();
    default:
      return null;
  }
}

// Returns the structural types of a type parameter's constraint, or t
// itself for other types; null if the constraint is invalid.
function structuralTypes(t: types.Type): types.Type[] | null {
  const tp = types.unalias(t);
  if (tp?.$type !== "TypeParam") {
    return [t];
  }
  const terms = structuralTerms(tp);
  return terms === null ? null : terms.map((term) => term.type()!);
}

// Port of internal/refactor.AddImport: returns the prefix for pkgpath's
// member at pos, and edits adding an import of it if one is needed.
function addImport(
  info: types.Info,
  file: ast.File,
  preferredName: string,
  pkgpath: string,
  member: string,
  pos: token.Pos,
): { prefix: string; edits: TextEdit[] } {
  const fileScope = info.scopes.get(file)!;
  const scope = fileScope.innermost(pos)!;
  for (const spec of file.imports) {
    const pkgname = info.pkgNameOf(spec);
    if (pkgname === null || pkgname.imported()!.path() !== pkgpath) {
      continue;
    }
    const name = pkgname.name();
    if (preferredName === "_") {
      return { prefix: "", edits: [] };
    }
    if (name === ".") {
      // A dot import works unless the member is shadowed.
      const [s] = scope.lookupParent(member, pos);
      if (s === fileScope) {
        return { prefix: "", edits: [] };
      }
    } else {
      const [, obj] = scope.lookupParent(name, pos);
      if (obj === pkgname) {
        return { prefix: `${name}.`, edits: [] };
      }
    }
  }
  let newName = preferredName;
  let prefix = "";
  if (preferredName !== "_") {
    newName = freshName(scope, pos, preferredName);
    prefix = `${newName}.`;
  }
  if (newName === preferredName && newName === pkgpath.slice(pkgpath.lastIndexOf("/") + 1)) {
    newName = "";
  }
  return { prefix, edits: addImportEdits(file, newName, pkgpath) };
}

// Port of internal/refactor.FreshName.
function freshName(scope: types.Scope, pos: token.Pos, preferred: string): string {
  let newName = preferred;
  for (let i = 0; scope.lookupParent(newName, pos)[1] !== null; i++) {
    newName = `${preferred}${i}`;
  }
  return newName;
}

// Port of internal/refactor.AddImportEdits.
function addImportEdits(file: ast.File, name: string, pkgpath: string): TextEdit[] {
  let newText = quote(pkgpath);
  if (name !== "") {
    newText = `${name} ${newText}`;
  }
  // Insert before the first declaration and its doc comment, if any.
  const decl0 = file.decls[0] ?? null;
  let before: token.Pos = file.fileEnd;
  if (decl0 !== null) {
    before = decl0.pos();
    if ((decl0.$type === "GenDecl" || decl0.$type === "FuncDecl") && decl0.doc !== null) {
      before = decl0.doc.pos();
    }
  }
  let pos: token.Pos;
  if (decl0?.$type === "GenDecl" && decl0.tok === token.IMPORT && decl0.rparen !== token.NoPos) {
    if (maybeStdPackage(pkgpath) && decl0.specs.length > 0) {
      // Put a standard package first, separated from non-standard ones.
      const first = decl0.specs[0] as ast.ImportSpec;
      pos = first.pos();
      if (!maybeStdPackage(first.path!.value)) {
        newText += "\n";
      }
      newText += "\n\t";
    } else {
      pos = decl0.rparen;
      newText = `\t${newText}\n`;
    }
  } else {
    pos = before;
    newText = `import ${newText}\n\n`;
  }
  return [{ pos, end: pos, newText }];
}

// Port of internal/packagepath.MaybeStdPackage.
function maybeStdPackage(path: string): boolean {
  let slash = path.indexOf("/");
  if (slash < 0) {
    slash = path.length;
  }
  return !path.slice(0, slash).includes(".") && path !== "testdata";
}
