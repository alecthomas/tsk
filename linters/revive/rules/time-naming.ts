import * as ast from "go/ast";
import type * as types from "go/types";
import type { Failure, File, Rule } from "../lint";

export const name = "time-naming";

// Name suffixes that imply a time unit; not an exhaustive list.
const timeSuffixes = [
  "Hour",
  "Hours",
  "Min",
  "Mins",
  "Minutes",
  "Minute",
  "Sec",
  "Secs",
  "Seconds",
  "Second",
  "Msec",
  "Msecs",
  "Milli",
  "Millis",
  "Milliseconds",
  "Millisecond",
  "Usec",
  "Usecs",
  "Microseconds",
  "Microsecond",
  "MS",
  "Ms",
];

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  ast.inspect(file.ast, (node) => {
    if (node === null || node.$type !== "ValueSpec") {
      return true;
    }
    const v = node as ast.ValueSpec;
    for (const id of v.names) {
      const origTyp = file.pkg.typeOf(id!);
      // Look for time.Duration or *time.Duration, as flag.Duration returns.
      let typ = origTyp;
      if (typ !== null && typ.$type === "Pointer") {
        typ = (typ as types.Pointer).elem();
      }
      if (!isNamedType(typ, "time", "Duration")) {
        continue;
      }
      const suffix = timeSuffixes.find((suf) => id!.name.endsWith(suf));
      if (suffix === undefined) {
        continue;
      }
      failures.push({
        failure: `var ${id!.name} is of type ${origTyp!.string()}; don't use unit-specific suffix ${JSON.stringify(suffix)}`,
        confidence: 0.9,
        node: v,
      });
    }
    return true;
  });
  return failures;
}

function isNamedType(typ: types.Type | null, importPath: string, typeName: string): boolean {
  if (typ === null || typ.$type !== "Named") {
    return false;
  }
  const obj = (typ as types.Named).obj();
  return obj !== null && obj.pkg() !== null && obj.pkg()!.path() === importPath && obj.name() === typeName;
}
