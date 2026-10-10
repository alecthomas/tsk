import type { Failure, File, Rule } from "../lint";

export const name = "redundant-build-tag";

export function create(): Rule {
  return { name, apply };
}

const oldGoBuildPrefix = "// +build";

function apply(file: File): Failure[] {
  const goVersion = lang(`go${file.pkg.goVersion}`);
  for (const group of file.ast.comments) {
    let hasGoBuild = false;
    for (const comment of group!.list) {
      const text = comment!.text;
      if (text.startsWith("//go:build ")) {
        hasGoBuild = true;
        const ver = text.slice("//go:build ".length);
        // Since Go 1.21 the go.mod version is a requirement, so a constraint it satisfies is redundant.
        if (file.pkg.isAtLeastGoVersion("1.21") && isValid(ver) && compare(goVersion, ver) >= 0) {
          return [
            {
              failure: `The build tag ${JSON.stringify(text)} is redundant for Go ${goVersion.slice(2)} and can be removed`,
              node: comment!,
              confidence: 1,
            },
          ];
        }
        continue;
      }
      if (hasGoBuild && text.startsWith(oldGoBuildPrefix)) {
        return [{ failure: `The build tag "${oldGoBuildPrefix}" is redundant since Go 1.17 and can be removed`, node: comment!, confidence: 1 }];
      }
    }
  }
  return [];
}

// The functions below port go/version and internal/gover.

interface Version {
  major: string;
  minor: string;
  patch: string;
  kind: string;
  pre: string;
}

function stripGo(v: string): string {
  const s = v.split("-")[0];
  return s.startsWith("go") ? s.slice(2) : "";
}

function isValid(x: string): boolean {
  return parse(stripGo(x)) !== undefined;
}

function lang(x: string): string {
  const v = parse(stripGo(x));
  if (v === undefined) {
    return "";
  }
  return v.minor === "" || (v.major === "1" && v.minor === "0") ? `go${v.major}` : `go${v.major}.${v.minor}`;
}

function compare(x: string, y: string): number {
  const empty: Version = { major: "", minor: "", patch: "", kind: "", pre: "" };
  const vx = parse(stripGo(x)) ?? empty;
  const vy = parse(stripGo(y)) ?? empty;
  return (
    cmpInt(vx.major, vy.major) ||
    cmpInt(vx.minor, vy.minor) ||
    cmpInt(vx.patch, vy.patch) ||
    (vx.kind < vy.kind ? -1 : vx.kind > vy.kind ? 1 : 0) ||
    cmpInt(vx.pre, vy.pre)
  );
}

function parse(x: string): Version | undefined {
  const match = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*)|([a-z]+)(0|[1-9]\d*)?)?)?$/.exec(x);
  if (match === null) {
    return undefined;
  }
  const [, major, minor, patch, kind, pre] = match;
  if (minor === undefined) {
    return { major, minor: "0", patch: "0", kind: "", pre: "" };
  }
  if (patch === undefined && kind === undefined) {
    return { major, minor, patch: cmpInt(minor, "21") < 0 ? "0" : "", kind: "", pre: "" };
  }
  return { major, minor, patch: patch ?? "", kind: kind ?? "", pre: pre ?? "" };
}

function cmpInt(x: string, y: string): number {
  if (x === y) {
    return 0;
  }
  if (x.length !== y.length) {
    return x.length < y.length ? -1 : 1;
  }
  return x < y ? -1 : 1;
}
