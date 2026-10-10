import * as os from "os";
import * as filepath from "path/filepath";
import { isVersionPath, normalizePath } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "package-directory-mismatch";

export interface Options {
  /** Directories not to check: a file is skipped if its directory's path contains one. */
  ignoreDirectories: string[];
}

export const defaults: Options = { ignoreDirectories: ["testdata"] };

// Base names filepath.Base can return for paths with no directory name.
const skipDirs = new Set([".", "/", ""]);

export function create(options: DeepReadonly<Options>): Rule {
  const ignored = options.ignoreDirectories;
  return {
    name,
    apply(file: File): Failure[] {
      if (file.pkg.isMain()) {
        return [];
      }
      const dirPath = filepath.dir(filepath.abs(file.name));
      const dirName = filepath.base(dirPath);
      if (ignored.some((dir) => dirPath.includes(dir)) || skipDirs.has(dirName)) {
        return [];
      }
      // Files directly in internal/ are not checked, unlike those below it.
      if (dirName === "internal") {
        return [];
      }
      const packageName = file.ast.name!.name;
      if (semanticallyEqual(packageName, dirName) || isRootDir(dirPath)) {
        return [];
      }
      if (file.isTest() && (packageName === "main_test" || semanticallyEqual(packageName, `${dirName}_test`))) {
        return [];
      }
      let failure = `package name ${JSON.stringify(packageName)} does not match directory name ${JSON.stringify(dirName)}`;
      // A major version directory may instead match its parent.
      if (isVersionPath(dirName)) {
        const parentDirName = filepath.base(filepath.dir(dirPath));
        if (semanticallyEqual(packageName, parentDirName) || (file.isTest() && semanticallyEqual(packageName, `${parentDirName}_test`))) {
          return [];
        }
        failure = `package name ${JSON.stringify(packageName)} does not match directory name ${JSON.stringify(dirName)} or parent directory name ${JSON.stringify(parentDirName)}`;
      }
      return [{ failure, confidence: 1, node: file.ast.name! }];
    },
  };
}

function semanticallyEqual(packageName: string, dirName: string): boolean {
  const normDir = normalizePath(dirName);
  const normPkg = normalizePath(packageName);
  return normDir === normPkg || normDir === `go${normPkg}`;
}

// isRootDir reports whether dirPath holds a go.mod or .git.
function isRootDir(dirPath: string): boolean {
  try {
    return os.readDir(dirPath).some((e) => e!.name() === "go.mod" || e!.name() === ".git");
  } catch {
    return false;
  }
}
