import { defineAnalyzer } from "tsk";

interface Config {
  /** Report LEFT-TO-RIGHT-EMBEDDING, U+202A. */
  leftToRightEmbedding: boolean;
  /** Report RIGHT-TO-LEFT-EMBEDDING, U+202B. */
  rightToLeftEmbedding: boolean;
  /** Report POP-DIRECTIONAL-FORMATTING, U+202C. */
  popDirectionalFormatting: boolean;
  /** Report LEFT-TO-RIGHT-OVERRIDE, U+202D. */
  leftToRightOverride: boolean;
  /** Report RIGHT-TO-LEFT-OVERRIDE, U+202E. */
  rightToLeftOverride: boolean;
  /** Report LEFT-TO-RIGHT-ISOLATE, U+2066. */
  leftToRightIsolate: boolean;
  /** Report RIGHT-TO-LEFT-ISOLATE, U+2067. */
  rightToLeftIsolate: boolean;
  /** Report FIRST-STRONG-ISOLATE, U+2068. */
  firstStrongIsolate: boolean;
  /** Report POP-DIRECTIONAL-ISOLATE, U+2069. */
  popDirectionalIsolate: boolean;
}

const runes: [keyof Config, string, string][] = [
  ["leftToRightEmbedding", "LEFT-TO-RIGHT-EMBEDDING", "‪"],
  ["rightToLeftEmbedding", "RIGHT-TO-LEFT-EMBEDDING", "‫"],
  ["popDirectionalFormatting", "POP-DIRECTIONAL-FORMATTING", "‬"],
  ["leftToRightOverride", "LEFT-TO-RIGHT-OVERRIDE", "‭"],
  ["rightToLeftOverride", "RIGHT-TO-LEFT-OVERRIDE", "‮"],
  ["leftToRightIsolate", "LEFT-TO-RIGHT-ISOLATE", "⁦"],
  ["rightToLeftIsolate", "RIGHT-TO-LEFT-ISOLATE", "⁧"],
  ["firstStrongIsolate", "FIRST-STRONG-ISOLATE", "⁨"],
  ["popDirectionalIsolate", "POP-DIRECTIONAL-ISOLATE", "⁩"],
];

export default defineAnalyzer<Config>({
  name: "bidichk",
  doc: `check for dangerous unicode character sequences

Bidirectional control characters make source display differently from how it
compiles, as in the Trojan Source attack.`,
  url: "https://github.com/breml/bidichk",
  config: {
    leftToRightEmbedding: true,
    rightToLeftEmbedding: true,
    popDirectionalFormatting: true,
    leftToRightOverride: true,
    rightToLeftOverride: true,
    leftToRightIsolate: true,
    rightToLeftIsolate: true,
    firstStrongIsolate: true,
    popDirectionalIsolate: true,
  },
  run(pass) {
    const names = new Map(runes.filter(([option]) => pass.config[option]).map(([, name, char]) => [char, name]));
    for (const file of pass.files) {
      const body = pass.readFile(pass.fset.file(file.fileStart)!.name());
      if (![...names.keys()].some((char) => body.includes(char))) {
        continue;
      }
      // Positions count UTF-8 bytes, while JavaScript strings count UTF-16 units.
      let offset = 0;
      for (const char of body) {
        const name = names.get(char);
        if (name !== undefined) {
          pass.report({ pos: file.fileStart + offset, message: `found dangerous unicode character sequence ${name}` });
        }
        offset += utf8Length(char.codePointAt(0)!);
      }
    }
  },
});

function utf8Length(code: number): number {
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}
