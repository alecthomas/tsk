import type * as modfile from "golang.org/x/mod/modfile";
import * as modfileParser from "golang.org/x/mod/modfile";
import * as os from "os";
import * as filepath from "path/filepath";
import { defineAnalyzer, type Pass } from "tsk";
import {
  type BlockedModules,
  blockReasonHasLocalReplaceDirective,
  blockReasonInBlockedList,
  isRecommended,
  loadGoMod,
  recommendations,
  reportImports,
  sentence,
} from "./gomodguard/common";
import type { ModuleVersion } from "./internal/gomod";
import { type Constraints, newConstraint, newVersion } from "./internal/semver";

interface AllowedModule {
  /** The module path, or a prefix or regular expression by match-type. */
  module: string;
  /** A version constraint, as ">= 1.2, < 2", that allowed versions meet. */
  version?: string;
  /** How module matches module paths: exact, prefix, or regex. */
  matchType?: string;
}

interface BlockedModule {
  /** The module path, or a prefix or regular expression by match-type. */
  module: string;
  /** A version constraint, as ">= 1.2, < 2"; only versions meeting it are blocked. */
  version?: string;
  /** How module matches module paths: exact, prefix, or regex. */
  matchType?: string;
  /** Why the module is blocked. */
  reason?: string;
  /** Modules to use instead. */
  recommendations?: string[];
}

interface Config {
  /** Modules that may be required. Empty allows any not blocked. */
  allowed: AllowedModule[];
  /** Modules that may not be required. */
  blocked: BlockedModule[];
  /** Block modules replaced with local directories holding another module. */
  localReplaceDirectives: boolean;
}

export default defineAnalyzer<Config>({
  name: "gomodguard_v2",
  doc: `allow and block lists for direct module dependencies

Reports imports of packages in required modules that are blocked, not
allowed, outside a version constraint, or replaced with local directories.
Rules match module paths exactly, by prefix, or by regular expression.`,
  config: { allowed: [], blocked: [], localReplaceDirectives: false },
  run(pass) {
    const goMod = loadGoMod(pass);
    if (goMod !== null) {
      reportImports(pass, blockedModules(pass.config, goMod.file, goMod.dir));
    }
  },
});

type Rule = { module: string; version?: string; matchType?: string };

// RuleIndex finds the rule for a module: an exact match first, then the
// longest prefix, then the first regular expression in sorted order.
class RuleIndex<R extends Rule> {
  private readonly exact = new Map<string, R>();
  private readonly prefixes: { rule: R; prefix: string }[] = [];
  private readonly patterns: { rule: R; pattern: RegExp }[] = [];

