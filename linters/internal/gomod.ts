import * as os from "os";
import * as filepath from "path/filepath";

// ModuleVersion is golang.org/x/mod/module.Version, which scripts cannot import.
export interface ModuleVersion {
  path: string;
  version: string;
}

// findGoMod finds the nearest go.mod at or above a directory.
export function findGoMod(dir: string): { path: string; content: string } | null {
  for (;;) {
    const path = filepath.join(dir, "go.mod");
    try {
      return { path, content: os.readFile(path) };
    } catch {
      const parent = filepath.dir(dir);
      if (parent === dir) {
        return null;
      }
      dir = parent;
    }
  }
}
