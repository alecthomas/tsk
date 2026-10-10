import type * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { isIdent, walk, type Visitor } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "var-declaration";

const zeroLiterals = new Set(["false", `'\\x00'`, `'\\000'`, `""`, "``", "0", "0.", "0.0", "0i"]);

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  let lastGen: ast.GenDecl | null = null;
  const visitor: Visitor = {
    visit(node) {
      if (node === null) {
        return visitor;
      }
      switch (node.$type) {
        case "GenDecl": {
          const gen = node as ast.GenDecl;
          if (gen.tok !== token.CONST && gen.tok !== token.VAR) {
            return null;
          }
          lastGen = gen;
          return visitor;
        }
        case "ValueSpec":
          if (lastGen!.tok !== token.CONST) {
            checkSpec(file, node as ast.ValueSpec, failures);
          }
          return null;
        default:
          return visitor;
      }
    },
  };
  walk(visitor, file.ast);
  return failures;
}

function checkSpec(file: File, spec: ast.ValueSpec, failures: Failure[]): void {
  if (spec.names.length > 1 || spec.type === null || spec.values.length === 0) {
    return;
  }
  const rhs = spec.values[0]!;
  const varName = spec.names[0]!.name;
  // "var _ Interface = (*Concrete)(nil)" is an idiom for interface satisfaction.
  if (varName === "_") {
    return;
  }
  const isZero = rhs.$type === "BasicLit" ? isZeroValue((rhs as ast.BasicLit).value, spec.type) : isIdent(rhs, "nil");
  if (isZero) {
    failures.push({
      node: rhs,
      confidence: 0.9,
      failure: `should drop = ${file.render(rhs)} from declaration of var ${varName}; it is the zero value`,
    });
    return;
  }
  const lhsType = file.pkg.typeOf(spec.type);
  const rhsType = file.pkg.typeOf(rhs);
  // Type checking failed, often due to missing imports.
  if (!validType(lhsType) || !validType(rhsType) || !types.identical(lhsType, rhsType)) {
    return;
  }
  // A literal interface type on the left probably holds a concrete type.
  if (spec.type.$type === "InterfaceType") {
    return;
  }
  // An untyped constant only makes the type redundant if it is the default.
  const defaultType = file.isUntypedConst(rhs);
  if (defaultType !== undefined && !isIdent(spec.type, defaultType)) {
    return;
  }
  failures.push({
    node: spec.type,
    confidence: 0.8,
    failure: `should omit type ${file.render(spec.type)} from declaration of var ${varName}; it will be inferred from the right-hand side`,
  });
}

function validType(t: types.Type | null): boolean {
  return t !== null && !(t.$type === "Basic" && t.kind() === types.Invalid) && !t.string().includes("invalid type");
}

function isZeroValue(value: string, typ: ast.Expr): boolean {
  if (isIdent(typ, "any") || typ.$type === "InterfaceType") {
    return value === "nil";
  }
  return zeroLiterals.has(value);
}
