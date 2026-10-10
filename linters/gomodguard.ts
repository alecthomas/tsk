import type * as modfile from "golang.org/x/mod/modfile";
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
import { newConstraint, newVersion } from "./internal/semver";

interface BlockedModule {
  /** Modules to use instead. */
  recommendations?: string[];
  /** Why the module is blocked. */
  reason?: string;
}

interface BlockedVersion {
  /** A version constraint, as ">= 1.2, < 2"; versions meeting it are blocked. */
  version?: string;
  /** Why the versions are blocked. */
  reason?: string;
}

interface Config {
  allowed: {
    /** Modules that may be required. With no allowed modules or domains, any may. */
    modules: string[];
    /** Module path prefixes, such as golang.org, that may be required. */
    domains: string[];
  };
  blocked: {
    /** Modules that may not be required, each a table keyed by module path. */
    modules: Record<string, BlockedModule>[];
    /** Module versions that may not be required, keyed by module path. */
    versions: Record<string, BlockedVersion>[];
    /** Block modules replaced with local directories. */
    localReplaceDirectives: boolean;
  };
}

const blockReasonNotInAllowedList = "import of package `%s` is blocked because the module is not in the allowed modules list.";
const blockReasonInvalidVersionConstraint = "import of package `%s` is blocked because the version constraint is invalid.";

export default defineAnalyzer<Config>({
  name: "gomodguard",
  doc: `allow and block lists for direct module dependencies

Reports imports of packages in required modules that are not allowed, are
blocked, have blocked versions, or are replaced with local directories.`,
  config: {
    allowed: { modules: [], domains: [] },
    blocked: { modules: [], versions: [], localReplaceDirectives: false },
  },
  run(pass) {
    const goMod = loadGoMod(pass);
    if (goMod !== null) {
      reportImports(pass, blockedModules(pass.config, goMod.file.module?.mod as ModuleVersion | undefined, goMod.file));
    }
  },
});

// blockedModules works out which required modules are blocked and why.
function blockedModules(config: Pass<Config>["config"], current: ModuleVersion | undefined, file: modfile.File): BlockedModules {
  const blocked: BlockedModules = new Map();
  const add = (module: string, reason: string) => blocked.set(module, [...(blocked.get(module) ?? []), reason]);
  const { allowed } = config;
  for (const require of file.require) {
    const mod = require!.mod as ModuleVersion;
    const name = mod.path.trim();
    const version = mod.version.trim();
    const isAllowed =
      (allowed.modules.length === 0 && allowed.domains.length === 0) ||
      allowed.domains.some((domain) => name.toLowerCase().startsWith(domain.trim().toLowerCase())) ||
      allowed.modules.some((module) => module.trim() === name);
    const blockedModule = findRule(config.blocked.modules, name);
    const blockedVersion = findRule(config.blocked.versions, name);
    if (!isAllowed && blockedModule === undefined && blockedVersion === undefined) {
      add(name, blockReasonNotInAllowedList);
      continue;
    }
    if (blockedModule !== undefined && !isRecommended(current?.path ?? "", blockedModule.recommendations ?? [])) {
      add(name, `${blockReasonInBlockedList} ${moduleMessage(blockedModule)}`);
    }
    const constraint = blockedVersion?.version ?? "";
    if (constraint !== "") {
      try {
        if (newConstraint(constraint).check(newVersion(version))) {
          add(name, `${blockReasonInBlockedList} ${versionMessage(constraint, blockedVersion?.reason ?? "", version)}`);
        }
      } catch (error) {
        // An invalid constraint or version blocks the module.
        add(name, `${blockReasonInvalidVersionConstraint} ${(error as Error).message}`);
      }
    }
  }
  if (config.blocked.localReplaceDirectives) {
    for (const replace of file.replace) {
      const [old, replacement] = [replace!.old as ModuleVersion, replace!.new as ModuleVersion];
      if (replacement.path.trim() !== "" && replacement.version.trim() === "") {
        add(old.path.trim(), blockReasonHasLocalReplaceDirective);
      }
    }
  }
  return blocked;
}

// findRule returns the first rule for a module, from a list of tables keyed
// by module path.
function findRule<R>(rules: readonly Readonly<Record<string, R>>[], module: string): R | undefined {
  for (const rule of rules) {
    for (const [name, value] of Object.entries(rule)) {
      if (name.trim() === module.trim()) {
        return value;
      }
    }
  }
  return undefined;
}

function moduleMessage(rule: Pass<Config>["config"]["blocked"]["modules"][number][string]): string {
  const text = recommendations(rule.recommendations ?? []);
  const reason = rule.reason ?? "";
  if (reason === "") {
    return text;
  }
  return text === "" ? sentence(reason) : `${text} ${sentence(reason)}`;
}

function versionMessage(constraint: string, reason: string, version: string): string {
  const text = `version \`${version}\` is blocked because it does not meet the version constraint \`${constraint}\`.`;
  return reason === "" ? text : `${text} ${sentence(reason)}`;
}
