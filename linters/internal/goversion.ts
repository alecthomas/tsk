// Helpers from golang.org/x/tools/internal/versions and
// internal/analysis/analyzerutil, which many of the ported vet analyzers share.
import type * as ast from "go/ast";
import * as version from "go/version";
import type { Pass } from "tsk";

// An empty file version is an unknown future one, after every release.
const future = "";

/** Reports whether the file version v is at least the Go release, such as "go1.22". */
export function atLeast(v: string, release: string): boolean {
  return v === future || version.compare(version.lang(v), version.lang(release)) >= 0;
}

/** Reports whether the file version v is strictly before the Go release. */
export function before(v: string, release: string): boolean {
  return v !== future && version.compare(version.lang(v), version.lang(release)) < 0;
}

/**
 * Reports whether file may use features of the Go release, and false when its
 * version is unknown, as for ignored files. Unlike upstream, standard library
 * bootstrap packages are not held to the bootstrap toolchain's version.
 */
export function fileUsesGoVersion(pass: Pass<unknown>, file: ast.File, release: string): boolean {
  const fileVersion = pass.typesInfo.fileVersions.get(file);
  return fileVersion !== undefined && !before(fileVersion, release);
}
