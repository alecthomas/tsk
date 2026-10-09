import { defineAnalyzer } from "tsk";

interface Config {
  /** Pattern for paths of test files to skip; "^$" skips none. */
  skipRegexp: string;
  /** Packages whose tests need not be in a _test package. */
  allowPackages: string[];
}

export default defineAnalyzer<Config>({
  name: "testpackage",
  doc: "linter that makes you use a separate _test package",
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: { skipRegexp: "(export|internal)_test\\.go", allowPackages: ["main"] },
  run(pass) {
    const skip = new RegExp(pass.config.skipRegexp);
    for (const file of pass.files) {
      const filename = pass.fset.position(file!.pos()).filename;
      const name = file!.name!.name;
      if (!filename.endsWith("_test.go") || skip.test(filename) || pass.config.allowPackages.includes(name) || name.endsWith("_test")) {
        continue;
      }
      pass.report({ pos: file!.name!.pos(), message: `package should be \`${name}_test\` instead of \`${name}\`` });
    }
  },
});
