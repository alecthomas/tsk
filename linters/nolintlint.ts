import { defineAnalyzer } from "tsk";

interface Config {
  /**
   * Allow directives that suppress nothing. tsk cannot tell which directives
   * suppressed a finding, so unused directives are never reported.
   */
  allowUnused: boolean;
  /** Linters whose directives need no explanation. */
  allowNoExplanation: string[];
  /** Require an explanation after each directive, as in //nolint:x // why. */
  requireExplanation: boolean;
  /** Require directives to name the linters they suppress. */
  requireSpecific: boolean;
}

// A directive is a line comment starting with nolint, after optional space.
const directive = /^\/\/(\s*)nolint\b/;
// A well-formed directive names linters after a colon and explains itself
// after another //.
const wellFormed = /^nolint(?::\s*([\w-]+(?:\s*,\s*[\w-]+)*))?\s*(?:\/\/(.*))?$/;

export default defineAnalyzer<Config>({
  name: "nolintlint",
  doc: `reports ill-formed or insufficient nolint directives

Directives must be written //nolint[:linter,...] [// explanation], without a
space before nolint. Options can require naming the linters and explaining
why. This is an original implementation of golangci-lint's nolintlint, which
is GPL-licensed, matching its messages; it does not report unused directives.`,
  config: { allowUnused: true, allowNoExplanation: [], requireExplanation: false, requireSpecific: false },
  runDespiteErrors: true,
  // A directive must not hide findings about itself.
  nolint: false,
  run(pass) {
    const config = pass.config;
    for (const file of pass.files) {
      for (const group of file!.comments) {
        for (const comment of group!.list) {
          const text = comment!.text;
          const match = directive.exec(text);
          if (match === null) {
            continue;
          }
          const leading = match[1]!;
          const rest = text.slice(2 + leading.length);
          const pos = comment!.slash;
          const report = (message: string) => pass.report({ pos, message: `directive \`${text}\` ${message}` });
          if (leading !== "") {
            pass.report({
              pos,
              end: comment!.end(),
              message: `directive \`${text}\` should be written without leading space as \`//${rest}\``,
              suggestedFixes: [{ message: "Remove leading space", textEdits: [{ pos, end: comment!.end(), newText: `//${rest}` }] }],
            });
          }
          const parts = wellFormed.exec(rest);
          if (parts === null) {
            // The expected form starts with what precedes the linters or the
            // explanation.
            const base = rest.split(/:|\/\//)[0]!.trim();
            report(`should match \`//${leading === "" ? "" : " "}${base}[:<comma-separated-linters>] [// <explanation>]\``);
            continue;
          }
          const linters = parts[1] === undefined ? [] : parts[1].split(",").map((name) => name.trim());
          if (config.requireSpecific && (linters.length === 0 || linters.includes("all"))) {
            report("should mention specific linter such as `//nolint:my-linter`");
          }
          const explained = (parts[2] ?? "").trim() !== "";
          const exempt = linters.length > 0 && linters.every((name) => config.allowNoExplanation.includes(name));
          if (config.requireExplanation && !explained && !exempt) {
            const unexplained = (parts[2] === undefined ? text : text.slice(0, text.lastIndexOf("//"))).trimEnd();
            report(`should provide explanation such as \`${unexplained} // this is why\``);
          }
        }
      }
    }
  },
});
