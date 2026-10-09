// globToRegExp compiles a gobwas/glob pattern. * and ? stop at the separators,
// ** does not, and [...] and {a,b} work as in shells.
export function globToRegExp(glob: string, separators = ""): RegExp {
  const any = separators === "" ? "." : `[^${escapeRegExp(separators)}]`;
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (char === "*") {
      source += `${any}*`;
    } else if (char === "?") {
      source += any;
    } else if (char === "[") {
      const end = glob.indexOf("]", i);
      const body = glob.slice(i + 1, end);
      source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      i = end;
    } else if (char === "{") {
      source += "(?:";
    } else if (char === "}") {
      source += ")";
    } else if (char === ",") {
      source += source.lastIndexOf("(?:") > source.lastIndexOf(")") ? "|" : ",";
    } else if (char === "\\") {
      source += escapeRegExp(glob[++i] ?? "");
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
