// Ports revive's internal/rule package (v1.17.0, MIT license): name checks
// shared by the naming rules.

// Only add entries that are highly unlikely to be non-initialisms.
const commonInitialisms = new Set([
  "ACL",
  "API",
  "ASCII",
  "CPU",
  "CSS",
  "DNS",
  "EOF",
  "GUID",
  "HTML",
  "HTTP",
  "HTTPS",
  "ID",
  "IDS",
  "IP",
  "JSON",
  "LHS",
  "QPS",
  "RAM",
  "RHS",
  "RPC",
  "SLA",
  "SMTP",
  "SQL",
  "SSH",
  "TCP",
  "TLS",
  "TTL",
  "UDP",
  "UI",
  "UID",
  "UUID",
  "URI",
  "URL",
  "UTF8",
  "VM",
  "XML",
  "XMPP",
  "XSRF",
  "XSS",
]);

const isLower = (r: string): boolean => /^\p{Ll}$/u.test(r);
const isUnicodeDigit = (r: string): boolean => /^\p{Nd}$/u.test(r);

// toUpper maps one rune, as unicode.ToUpper does, never lengthening it.
function toUpper(r: string): string {
  const u = r.toUpperCase();
  return [...u].length === 1 ? u : r;
}

/**
 * The name a struct, var, const, or function should have, or id itself if
 * it is fine. allowlist initialisms are not enforced; blocklist ones are.
 */
export function suggestedName(id: string, allowlist: readonly string[], blocklist: readonly string[], skipInitialismNameChecks: boolean): string {
  if (id === "_") {
    return id;
  }
  const runes = [...id];
  if (runes.every(isLower)) {
    return id;
  }
  const ignoreInitWarnings = new Set(allowlist);
  const extraInits = new Set(blocklist);
  // Split camelCase at any lower->upper transition, and split on underscores.
  let w = 0;
  let i = 0;
  while (i + 1 <= runes.length) {
    let eow = false;
    if (i + 1 === runes.length) {
      eow = true;
    } else if (runes[i + 1] === "_") {
      // Drop the run of underscores, leaving one between two digits.
      eow = true;
      let n = 1;
      while (i + n + 1 < runes.length && runes[i + n + 1] === "_") {
        n++;
      }
      if (i + n + 1 < runes.length && isUnicodeDigit(runes[i]) && isUnicodeDigit(runes[i + n + 1])) {
        n--;
      }
      runes.splice(i + 1, n);
    } else if (isLower(runes[i]) && !isLower(runes[i + 1])) {
      eow = true;
    }
    i++;
    if (!eow) {
      continue;
    }
    const word = runes.slice(w, i).join("");
    let u = word.toUpperCase();
    if (!skipInitialismNameChecks && (commonInitialisms.has(u) || extraInits.has(u)) && !ignoreInitWarnings.has(u)) {
      // Keep consistent case, which is lowercase only at the start.
      if (w === 0 && isLower(runes[w])) {
        u = u.toLowerCase();
      }
      if (u === "IDS") {
        u = "IDs";
      }
      // Copies as Go's copy does: no further than the shorter of the two.
      const ur = [...u];
      for (let k = 0; k < ur.length && w + k < runes.length; k++) {
        runes[w + k] = ur[k];
      }
    } else if (w > 0 && word.toLowerCase() === word) {
      runes[w] = toUpper(runes[w]);
    }
    w = i;
  }
  return runes.join("");
}

const isUpper = (r: string): boolean => r >= "A" && r <= "Z" && r.length === 1;
const isDigit = (r: string): boolean => r >= "0" && r <= "9" && r.length === 1;
const isUpperOrDigit = (r: string): boolean => isUpper(r) || isDigit(r);

/** Reports whether s is a constant name such as SOME_CONST, X123_3, or _PRIVATE. */
export function isUpperCaseConst(s: string): boolean {
  if (s === "") {
    return false;
  }
  const r = [...s];
  if (r.length === 1) {
    return isUpper(r[0]);
  }
  if (r[0] !== "_" && !isUpper(r[0])) {
    return false;
  }
  return r.every((c, i) => isUpperOrDigit(c) || (c === "_" && i + 1 < r.length && isUpperOrDigit(r[i + 1])));
}

/** Reports whether s contains an ASCII upper case letter. */
export function hasUpperCaseLetter(s: string): boolean {
  return /[A-Z]/.test(s);
}

/** Reports whether s, longer than five characters, has only A-Z, 0-9, and an underscore. */
export function isUpperUnderscore(s: string): boolean {
  if (!s.includes("_") || s.length <= 5) {
    return false;
  }
  return /^[A-Z0-9_]+$/.test(s);
}
