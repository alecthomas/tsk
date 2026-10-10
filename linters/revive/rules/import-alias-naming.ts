import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "import-alias-naming";

export interface Options {
  /** A regular expression import aliases must match; empty matches any, or the default if denyRegex is empty too. */
  allowRegex: string;
  /** A regular expression import aliases must not match; empty matches none. */
  denyRegex: string;
}

export const defaults: Options = { allowRegex: "", denyRegex: "" };

const defaultAllowRule = "^[a-z][a-z0-9]{0,}$";

interface Pattern {
  source: string;
  regexp: RegExp;
}

// Patterns are JavaScript regular expressions, where revive's are Go's.
function compile(pattern: string, kind: string): Pattern {
  try {
    return { source: pattern, regexp: new RegExp(pattern) };
  } catch (e) {
    throw new Error(
      `invalid argument to the import-alias-naming ${kind} rule. Expecting ${JSON.stringify(pattern)} to be a valid regular expression, got: ${e}`,
    );
  }
}

export function create(options: DeepReadonly<Options>): Rule {
  // Empty options stand for revive's unset ones.
  let allow = options.allowRegex === "" ? undefined : compile(options.allowRegex, "allowRegexp");
  const deny = options.denyRegex === "" ? undefined : compile(options.denyRegex, "denyRegexp");
  if (allow === undefined && deny === undefined) {
    allow = compile(defaultAllowRule, "allowRegexp");
  }
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      for (const is of file.ast.imports) {
        const alias = is!.name;
        // "_" and "." are special import aliases for other rules.
        if (is!.path === null || alias === null || alias.name === "_" || alias.name === ".") {
          continue;
        }
        if (allow !== undefined && !allow.regexp.test(alias.name)) {
          failures.push({ failure: `import name (${alias.name}) must match the regular expression: ${allow.source}`, confidence: 1, node: alias });
        }
        if (deny !== undefined && deny.regexp.test(alias.name)) {
          failures.push({ failure: `import name (${alias.name}) must NOT match the regular expression: ${deny.source}`, confidence: 1, node: alias });
        }
      }
      return failures;
    },
  };
}
