// Port of golang.org/x/tools/internal/typeparams (normalize.go, termlist.go,
// typeterm.go and coretype.go) at v0.50.0, as several vet analyzers need it.
import * as types from "go/types";

// A term is a set of types: typ null is every type, and tilde includes every
// type whose underlying type is typ.
interface Term {
  tilde: boolean;
  typ: types.Type | null;
}

// A termlist is a union of terms; null stands for the empty set.
type Termlist = (Term | null)[];

const allTermlist = (): Termlist => [{ tilde: false, typ: null }];

const maxTermCount = 100;

function under(t: types.Type): types.Type {
  return t.underlying()!;
}

function disjoint(x: Term, y: Term): boolean {
  const ux = y.tilde ? under(x.typ!) : x.typ;
  const uy = x.tilde ? under(y.typ!) : y.typ;
  return !types.identical(ux, uy);
}

function termUnion(x: Term | null, y: Term | null): [Term | null, Term | null] {
  if (x === null) {
    return [y, null];
  }
  if (y === null) {
    return [x, null];
  }
  if (x.typ === null) {
    return [x, null];
  }
  if (y.typ === null) {
    return [y, null];
  }
  if (disjoint(x, y)) {
    return [x, y];
  }
  return x.tilde || !y.tilde ? [x, null] : [y, null];
}

function termIntersect(x: Term | null, y: Term | null): Term | null {
  if (x === null || y === null) {
    return null;
  }
  if (x.typ === null) {
    return y;
  }
  if (y.typ === null) {
    return x;
  }
  if (disjoint(x, y)) {
    return null;
  }
  return !x.tilde || y.tilde ? x : y;
}

function isEmpty(xl: Termlist): boolean {
  return xl.every((x) => x === null);
}

function isAll(xl: Termlist): boolean {
  return xl.some((x) => x !== null && x.typ === null);
}

function norm(xl: Termlist): Termlist {
  const used = new Array<boolean>(xl.length).fill(false);
  const rl: Termlist = [];
  for (let i = 0; i < xl.length; i++) {
    let xi = xl[i];
    if (xi === null || used[i]) {
      continue;
    }
    for (let j = i + 1; j < xl.length; j++) {
      const xj = xl[j];
      if (xj === null || used[j]) {
        continue;
      }
      const [u1, u2] = termUnion(xi, xj);
      if (u2 === null) {
        if (u1!.typ === null) {
          return allTermlist();
        }
        xi = u1;
        used[j] = true;
      }
    }
    rl.push(xi);
  }
  return rl;
}

function intersect(xl: Termlist, yl: Termlist): Termlist {
  if (isEmpty(xl) || isEmpty(yl)) {
    return [];
  }
  const rl: Termlist = [];
  for (const x of xl) {
    for (const y of yl) {
      const r = termIntersect(x, y);
      if (r !== null) {
        rl.push(r);
      }
    }
  }
  return norm(rl);
}

// A termSet is incomplete while it is being computed, to detect cycles.
interface TermSet {
  complete: boolean;
  terms: Termlist;
}

function computeTermSetInternal(t: types.Type, seen: Map<types.Type, TermSet>): TermSet {
  const prior = seen.get(t);
  if (prior !== undefined) {
    if (!prior.complete) {
      throw new Error(`cycle detected in the declaration of ${t.string()}`);
    }
    return prior;
  }
  const tset: TermSet = { complete: false, terms: [] };
  seen.set(t, tset);
  try {
    const u = t.underlying();
    if (u?.$type === "Interface") {
      tset.terms = allTermlist();
      for (const embedded of u.embeddedTypes()) {
        if (embedded!.underlying()?.$type === "TypeParam") {
          throw new Error("invalid embedded type");
        }
        tset.terms = intersect(tset.terms, computeTermSetInternal(embedded!, seen).terms);
      }
    } else if (u?.$type === "Union") {
      tset.terms = [];
      for (const term of u.terms()) {
        const typ = term!.type()!;
        const tu = typ.underlying();
        let terms: Termlist;
        if (tu?.$type === "Interface") {
          terms = computeTermSetInternal(typ, seen).terms;
        } else if (tu?.$type === "TypeParam" || tu?.$type === "Union") {
          throw new Error("invalid union term");
        } else if (typ === types.Typ[types.Invalid]) {
          continue;
        } else {
          terms = [{ tilde: term!.tilde(), typ }];
        }
        tset.terms = norm([...tset.terms, ...terms]);
        if (tset.terms.length > maxTermCount) {
          throw new Error(`exceeded max term count ${maxTermCount}`);
        }
      }
    } else if (u !== types.Typ[types.Invalid]) {
      tset.terms = [{ tilde: false, typ: t }];
    }
    return tset;
  } finally {
    tset.complete = true;
  }
}

// computeTermSet returns null where upstream returns an error, and [] for
// the set of all types.
function computeTermSet(typ: types.Type): types.Term[] | null {
  let tset: TermSet;
  try {
    tset = computeTermSetInternal(typ, new Map());
  } catch {
    return null;
  }
  if (isEmpty(tset.terms)) {
    return null;
  }
  if (isAll(tset.terms)) {
    return [];
  }
  return tset.terms.map((term) => types.newTerm(term!.tilde, term!.typ)!);
}

/**
 * Returns the normalized structural terms of a type parameter's constraint:
 * [] when unrestricted, and null when invalid or empty.
 */
export function structuralTerms(tparam: types.TypeParam): types.Term[] | null {
  const iface = tparam.constraint()?.underlying();
  return iface?.$type === "Interface" ? computeTermSet(iface) : null;
}

/**
 * Returns the normalized terms of the type set of t: [] when unrestricted,
 * and null when invalid or empty.
 */
export function normalTerms(t: types.Type): types.Term[] | null {
  let typ = types.unalias(t)!;
  if (typ.$type === "Named") {
    typ = typ.underlying()!;
  }
  switch (typ.$type) {
    case "TypeParam":
      return structuralTerms(typ);
    case "Union":
    case "Interface":
      return computeTermSet(typ);
    default:
      return [types.newTerm(false, t)!];
  }
}

/** Returns the core type of t, or null if it has none. */
export function coreType(t: types.Type): types.Type | null {
  let u = t.underlying()!;
  if (u.$type !== "Interface") {
    return u;
  }
  const terms = normalTerms(u);
  if (terms === null || terms.length === 0) {
    return null;
  }
  u = terms[0].type()!.underlying()!;
  let identical = 1;
  while (identical < terms.length && types.identical(u, terms[identical].type()!.underlying())) {
    identical++;
  }
  if (identical === terms.length) {
    return u;
  }
  if (u.$type !== "Chan") {
    return null;
  }
  let ch = u;
  for (let i = identical; i < terms.length; i++) {
    const curr = terms[i].type()!.underlying();
    if (curr?.$type !== "Chan" || !types.identical(ch.elem(), curr.elem())) {
      return null;
    }
    if (ch.dir() === types.SendRecv) {
      ch = curr;
    } else if (curr.dir() !== types.SendRecv && ch.dir() !== curr.dir()) {
      return null;
    }
  }
  return ch;
}

/** Returns the type pointed to by t if its core type is a pointer, and t otherwise. */
export function deref(t: types.Type): types.Type {
  const core = coreType(t);
  return core?.$type === "Pointer" ? core.elem()! : t;
}
