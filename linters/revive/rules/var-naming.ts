import * as ast from "go/ast";
import * as token from "go/token";
import { isCgoExported } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";
import { isUpperCaseConst, isUpperUnderscore, suggestedName } from "../naming";

export const name = "var-naming";

export interface Options {
  /** Initialisms not to enforce, such as "ID". */
  allowlist: string[];
  /** Initialisms to enforce as well as the common ones, such as "VM". */
  blocklist: string[];
  /** Do not enforce capitalised initialisms. */
  skipInitialismNameChecks: boolean;
  /** Allow constants named in UPPER_CASE. */
  upperCaseConst: boolean;
}

export const defaults: Options = { allowlist: [], blocklist: [], skipInitialismNameChecks: false, upperCaseConst: false };

const knownNameExceptions = new Set(["LastInsertId", "kWh"]);

export function create(options: DeepReadonly<Options>): Rule {
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      const check = (id: ast.Ident, thing: string): void => {
        if (id.name === "_" || knownNameExceptions.has(id.name)) {
          return;
        }
        if (thing === "const" && options.upperCaseConst && isUpperCaseConst(id.name)) {
          return;
        }
        if (isUpperUnderscore(id.name)) {
          failures.push({ failure: "don't use ALL_CAPS in Go names; use CamelCase", confidence: 0.8, node: id });
          return;
        }
        const should = suggestedName(id.name, options.allowlist, options.blocklist, options.skipInitialismNameChecks);
        if (id.name === should) {
          return;
        }
        if (id.name.length > 2 && id.name.slice(1).includes("_")) {
          failures.push({ failure: `don't use underscores in Go names; ${thing} ${id.name} should be ${should}`, confidence: 0.9, node: id });
          return;
        }
        failures.push({ failure: `${thing} ${id.name} should be ${should}`, confidence: 0.8, node: id });
      };
      const checkList = (fl: ast.FieldList | null, thing: string): void => {
        for (const f of fl?.list ?? []) {
          for (const id of f!.names) {
            check(id!, thing);
          }
        }
      };
      ast.inspect(file.ast, (n) => {
        if (n === null) {
          return true;
        }
        switch (n.$type) {
          case "AssignStmt": {
            const v = n as ast.AssignStmt;
            if (v.tok !== token.ASSIGN) {
              for (const exp of v.lhs) {
                if (exp!.$type === "Ident") {
                  check(exp as ast.Ident, "var");
                }
              }
            }
            break;
          }
          case "FuncDecl": {
            const v = n as ast.FuncDecl;
            const funcName = v.name!.name;
            if (file.isTest() && /^(Example|Test|Benchmark|Fuzz)/.test(funcName)) {
              break;
            }
            const thing = v.recv === null ? "func" : "method";
            // Functions exported to C but not in the Go API keep their names.
            if (ast.isExported(funcName) || !isCgoExported(v)) {
              check(v.name!, thing);
            }
            checkList(v.type!.params, `${thing} parameter`);
            checkList(v.type!.results, `${thing} result`);
            break;
          }
          case "GenDecl": {
            const v = n as ast.GenDecl;
            if (v.tok === token.IMPORT) {
              break;
            }
            const thing = token.Token.string(v.tok);
            for (const spec of v.specs) {
              if (spec!.$type === "TypeSpec") {
                check((spec as ast.TypeSpec).name!, thing);
              } else if (spec!.$type === "ValueSpec") {
                for (const id of (spec as ast.ValueSpec).names) {
                  check(id!, thing);
                }
              }
            }
            break;
          }
          case "InterfaceType":
            // Interface method names are often constrained by concrete types.
            for (const x of (n as ast.InterfaceType).methods!.list) {
              if (x!.type!.$type === "FuncType") {
                const ft = x!.type as ast.FuncType;
                checkList(ft.params, "interface method parameter");
                checkList(ft.results, "interface method result");
              }
            }
            break;
          case "RangeStmt": {
            const v = n as ast.RangeStmt;
            if (v.tok === token.ASSIGN) {
              break;
            }
            for (const e of [v.key, v.value]) {
              if (e !== null && e.$type === "Ident") {
                check(e as ast.Ident, "range var");
              }
            }
            break;
          }
          case "StructType":
            checkList((n as ast.StructType).fields, "struct field");
            break;
        }
        return true;
      });
      return failures;
    },
  };
}
