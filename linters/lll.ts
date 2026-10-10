import { defineAnalyzer } from "tsk";

interface Config {
  /** The width of a tab, in characters. */
  tabWidth: number;
  /** The longest line allowed, in characters. */
  lineLength: number;
}

export default defineAnalyzer<Config>({
  name: "lll",
  doc: `reports long lines

Lines are measured in characters, with tabs as tab-width. Imports and
//go: directives, such as //go:generate, may be longer.`,
  config: { tabWidth: 1, lineLength: 120 },
  runDespiteErrors: true,
  run(pass) {
    const { tabWidth, lineLength } = pass.config;
    const spaces = " ".repeat(tabWidth);
    for (const file of pass.files) {
      const tokenFile = pass.fset.file(file!.fileStart)!;
      const lines = pass.readFile(tokenFile.name()).split("\n");
      // Imports are found by text, as golangci-lint does: a line starting
      // with import, which also ends any open block, and every line of a
      // block until a line that is just ")".
      let inImports = false;
      lines.forEach((raw, i) => {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.startsWith("import")) {
          inImports = line.endsWith("(");
          return;
        }
        if (inImports) {
          inImports = line !== ")";
          return;
        }
        // Directives, such as //go:generate, may be long.
        if (line.startsWith("//go:")) {
          return;
        }
        const length = [...line.split("\t").join(spaces)].length;
        if (length > lineLength) {
          pass.report({
            pos: tokenFile.lineStart(i + 1),
            message: `The line is ${length} characters long, which exceeds the maximum of ${lineLength} characters.`,
          });
        }
      });
    }
  },
});
