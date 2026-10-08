// Go string literal helpers, after the strconv package.

const simpleEscapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"' };

const quoteEscapes: Record<string, string> = { "\x07": "\\a", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\v": "\\v", '"': '\\"', "\\": "\\\\" };

// unquote decodes a Go string literal as written in source, or returns null
// if it is not one. Byte escapes such as \xff decode to the code point.
export function unquote(literal: string): string | null {
  if (literal.length < 2 || literal[0] !== literal[literal.length - 1]) {
    return null;
  }
  if (literal[0] === "`") {
    // Carriage returns are discarded from raw strings.
    return literal.slice(1, -1).split("\r").join("");
  }
  if (literal[0] !== '"') {
    return null;
  }
  return literal
    .slice(1, -1)
    .replace(/\\(?:([abfnrtv\\'"])|x([0-9a-fA-F]{2})|([0-7]{3})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/g, (_, c, x, o, u, U) => {
      if (c !== undefined) {
        return simpleEscapes[c];
      }
      return String.fromCodePoint(Number.parseInt(x ?? o ?? u ?? U, o !== undefined ? 8 : 16));
    });
}

// quote quotes a string like Go's strconv.Quote, escaping ASCII control
// characters. Unlike Go, it keeps non-printable Unicode as is.
export function quote(s: string): string {
  const quoted = Array.from(s, (c) => {
    const code = c.charCodeAt(0);
    if (quoteEscapes[c] !== undefined) {
      return quoteEscapes[c];
    }
    return code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : c;
  });
  return `"${quoted.join("")}"`;
}
