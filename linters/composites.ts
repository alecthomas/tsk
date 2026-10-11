// Port of golang.org/x/tools/go/analysis/passes/composite at v0.50.0.
import * as ast from "go/ast";
import * as types from "go/types";
import { defineAnalyzer, type Pass, type SuggestedFix, type TextEdit } from "tsk";
import { inspect } from "tsk/passes";
import { deref, normalTerms } from "./internal/typeparams";

interface Config {
  /** Allow unkeyed literals of a list of standard library types that will never gain fields. */
  whitelist: boolean;
}

// unkeyedLiteral lists standard library types whose unkeyed literals are acceptable.
const unkeyedLiteral = new Set([
  // These image and image/color struct types are frozen.
  "image/color.Alpha16",
  "image/color.Alpha",
  "image/color.CMYK",
  "image/color.Gray16",
  "image/color.Gray",
  "image/color.NRGBA64",
  "image/color.NRGBA",
  "image/color.NYCbCrA",
  "image/color.RGBA64",
  "image/color.RGBA",
  "image/color.YCbCr",
  "image.Point",
  "image.Rectangle",
  "image.Uniform",
  "unicode.Range16",
  "unicode.Range32",
  // Generated test main files use these, but the generator can be trusted.
  "testing.InternalBenchmark",
  "testing.InternalExample",
  "testing.InternalTest",
  "testing.InternalFuzzTarget",
]);

export default defineAnalyzer<Config>({
  name: "composites",
  doc: `check for unkeyed composite literals

This analyzer reports a diagnostic for composite literals of struct
types imported from another package that do not use the field-keyed
syntax. Such literals are fragile because the addition of a new field
(even if unexported) to the struct will cause compilation to fail.

As an example,

	err = &net.DNSConfigError{err}

should be replaced by:

	err = &net.DNSConfigError{Err: err}`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/composite",
  requires: [inspect],
  runDespiteErrors: true,
  config: { whitelist: true },
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CompositeLit)) {
      const complit = cursor.node() as ast.CompositeLit;
      // Skip empty or partly or fully keyed literals.
      if (complit.elts.length === 0 || complit.elts.some((e) => e?.$type === "KeyValueExpr")) {
        continue;
      }
      // For a type parameter, choose an arbitrary term.
      const typ = pass.typesInfo.types.get(complit)?.type ?? null;
      if (typ === null) {
        continue;
      }
      const terms = normalTerms(typ);
      if (terms === null || terms.length === 0) {
        continue;
      }
      const t = terms[0].type()!;
      const strct = deref(t).underlying();
      if (strct?.$type !== "Struct" || isSamePackageType(pass, t)) {
        continue;
      }
      const typeName = typ.string();
      if (pass.config.whitelist && unkeyedLiteral.has(typeName)) {
        continue;
      }
      pass.report({
        pos: complit.pos(),
        end: complit.end(),
        message: `${typeName} struct literal uses unkeyed fields`,
        suggestedFixes: fieldNameFixes(complit, strct),
      });
    }
  },
});

// fieldNameFixes offers to fill in the field names when there is one value
// per field, all of them exported.
function fieldNameFixes(complit: ast.CompositeLit, strct: types.Struct): SuggestedFix[] | undefined {
  if (complit.elts.length !== strct.numFields()) {
    return undefined;
  }
  const textEdits: TextEdit[] = [];
  for (const [i, elt] of complit.elts.entries()) {
    const field = strct.field(i)!;
    if (!field.exported()) {
      return undefined;
    }
    textEdits.push({ pos: elt!.pos(), end: elt!.pos(), newText: `${field.name()}: ` });
  }
  return [{ message: "Add field names to struct literal", textEdits }];
}

// isSamePackageType reports whether typ belongs to the package being analyzed.
function isSamePackageType(pass: Pass<Config>, typ: types.Type): boolean {
  const x = types.unalias(typ);
  switch (x?.$type) {
    case "Struct":
      return true;
    case "Pointer":
      return isSamePackageType(pass, x.elem()!);
    case "Named":
    case "TypeParam": {
      // Names in package foo are local to foo_test too.
      const pkg = x.obj()!.pkg();
      return pkg !== null && pkg.path().replace(/_test$/, "") === pass.pkg.path().replace(/_test$/, "");
    }
    default:
      return false;
  }
}
