// Shared by gomodguard and gomodguard_v2, ported from
// github.com/ryancurrah/gomodguard (MIT license).
import * as modfile from "golang.org/x/mod/modfile";
import * as filepath from "path/filepath";
import type { Pass } from "tsk";
import { findGoMod } from "../internal/gomod";

// BlockedModules maps module paths to the reasons importing them is blocked.
// Each reason holds a %s for the imported package.
export type BlockedModules = Map<string, string[]>;

export const blockReasonInBlockedList = "import of package `%s` is blocked because the module is in the blocked modules list.";
export const blockReasonHasLocalReplaceDirective = "import of package `%s` is blocked because the module has a local replace directive.";

// GoMod is the go.mod governing a package, and its directory.
export interface GoMod {
  file: modfile.File;
  dir: string;
}

// loadGoMod parses the nearest go.mod above the package. Upstream reads the
// go.mod of the directory golangci-lint runs in; the nearest one is the same
// for a single module and right for each module of a workspace.
export function loadGoMod<C>(pass: Pass<C>): GoMod | null {
  if (pass.files.length === 0) {
    return null;
  }
  const goMod = findGoMod(filepath.dir(pass.fset.file(pass.files[0]!.pos())!.name()));
  if (goMod === null) {
    return null;
  }
  return { file: modfile.parse("go.mod", goMod.content, null)!, dir: filepath.dir(goMod.path) };
}

// reportImports reports each import of a package in a blocked module.
export function reportImports<C>(pass: Pass<C>, blocked: BlockedModules): void {
  for (const file of pass.files) {
    for (const spec of file!.imports) {
      const pkg = spec!.path!.value.replace(/^"+|"+$/g, "").trim();
      for (const [module, reasons] of blocked) {
        if (isPackageInModule(pkg, module)) {
          for (const reason of reasons) {
            pass.report({ pos: spec!.pos(), message: formatReason(reason, pkg) });
          }
          break;
        }
      }
    }
  }
}

// isPackageInModule reports whether a package path is in a module, and not
// in a later major version of it.
function isPackageInModule(pkg: string, module: string): boolean {
  const pkgParts = pkg.split("/");
  const moduleParts = module.split("/");
  if (moduleParts.some((part, i) => pkgParts[i] !== part)) {
    return false;
  }
  return !(pkgParts.length > moduleParts.length && /^v[0-9]+/.test(pkgParts[moduleParts.length]!));
}

// formatReason fills a reason's %s with the package, as fmt.Sprintf does.
function formatReason(reason: string, pkg: string): string {
  let filled = false;
  return reason.replace(/%%|%s/g, (verb) => {
    if (verb === "%%") {
      return "%";
    }
    if (filled) {
      return "%!s(MISSING)";
    }
    filled = true;
    return pkg;
  });
}

// recommendations lists recommended modules in a sentence.
export function recommendations(modules: readonly string[]): string {
  let text = "";
  modules.forEach((module, i) => {
    if (modules.length === 1) {
      text += `\`${module}\` is a recommended module.`;
    } else if (i + 1 !== modules.length && i + 1 === modules.length - 1) {
      text += `\`${module}\` `;
    } else if (i + 1 !== modules.length) {
      text += `\`${module}\`, `;
    } else {
      text += `and \`${module}\` are recommended modules.`;
    }
  });
  return text;
}

// sentence ends a reason with one period.
export function sentence(reason: string): string {
  return `${reason.replace(/\.+$/, "")}.`;
}

// isRecommended reports whether the current module is among the
// recommendations, which may then import the blocked module.
export function isRecommended(current: string, recommended: readonly string[]): boolean {
  return recommended.some((module) => module.trim() === current.trim());
}