  constructor(rules: readonly R[]) {
    // Later rules for the same module replace earlier ones.
    const byModule = new Map<string, R>();
    for (const rule of rules) {
      byModule.set(rule.module, rule);
    }
    for (const [module, rule] of byModule) {
      switch (rule.matchType ?? "") {
        case "prefix":
          this.prefixes.push({ rule, prefix: module.trim().toLowerCase() });
          break;
        case "regex":
          this.patterns.push({ rule, pattern: new RegExp(module.trim().replace(/\(\?P</g, "(?<")) });
          break;
        case "exact":
        case "":
          this.exact.set(module.trim(), rule);
          break;
        default:
          throw new Error(`unknown match-type ${JSON.stringify(rule.matchType)} for pattern ${JSON.stringify(module)}`);
      }
    }
    this.prefixes.sort((a, b) => b.rule.module.length - a.rule.module.length);
    this.patterns.sort((a, b) => (a.rule.module < b.rule.module ? -1 : a.rule.module > b.rule.module ? 1 : 0));
  }

  find(module: string): R | undefined {
    const trimmed = module.trim();
    return (
      this.exact.get(trimmed) ??
      this.prefixes.find(({ prefix }) => trimmed.toLowerCase().startsWith(prefix))?.rule ??
      this.patterns.find(({ pattern }) => pattern.test(trimmed))?.rule
    );
  }
}

function blockedModules(config: Pass<Config>["config"], file: modfile.File, dir: string): BlockedModules {
  const blocked: BlockedModules = new Map();
  const add = (module: string, reason: string) => blocked.set(module, [...(blocked.get(module) ?? []), reason]);
  const current = (file.module?.mod as ModuleVersion | undefined)?.path ?? "";
  const blockedIndex = new RuleIndex(config.blocked);
  const allowedIndex = new RuleIndex(config.allowed);
  const constraints = new Map<string, Constraints>();
  const constraint = (text: string | undefined): Constraints | undefined => {
    if (text === undefined || text === "") {
      return undefined;
    }
    let parsed = constraints.get(text);
    if (parsed === undefined) {
      parsed = newConstraint(text);
      constraints.set(text, parsed);
    }
    return parsed;
  };
  // Upstream parses every constraint with its config, so an invalid one
  // fails even when no module matches its rule.
  for (const rule of [...config.blocked, ...config.allowed]) {
    constraint(rule.version);
  }
  for (const require of file.require) {
    const mod = require!.mod as ModuleVersion;
    const name = mod.path.trim();
    const version = mod.version.trim();
    let rule = blockedIndex.find(name);
    if (rule !== undefined && isRecommended(current, rule.recommendations ?? [])) {
      rule = undefined;
    }
    if (rule !== undefined) {
      const ruleConstraint = constraint(rule.version);
      if (ruleConstraint !== undefined) {
        let matches: boolean;
        try {
          matches = ruleConstraint.check(newVersion(version));
        } catch (error) {
          add(name, `${blockReasonInBlockedList} unable to parse version \`${version}\`: ${(error as Error).message}`);
          continue;
        }
        if (!matches) {
          rule = undefined;
        }
      }
    }
    if (rule !== undefined) {
      add(name, `${blockReasonInBlockedList} ${blockReason(rule, constraint(rule.version), version)}`);
      continue;
    }
    if (config.allowed.length === 0) {
      continue;
    }
    const allowedRule = allowedIndex.find(name);
    const allowedConstraint = allowedRule === undefined ? undefined : constraint(allowedRule.version);
    if (allowedRule !== undefined && allowedConstraint === undefined) {
      continue;
    }
    let notAllowed = "the module is not in the allowed modules list.";
    if (allowedConstraint !== undefined) {
      try {
        if (allowedConstraint.check(newVersion(version))) {
          continue;
        }
      } catch (error) {
        add(name, `import of package \`%s\` is blocked because the module version \`${version}\` could not be parsed: ${(error as Error).message}`);
        continue;
      }
      notAllowed = `version \`${version}\` does not meet the allowed version constraint \`${allowedConstraint.string()}\`.`;
    }
    add(name, `import of package \`%s\` is blocked because ${notAllowed}`);
  }
  if (config.localReplaceDirectives) {
    for (const replace of file.replace) {
      const [old, replacement] = [replace!.old as ModuleVersion, replace!.new as ModuleVersion];
      if (isBlockedLocalReplace(old, replacement, dir)) {
        add(old.path, blockReasonHasLocalReplaceDirective);
      }
    }
  }
  return blocked;
}

function blockReason(rule: Pass<Config>["config"]["blocked"][number], constraint: Constraints | undefined, version: string): string {
  const parts: string[] = [];
  if (constraint !== undefined) {
    parts.push(`version \`${version}\` is blocked because it does not meet the version constraint \`${constraint.string()}\`.`);
  }
  if ((rule.recommendations ?? []).length > 0) {
    parts.push(recommendations(rule.recommendations ?? []));
  }
  if ((rule.reason ?? "") !== "") {
    parts.push(sentence(rule.reason ?? ""));
  }
  return parts.join(" ");
}

// isBlockedLocalReplace reports whether a replacement is a local directory
// that does not hold the replaced module. Upstream resolves relative
// directories against its working directory; the go.mod's is used here.
function isBlockedLocalReplace(old: ModuleVersion, replacement: ModuleVersion, dir: string): boolean {
  if (replacement.path === "" || replacement.version !== "") {
    return false;
  }
  const path = filepath.isAbs(replacement.path) ? replacement.path : filepath.join(dir, replacement.path);
  try {
    const file = modfileParser.parse("go.mod", os.readFile(filepath.join(path, "go.mod")), null)!;
    return (file.module?.mod as ModuleVersion | undefined)?.path !== old.path;
  } catch {
    return true;
  }
}
