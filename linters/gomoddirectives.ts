import type * as modfile from "golang.org/x/mod/modfile";
import * as parser from "golang.org/x/mod/modfile";
import * as os from "os";
import * as filepath from "path/filepath";
import { defineAnalyzer, type Pass } from "tsk";

interface Config {
  /** Modules whose non-local replacements are allowed. */
  replaceAllowList: string[];
  /** Allow replacements with local directories. */
  replaceLocal: boolean;
  /** Allow every replacement. */
  replaceAllowAll: boolean;
  /** Forbid exclude directives. */
  excludeForbidden: boolean;
  /** Forbid ignore directives. */
  ignoreForbidden: boolean;
  /** Allow retract directives without a comment explaining them. */
  retractAllowNoExplanation: boolean;
  /** Forbid the toolchain directive. */
  toolchainForbidden: boolean;
  /** A regular expression the toolchain directive must match. */
  toolchainPattern: string;
  /** Forbid tool directives. */
  toolForbidden: boolean;
  /** Forbid godebug directives. */
  goDebugForbidden: boolean;
  /** A regular expression the go directive's version must match. */
  goVersionPattern: string;
}

interface Finding {
  line: modfile.Line;
  reason: string;
}

export default defineAnalyzer<Config>({
  name: "gomoddirectives",
  doc: `manage the use of replace, retract, exclude, and other directives in go.mod

Reports replacements, which break the module for its users, retractions
without an explanation, ignore directives for paths Go already ignores, and
optionally other directives. Findings are reported in the go.mod of each
package's module.`,
  url: "https://github.com/ldez/gomoddirectives",
  config: {
    replaceAllowList: [],
    replaceLocal: false,
    replaceAllowAll: false,
    excludeForbidden: false,
    ignoreForbidden: false,
    retractAllowNoExplanation: false,
    toolchainForbidden: false,
    toolchainPattern: "",
    toolForbidden: false,
    goDebugForbidden: false,
    goVersionPattern: "",
  },
  run(pass) {
    if (pass.files.length === 0) {
      return;
    }
    const goMod = findGoMod(filepath.dir(pass.fset.file(pass.files[0].pos())!.name()));
    if (goMod === null) {
      return;
    }
    const file = parser.parse("go.mod", goMod.content, null)!;
    const findings = analyze(pass.config, file);
    if (findings.length === 0) {
      return;
    }
    // go.mod is not among the package's files, so it is added to the file set
    // to position findings in it. Packages of one module report the same findings.
    const tokenFile = pass.fset.addFile(goMod.path, -1, utf8Length(goMod.content))!;
    tokenFile.setLinesForContent(goMod.content);
    const lines = goMod.content.split("\n");
    for (const { line, reason } of findings) {
      const start = line.start!;
      const column = utf8Length([...lines[start.line - 1]].slice(0, start.lineRune - 1).join(""));
      pass.report({ pos: tokenFile.lineStart(start.line) + column, message: reason });
    }
  },
});

// findGoMod finds the nearest go.mod at or above a directory.
function findGoMod(dir: string): { path: string; content: string } | null {
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

function analyze(config: Pass<Config>["config"], file: modfile.File): Finding[] {
  const findings: Finding[] = [];
  const add = (line: modfile.Line | null, reason: string) => findings.push({ line: line!, reason });
  if (!config.retractAllowNoExplanation) {
    for (const retract of file.retract) {
      if (retract!.rationale === "") {
        add(retract!.syntax, "a comment is mandatory to explain why the version has been retracted");
      }
    }
  }
  if (config.excludeForbidden) {
    for (const exclude of file.exclude) {
      add(exclude!.syntax, "exclude directive is not allowed");
    }
  }
  if (config.toolForbidden) {
    for (const tool of file.tool) {
      add(tool!.syntax, "tool directive is not allowed");
    }
  }
  for (const ignore of file.ignore) {
    for (const element of filepath.clean(ignore!.path).split("/")) {
      if (element === "vendor" || element === "testdata") {
        add(ignore!.syntax, `directories named '${element}' are ignored by default`);
      } else if (element !== "." && (element.startsWith(".") || element.startsWith("_"))) {
        add(ignore!.syntax, "files/directories starting with '.' and '_' are ignored by default");
      }
    }
  }
  if (config.ignoreForbidden) {
    for (const ignore of file.ignore) {
      add(ignore!.syntax, "ignore directive is not allowed");
    }
  }
  const seen = new Set<string>();
  for (const replace of file.replace) {
    const r = replace!;
    const [old, replacement] = [r.old as ModuleVersion, r.new as ModuleVersion];
    const reason = replaceReason(config, old, replacement);
    if (reason !== "") {
      add(r.syntax, reason);
      continue;
    }
    if (old.path === replacement.path && old.version === replacement.version) {
      add(r.syntax, "the original module and the replacement are identical");
      continue;
    }
    const key = old.path + old.version;
    if (seen.has(key)) {
      add(r.syntax, "multiple replacement of the same module");
    }
    seen.add(key);
  }
  const toolchain = file.toolchain;
  if (toolchain !== null) {
    if (config.toolchainForbidden) {
      add(toolchain.syntax, "toolchain directive is not allowed");
    } else if (config.toolchainPattern !== "" && !new RegExp(config.toolchainPattern).test(toolchain.name)) {
      add(toolchain.syntax, `toolchain directive (${toolchain.name}) doesn't match the pattern '${config.toolchainPattern}'`);
    }
  }
  if (config.goDebugForbidden) {
    for (const godebug of file.godebug) {
      add(godebug!.syntax, "godebug directive is not allowed");
    }
  }
  const go = file.go;
  if (go !== null && config.goVersionPattern !== "" && !new RegExp(config.goVersionPattern).test(go.version)) {
    add(go.syntax, `go directive (${go.version}) doesn't match the pattern '${config.goVersionPattern}'`);
  }
  return findings;
}

// ModuleVersion is golang.org/x/mod/module.Version, which scripts cannot import.
interface ModuleVersion {
  path: string;
  version: string;
}

function replaceReason(config: Pass<Config>["config"], old: ModuleVersion, replacement: ModuleVersion): string {
  if (config.replaceAllowAll) {
    return "";
  }
  // A replacement with a directory has no version.
  if (replacement.version.trim() === "") {
    return config.replaceLocal ? "" : `local replacement are not allowed: ${old.path}`;
  }
  return config.replaceAllowList.includes(old.path) ? "" : `replacement are not allowed: ${old.path}`;
}

function utf8Length(text: string): number {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return length;
}
