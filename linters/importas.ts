import type * as ast from "go/ast";
import { defineAnalyzer, type Pass, type TextEdit } from "tsk";
import { quote, unquote } from "./internal/strconv";

interface Alias {
  /** The package path, a Go regular expression matching the whole path. */
  pkg: string;
  /** The required alias. It may use the expression's groups, as in $1. */
  alias: string;
}

interface Config {
  /** Do not allow unaliased imports of aliased packages. */
  noUnaliased: boolean;
  /** Do not allow aliases that are not configured. */
  noExtraAliases: boolean;
  /** Required aliases. */
  alias: Alias[];
}

export default defineAnalyzer<Config>({
  name: "importas",
  doc: `enforces consistent import aliases

Packages matching a configured path must be imported under its alias.`,
  config: { noUnaliased: false, noExtraAliases: false, alias: [] },
  run(pass) {
    const rules = pass.config.alias.map((rule) => ({ pattern: goRegExp(`^${rule.pkg}$`), template: rule.alias }));
    for (const file of pass.files) {
      for (const spec of file.imports) {
        check(pass, rules, spec!);
      }
    }
  },
});

interface Rule {
  pattern: RegExp;
  template: string;
}

function check(pass: Pass<Config>, rules: Rule[], spec: ast.ImportSpec): void {
  if (!pass.config.noUnaliased && spec.name === null) {
    return;
  }
  const alias = spec.name?.name ?? "";
  // Dot imports are common in tests, and blank ones only run init.
  if (alias === "." || alias.startsWith("_")) {
    return;
  }
  const path = unquote(spec.path!.value);
  if (path === null) {
    pass.report({ pos: spec.pos(), message: "import not quoted" });
    return;
  }
  const required = aliasFor(rules, path);
  if (required !== undefined && required !== alias) {
    const message =
      alias === ""
        ? `import ${quote(path)} imported without alias but must be with alias ${quote(required)} according to config`
        : `import ${quote(path)} imported as ${quote(alias)} but must be ${quote(required)} according to config`;
    pass.report({
      pos: spec.pos(),
      end: spec.end(),
      message,
      suggestedFixes: [{ message: "Use correct alias", textEdits: edits(pass, spec, path, alias, required) }],
    });
  } else if (required === undefined && pass.config.noExtraAliases) {
    pass.report({
      pos: spec.pos(),
      end: spec.end(),
      message: `import ${quote(path)} has alias ${quote(alias)} which is not part of config`,
      suggestedFixes: [{ message: "remove alias", textEdits: edits(pass, spec, path, alias, "") }],
    });
  }
}

// aliasFor returns the alias the first matching rule requires for a path.
function aliasFor(rules: Rule[], path: string): string | undefined {
  for (const rule of rules) {
    const match = rule.pattern.exec(path);
    if (match !== null) {
      return match[0].length > 0 ? expand(rule.template, match) : undefined;
    }
  }
  return undefined;
}

// edits rewrites the import and every use of its name. Without a required
// alias, uses take the path's last element.
function edits(pass: Pass<Config>, spec: ast.ImportSpec, path: string, original: string, required: string): TextEdit[] {
  const result: TextEdit[] = [{ pos: spec.pos(), end: spec.end(), newText: required === "" ? quote(path) : `${required} ${quote(path)}` }];
  const parts = path.split("/");
  const replacement = required === "" ? (parts[parts.length - 1] ?? original) : required;
  for (const [use, object] of pass.typesInfo.uses) {
    if (object?.$type !== "PkgName" || object.pos() !== spec.pos()) {
      continue;
    }
    // Uses of a dot import lose their qualifier and its dot.
    result.push(replacement === "." ? { pos: use!.pos(), end: use!.end() + 1, newText: "" } : { pos: use!.pos(), end: use!.end(), newText: replacement });
  }
  return result;
}

// goRegExp compiles a Go regular expression, whose named groups are written
// (?P<name>...).
function goRegExp(source: string): RegExp {
  return new RegExp(source.replace(/\(\?P</g, "(?<"));
}

// expand fills a template from a match as Go's Regexp.Expand does: $1 or
// ${1} by number, $name or ${name} by name, $$ for a dollar, and an unknown
// group as empty.
function expand(template: string, match: RegExpExecArray): string {
  return template.replace(/\$(?:\$|\{(\w+)\}|(\w+))?/g, (whole, braced: string | undefined, bare: string | undefined) => {
    if (whole === "$$") {
      return "$";
    }
    const name = braced ?? bare;
    if (name === undefined) {
      return "$";
    }
    const value = /^\d+$/.test(name) ? match[Number(name)] : match.groups?.[name];
    return value ?? "";
  });
}
