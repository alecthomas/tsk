import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import type * as ssa from "golang.org/x/tools/go/ssa";
import { defineAnalyzer, defineFact, type Pass, type RelatedInformation } from "tsk";
import { buildssa, inspect } from "tsk/passes";

// Guarded marks a field or package-level variable that may change after
// construction. lock names the mutex declared before it in the same struct or
// var block, and is empty when there is none.
interface Guarded {
  lock: string;
}

const guardedBy = defineFact<Guarded>("guardedBy");

export default defineAnalyzer({
  name: "lockguard",
  doc: `check that values changed after construction are accessed under a lock

In a struct with a sync.Mutex or sync.RWMutex field, each mutex guards the
fields after it, up to the next mutex. The same holds for package-level
variables in a var block. A field written only during construction needs no
lock. A field written after construction must be read with its mutex held, and
written, including its map or slice elements, with it held exclusively. A
field declared before the first mutex must not be written after construction.
Exported fields count as written after construction, because other packages
may write them. Values of sync/atomic types, sync.WaitGroup, sync.Once,
sync.Map, sync.Cond, and sync.Pool need no lock.

A value is under construction in the function that allocates it, in the
callers of functions that return it newly allocated, and in functions whose
every caller passes it newly allocated. Package-level variables are under
construction in init functions. Writes in test files do not count.

Functions need no annotations. A function that accesses a guarded value
without taking its lock passes the requirement on to its callers. It is
checked where it can go no further: in exported functions, functions used as
values or run as goroutines, and functions without callers. A failed check is
reported at the access, with the calls that led to it. Accesses that miss the
same lock through the same function are reported together.`,
  requires: [inspect, buildssa],
  facts: [guardedBy],
  run(pass) {
    // candidates maps each field or variable after a mutex, or in a struct
    // with one, to the name of the mutex before it, or "" if there is none.
    const candidates = new Map<types.Object, string>();
    const root = pass.resultOf(inspect).root();
    for (const cursor of root.preorder(ast.StructType)) {
      declareFields(pass, cursor.node() as ast.StructType, candidates);
    }
    for (const file of pass.files) {
      for (const decl of file!.decls) {
        if (decl?.$type === "GenDecl" && decl.tok === token.VAR) {
          declareVars(pass, decl, candidates);
        }
      }
    }
    if (candidates.size === 0 && pass.allObjectFacts().length === 0) {
      return;
    }
    new Checker(pass, pass.resultOf(buildssa).srcFuncs, candidates).check();
  },
});

function declareFields(pass: Pass<unknown>, struct: ast.StructType, candidates: Map<types.Object, string>): void {
  const fields = struct.fields!.list.map((field) => objects(pass, field!.names.length > 0 ? field!.names : [embeddedName(field!.type)]));
  if (fields.some((objects) => lockKind(objects[0]?.type() ?? null) !== null)) {
    declareGroups(fields, candidates, true);
  }
}

function declareVars(pass: Pass<unknown>, decl: ast.GenDecl, candidates: Map<types.Object, string>): void {
  declareGroups(
    decl.specs.map((spec) => objects(pass, (spec as ast.ValueSpec).names)),
    candidates,
    false,
  );
}

function objects(pass: Pass<unknown>, names: (ast.Ident | null)[]): types.Object[] {
  return names.flatMap((name) => {
    const object = name === null ? null : pass.typesInfo.defs.get(name);
    return object ? [object] : [];
  });
}

// embeddedName returns the type name that names an embedded field.
function embeddedName(expr: ast.Expr | null): ast.Ident | null {
  switch (expr?.$type) {
    case "Ident":
      return expr;
    case "StarExpr":
      return embeddedName(expr.x);
    case "SelectorExpr":
      return expr.sel;
    case "IndexExpr":
    case "IndexListExpr":
      return embeddedName(expr.x);
    default:
      return null;
  }
}

// declareGroups records each entry with the mutex declared before it. A var
// block is not one object, so its variables before the first mutex are left out.
function declareGroups(entries: types.Object[][], candidates: Map<types.Object, string>, struct: boolean): void {
  let lock = "";
  for (const objects of entries) {
    const type = objects[0]?.type() ?? null;
    if (lockKind(type) !== null) {
      lock = objects[objects.length - 1].name();
    } else if (!isConcurrent(type) && (struct || lock !== "")) {
      for (const object of objects) {
        candidates.set(object, lock);
      }
    }
  }
}

interface LockKind {
  rw: boolean;
  pointer: boolean;
}

function lockKind(t: types.Type | null): LockKind | null {
  t = types.unalias(t);
  const pointer = t?.$type === "Pointer";
  if (t?.$type === "Pointer") {
    t = types.unalias(t.elem());
  }
  const object = t?.$type === "Named" ? t.obj() : null;
  if (object?.pkg()?.path() !== "sync" || (object.name() !== "Mutex" && object.name() !== "RWMutex")) {
    return null;
  }
  return { rw: object.name() === "RWMutex", pointer };
}

const concurrentSyncTypes = new Set(["WaitGroup", "Once", "Map", "Cond", "Pool"]);

// isConcurrent reports whether a type is safe to use without a lock.
function isConcurrent(t: types.Type | null): boolean {
  t = types.unalias(t);
  const object = t?.$type === "Named" ? t.obj() : null;
  const path = object?.pkg()?.path();
  return path === "sync/atomic" || (path === "sync" && concurrentSyncTypes.has(object!.name()));
}

// Mode is how a lock is held, or must be: "r" for reading, "w" exclusively.
type Mode = "r" | "w";

// State maps the path of each held lock to how it is held.
type State = Map<string, Mode>;

const lockOps = new Map<string, { acquire: Mode | null }>([
  ["(*sync.Mutex).Lock", { acquire: "w" }],
  ["(*sync.Mutex).Unlock", { acquire: null }],
  ["(*sync.RWMutex).Lock", { acquire: "w" }],
  ["(*sync.RWMutex).Unlock", { acquire: null }],
  ["(*sync.RWMutex).RLock", { acquire: "r" }],
  ["(*sync.RWMutex).RUnlock", { acquire: null }],
]);

// Requirement is what a function needs of its callers, found at pos. A "lock"
// requirement needs the lock at path held. A "write" requirement needs the
// value at path to be under construction. access is where the value is
// accessed, and chain names the callees between pos and the access.
interface Requirement {
  kind: "lock" | "write";
  path: string;
  mode: Mode;
  rw: boolean;
  object: types.Object;
  target: string;
  lockName: string;
  pos: token.Pos;
  access: token.Pos;
  chain: string[];
}

// Summary describes a function to its callers. Paths are rooted at its
// parameters, free variables, or globals, so callers can substitute their own.
interface Summary {
  acquires: State;
  releases: Set<string>;
  // fresh reports, for each result, whether it is always newly allocated.
  fresh: boolean[];
  // requirements are keyed by site, so each site is reported once.
  requirements: Map<string, Requirement>;
}

function emptySummary(): Summary {
  return { acquires: new Map(), releases: new Set(), fresh: [], requirements: new Map() };
}

// Paths are strings of steps separated by "/". The root is a parameter "p<i>",
// free variable "f<i>", global "g:<pkg>.<name>", allocation "a:<name>", or
// other local value "v:<name>". Steps select a field "f<i>" or dereference "*".
function propagates(path: string): boolean {
  return /^(p\d|f\d|g:)/.test(path);
}

// isFresh reports whether a path is a newly allocated value or within one,
// rather than reached through a pointer.
function isFresh(path: string): boolean {
  const steps = path.split("/");
  return steps[0].startsWith("a:") && !steps.includes("*");
}

function isAllocation(path: string): boolean {
  return path.startsWith("a:") && !path.includes("/");
}

function substitute(path: string, args: (string | null)[], frees: (string | null)[]): string | null {
  const slash = path.indexOf("/");
  const root = slash < 0 ? path : path.slice(0, slash);
  const rest = slash < 0 ? "" : path.slice(slash);
  let replacement: string | null | undefined;
  if (root.startsWith("g:")) {
    replacement = root;
  } else if (root.startsWith("p")) {
    replacement = args[Number(root.slice(1))];
  } else if (root.startsWith("f")) {
    replacement = frees[Number(root.slice(1))];
  }
  return replacement == null ? null : replacement + rest;
}

function satisfies(state: State, lock: string, mode: Mode): boolean {
  const held = state.get(lock);
  return held === "w" || (held === "r" && mode === "r");
}

function meet(states: State[]): State {
  const result: State = new Map();
  const [first, ...rest] = states;
  for (const [lock, mode] of first ?? []) {
    if (rest.every((state) => state.has(lock))) {
      result.set(lock, mode === "r" || rest.some((state) => state.get(lock) === "r") ? "r" : "w");
    }
  }
  return result;
}

function sameState(a: State | undefined, b: State): boolean {
  return a !== undefined && a.size === b.size && [...b].every(([lock, mode]) => a.get(lock) === mode);
}

function sameSummary(a: Summary | undefined, b: Summary): boolean {
  return (
    a !== undefined &&
    sameState(a.acquires, b.acquires) &&
    a.releases.size === b.releases.size &&
    [...b.releases].every((lock) => a.releases.has(lock)) &&
    a.fresh.length === b.fresh.length &&
    b.fresh.every((fresh, i) => a.fresh[i] === fresh) &&
    a.requirements.size === b.requirements.size &&
    [...b.requirements.keys()].every((key) => a.requirements.has(key))
  );
}

function message(requirement: Requirement, goroutine: boolean): string {
  if (requirement.kind === "write") {
    return `"${requirement.target}" written after construction, but no mutex is declared before it`;
  }
  const verb = requirement.mode === "w" ? "written" : "read";
  return `"${requirement.target}" ${verb} ${withoutLock(requirement, goroutine)}`;
}

function withoutLock(requirement: Requirement, goroutine: boolean): string {
  const locking = requirement.mode === "w" && requirement.rw ? "write-locking" : "locking";
  const where = goroutine ? " in a new goroutine" : "";
  return `without ${locking} "${requirement.lockName}"${where}`;
}

function via(chain: string[]): string {
  return chain.length > 0 ? ` (via ${chain.join(" -> ")})` : "";
}

// LockGroup collects the accesses that miss one lock from one entry, keyed by
// access, and the calls that reach them, keyed by position.
interface LockGroup {
  goroutine: boolean;
  accesses: Map<string, Requirement>;
  calls: Map<token.Pos, Requirement>;
}

// Access is a field or variable an instruction reaches. base is the path of
// the value holding it, which is under construction when fresh.
interface Access {
  object: types.Object;
  base: string;
  target: string;
  lockName(name: string): string;
  // lock returns the path of the mutex named name, if it is one.
  lock(name: string): { path: string; rw: boolean } | null;
}

// Checker infers a summary for every function, iterating until the summaries
// stop changing so that requirements reach callers through any call cycle. It
// runs twice: first to find what is written after construction, then to check
// locks for those values only.
class Checker {
  phase: "write" | "lock" = "write";
  private readonly funcs: ssa.Function[];
  private readonly summaries = new Map<ssa.Function, Summary>();
  private readonly roots = new Set<ssa.Function>();
  // writes holds the writes after construction to each value whose writes
  // are tracked, in the order found.
  private readonly writes = new Map<types.Object, Requirement[]>();
  // reports holds the write findings by access and message, so an access
  // reached from several calls is reported once, listing each call.
  private readonly reports = new Map<string, { pos: token.Pos; message: string; related: RelatedInformation[] }>();
  // groups holds the lock findings by lock and entry: the function called
  // without the lock, or the one accessing directly. One missing lock is then
  // one finding, however many accesses and calls it affects.
  private readonly groups = new Map<string, LockGroup>();

  constructor(
    private readonly pass: Pass<unknown>,
    srcFuncs: (ssa.Function | null)[],
    private readonly candidates: Map<types.Object, string>,
  ) {
    this.funcs = srcFuncs.filter((fn): fn is ssa.Function => fn !== null && fn.blocks.length > 0);
    this.findRoots();
  }

  check(): void {
    this.solve();
    this.declare();
    this.phase = "lock";
    this.summaries.clear();
    this.solve();
    for (const report of this.reports.values()) {
      this.pass.report(report);
    }
    for (const group of this.groups.values()) {
      this.reportGroup(group);
    }
  }

  private solve(): void {
    for (let changed = true, round = 0; changed && round < 50; round++) {
      changed = false;
      for (const fn of this.funcs) {
        const summary = new FunctionChecker(this, fn, false).run();
        if (!sameSummary(this.summaries.get(fn), summary)) {
          this.summaries.set(fn, summary);
          changed = true;
        }
      }
    }
    for (const fn of this.funcs) {
      const summary = new FunctionChecker(this, fn, true).run();
      if (!this.roots.has(fn)) {
        continue;
      }
      for (const requirement of summary.requirements.values()) {
        // Package-level variables are under construction in init functions.
        if (!(requirement.kind === "write" && requirement.path.startsWith("g:") && isInit(fn))) {
          this.finding(requirement, false, fn);
        }
      }
    }
  }

  // declare exports a fact for each candidate that may change after
  // construction, and reports writes to those with no mutex before them.
  private declare(): void {
    for (const [object, lock] of this.candidates) {
      if (object.exported() || this.writes.has(object)) {
        this.pass.exportObjectFact(object, guardedBy, { lock });
      }
    }
    for (const [object, writes] of this.writes) {
      if (this.guard(object)?.lock === "") {
        for (const write of writes) {
          this.report(write, message(write, false), []);
        }
      }
    }
  }

  // finding records a requirement that cannot propagate: a write after
  // construction, or a lock not held, found in fn.
  finding(requirement: Requirement, goroutine: boolean, fn: ssa.Function): void {
    if (requirement.kind === "write") {
      // Tests often set up values directly, so they do not make them mutable.
      if (!this.pass.fset.position(requirement.pos).filename.endsWith("_test.go")) {
        this.writes.set(requirement.object, [...(this.writes.get(requirement.object) ?? []), requirement]);
      }
      return;
    }
    const entry = requirement.chain.length > 0 ? `call:${requirement.chain[0]}` : `func:${fn.pos()}`;
    const key = `${requirement.lockName}|${goroutine}|${entry}`;
    let group = this.groups.get(key);
    if (group === undefined) {
      group = { goroutine, accesses: new Map(), calls: new Map() };
      this.groups.set(key, group);
    }
    const access = `${requirement.access}|${requirement.target}`;
    const existing = group.accesses.get(access);
    if (existing === undefined || (existing.mode === "r" && requirement.mode === "w")) {
      group.accesses.set(access, requirement);
    }
    if (requirement.pos !== requirement.access && !group.calls.has(requirement.pos)) {
      group.calls.set(requirement.pos, requirement);
    }
  }

  // report queues a write finding at the requirement's access, followed by
  // each call through which it was reached.
  private report(requirement: Requirement, message: string, related: RelatedInformation[]): void {
    const key = `${requirement.access}|${message}`;
    let report = this.reports.get(key);
    if (report === undefined) {
      report = { pos: requirement.access, message, related };
      this.reports.set(key, report);
    }
    if (requirement.pos !== requirement.access && !report.related.some((info) => info.pos === requirement.pos)) {
      report.related.push({ pos: requirement.pos, message: `"${requirement.target}" written after construction${via(requirement.chain)}` });
    }
  }

  // reportGroup reports a group at its first access in the entry, rather than
  // in a callee, with the other accesses and the calls as related lines.
  // Each related line names the lock, so it reads on its own.
  private reportGroup(group: LockGroup): void {
    const accesses = [...group.accesses.values()].sort((a, b) => a.chain.length - b.chain.length || a.access - b.access);
    const first = accesses[0];
    const single = accesses.length === 1;
    // The strictest access decides how callers must lock.
    const strictest = accesses.find((access) => access.mode === "w" && access.rw) ?? first;
    const calls = [...group.calls.values()].map((call) => {
      const [callee, ...rest] = call.chain;
      const name = callee === undefined ? "" : `"${callee}" `;
      return { pos: call.pos, message: `${name}called ${withoutLock(strictest, group.goroutine)}${single ? via(rest) : ""}` };
    });
    const write = this.writes.get(first.object)?.[0];
    const written =
      !single || write === undefined || write.access === first.access
        ? []
        : [{ pos: write.access, message: `"${write.target}" is written after construction here` }];
    this.pass.report({
      pos: first.access,
      message: message(first, group.goroutine),
      related: [
        ...written,
        ...accesses.slice(1).map((access) => ({ pos: access.access, message: message(access, group.goroutine) + via(access.chain.slice(1)) })),
        ...calls,
      ],
    });
  }

  // tracksWrites reports whether writes after construction to object matter:
  // they make a candidate mutable, or are reported for a value without a mutex.
  tracksWrites(object: types.Object): boolean {
    return this.candidates.has(object) || this.guard(object)?.lock === "";
  }

  guard(object: types.Object): Guarded | undefined {
    return this.pass.importObjectFact(object, guardedBy);
  }

  summary(fn: ssa.Function): Summary | undefined {
    return this.summaries.get(fn);
  }

  // requirements returns what callers of fn must satisfy. A root's
  // requirements are reported in the root, so they stop there.
  requirements(fn: ssa.Function): Requirement[] {
    return this.roots.has(fn) ? [] : [...(this.summaries.get(fn)?.requirements.values() ?? [])];
  }

  // findRoots finds the named functions whose requirements no caller in the
  // package can satisfy: exported ones, those used as values, and those
  // without static callers. Anonymous functions are checked where they are
  // created instead.
  private findRoots(): void {
    const called = new Set<ssa.Function>();
    const escaped = new Set<ssa.Function>();
    for (const fn of this.funcs) {
      for (const block of fn.blocks) {
        for (const instr of block!.instrs) {
          const callee = isCall(instr) && !instr.call.isInvoke() ? instr.call.value : null;
          if (callee?.$type === "Function") {
            called.add(origin(callee));
          }
          for (const operand of instr!.operands([])) {
            if (operand?.$type === "Function" && operand !== callee) {
              escaped.add(origin(operand));
            }
          }
        }
      }
    }
    for (const fn of this.funcs) {
      if (fn.parent() === null && (fn.object()?.exported() || escaped.has(fn) || !called.has(fn))) {
        this.roots.add(fn);
      }
    }
  }
}

function isInit(fn: ssa.Function): boolean {
  return fn.parent() === null && fn.object()?.name() === "init" && fn.signature?.recv() === null;
}

function isCall(instr: ssa.Instruction | null): instr is ssa.Call | ssa.Defer | ssa.Go {
  return instr?.$type === "Call" || instr?.$type === "Defer" || instr?.$type === "Go";
}

function origin(fn: ssa.Function): ssa.Function {
  return fn.origin() ?? fn;
}

// FunctionChecker tracks the locks held through one function. It computes
// the function's summary and, when reporting, the findings that cannot
// propagate.
class FunctionChecker {
  private readonly paths = new Map<ssa.Value, string>();
  private readonly summary = emptySummary();
  private readonly deferredReleases = new Set<string>();
  private readonly exits: State[] = [];
  private fresh: boolean[] | null = null;
  private readonly findings = new Map<string, { requirement: Requirement; goroutine: boolean }>();

  constructor(
    private readonly checker: Checker,
    private readonly fn: ssa.Function,
    private readonly reporting: boolean,
  ) {}

  run(): Summary {
    const entries = this.solve();
    for (const block of this.fn.blocks) {
      const entry = entries.get(block!);
      if (entry === undefined) {
        continue;
      }
      const state = new Map(entry);
      for (const instr of block!.instrs) {
        this.inspect(instr!, state);
        this.transfer(instr!, state, true);
      }
    }
    if (this.exits.length > 0) {
      for (const [lock, mode] of meet(this.exits)) {
        if (propagates(lock) && !this.deferredReleases.has(lock)) {
          this.summary.acquires.set(lock, mode);
        }
      }
    }
    this.summary.fresh = this.fresh ?? [];
    if (this.reporting) {
      for (const { requirement, goroutine } of this.findings.values()) {
        this.checker.finding(requirement, goroutine, this.fn);
      }
    }
    return this.summary;
  }

  // solve returns the locks held on entry to each reachable block: those held
  // at the end of every predecessor reached so far, iterated to a fixed point.
  private solve(): Map<ssa.BasicBlock, State> {
    const entries = new Map<ssa.BasicBlock, State>();
    const exits = new Map<ssa.BasicBlock, State>();
    const first = this.fn.blocks[0]!;
    entries.set(first, new Map());
    const work = [first];
    while (work.length > 0) {
      const block = work.shift()!;
      const state = new Map(entries.get(block)!);
      for (const instr of block.instrs) {
        this.transfer(instr!, state, false);
      }
      if (sameState(exits.get(block), state)) {
        continue;
      }
      exits.set(block, state);
      for (const succ of block.succs) {
        const preds = succ!.preds.flatMap((pred) => exits.get(pred!) ?? []);
        const entry = meet(preds);
        if (!sameState(entries.get(succ!), entry)) {
          entries.set(succ!, entry);
          work.push(succ!);
        }
      }
    }
    return entries;
  }

  // transfer applies an instruction's effect on the held locks. When
  // collecting, it also records the effects the summary reports to callers.
  private transfer(instr: ssa.Instruction, state: State, collecting: boolean): void {
    if (instr.$type === "Return") {
      if (collecting) {
        this.exits.push(new Map(state));
        const fresh = instr.results.map((result) => isAllocation(this.path(result)));
        this.fresh = this.fresh?.map((all, i) => all && fresh[i]) ?? fresh;
      }
      return;
    }
    if (!isCall(instr) || instr.$type === "Go") {
      return;
    }
    const deferred = instr.$type === "Defer";
    const release = (lock: string | null) => {
      if (lock === null) {
        return;
      }
      if (deferred) {
        this.deferredReleases.add(lock);
      }
      if (!state.has(lock) && collecting && propagates(lock)) {
        this.summary.releases.add(lock);
      }
      if (!deferred) {
        state.delete(lock);
      }
    };
    const op = lockOp(instr.call);
    if (op !== null) {
      const lock = this.path(instr.call.args[0]);
      if (op.acquire === null) {
        release(lock);
      } else if (!deferred && state.get(lock) !== "w") {
        state.set(lock, op.acquire);
      }
      return;
    }
    const callee = staticCallee(instr.call);
    const summary = callee === null ? undefined : this.checker.summary(callee);
    if (summary === undefined) {
      return;
    }
    const site = this.site(instr.call);
    for (const lock of summary.releases) {
      release(substitute(lock, site.args, site.frees));
    }
    if (!deferred) {
      for (const [lock, mode] of summary.acquires) {
        const path = substitute(lock, site.args, site.frees);
        if (path !== null) {
          state.set(path, mode);
        }
      }
    }
  }

  // inspect checks an instruction's accesses and the requirements of the
  // functions it calls or creates against the locks held before it.
  private inspect(instr: ssa.Instruction, state: State): void {
    if (instr.$type === "FieldAddr" || instr.$type === "Field") {
      const access = this.fieldAccess(instr);
      if (access !== null) {
        this.checkAccess(access, instr.$type === "Field" ? "r" : accessMode(instr), positionOf(instr), state);
      }
    }
    for (const operand of instr.operands([])) {
      const object = operand?.$type === "Global" ? operand.object() : null;
      if (object !== null) {
        this.checkAccess(globalAccess(object), useMode(operand!, instr), positionOf(instr), state);
      }
    }
    this.inspectCalls(instr, state);
  }

  private checkAccess(access: Access, mode: Mode | null, pos: token.Pos, state: State): void {
    if (mode === null) {
      return;
    }
    const requirement = { object: access.object, target: access.target, pos, access: pos, chain: [] };
    if (this.checker.phase === "write") {
      if (mode === "w" && this.checker.tracksWrites(access.object)) {
        this.require({ ...requirement, kind: "write", path: access.base, mode, rw: false, lockName: "" }, state, false);
      }
      return;
    }
    const name = this.checker.guard(access.object)?.lock ?? "";
    const lock = name === "" ? null : access.lock(name);
    if (lock !== null) {
      this.require({ ...requirement, kind: "lock", path: lock.path, mode, rw: lock.rw, lockName: access.lockName(name) }, state, false);
    }
  }

  private inspectCalls(instr: ssa.Instruction, state: State): void {
    if (instr.$type === "MakeClosure") {
      // A closure run as a goroutine is checked at its go statement. Any other
      // is assumed to run while the locks held at its creation are.
      const goroutine = instr.referrers()?.some((ref) => ref?.$type === "Go" && ref.call.value === instr);
      if (!goroutine) {
        const fn = instr.fn as ssa.Function;
        this.requireCallee(fn, { args: [], frees: instr.bindings.map((binding) => this.path(binding)) }, null, state, false);
      }
      return;
    }
    if (isCall(instr)) {
      const callee = staticCallee(instr.call);
      const goroutine = instr.$type === "Go";
      // Closures are checked where they are created, unless run as goroutines.
      if (callee !== null && (goroutine || instr.call.value?.$type !== "MakeClosure")) {
        this.requireCallee(callee, this.site(instr.call), instr.pos(), goroutine ? new Map() : state, goroutine);
      }
    }
    // Anonymous functions without free variables are plain values.
    for (const operand of instr.operands([])) {
      if (operand?.$type === "Function" && operand.parent() !== null && !(isCall(instr) && instr.call.value === operand)) {
        this.requireCallee(operand, { args: [], frees: [] }, null, state, false);
      }
    }
  }

  // requireCallee applies a callee's requirements at pos. A null pos keeps each
  // requirement's own position, for closures whose creation has no position.
  private requireCallee(callee: ssa.Function, site: Site, at: token.Pos | null, state: State, goroutine: boolean): void {
    const name = callee.parent() === null ? [callee.name()] : [];
    for (const requirement of this.checker.requirements(callee)) {
      const path = substitute(requirement.path, site.args, site.frees);
      const chain = [...name, ...requirement.chain];
      const pos = at ?? requirement.pos;
      if (path === null) {
        // The callee's value cannot be named here, so the requirement cannot be met.
        this.finding({ ...requirement, chain, pos }, goroutine);
        continue;
      }
      this.require({ ...requirement, path, chain, pos }, state, goroutine);
    }
  }

  private require(requirement: Requirement, state: State, goroutine: boolean): void {
    // Values under construction are not yet shared, so they need no lock.
    if (isFresh(requirement.path) || (requirement.kind === "lock" && satisfies(state, requirement.path, requirement.mode))) {
      return;
    }
    if (goroutine || !propagates(requirement.path)) {
      this.finding(requirement, goroutine);
      return;
    }
    const key = siteKey(requirement);
    const existing = this.summary.requirements.get(key);
    if (existing === undefined || (existing.mode === "r" && requirement.mode === "w")) {
      this.summary.requirements.set(key, requirement);
    }
  }

  // finding queues a requirement that cannot propagate. One statement may
  // access a value through several addresses, so findings merge by site.
  private finding(requirement: Requirement, goroutine: boolean): void {
    const key = siteKey(requirement);
    const existing = this.findings.get(key);
    if (existing === undefined || (existing.requirement.mode === "r" && requirement.mode === "w")) {
      this.findings.set(key, { requirement, goroutine });
    }
  }

  private site(call: ssa.CallCommon): Site {
    const closure = call.value?.$type === "MakeClosure" ? call.value : null;
    return {
      args: call.args.map((arg) => this.path(arg)),
      frees: closure?.bindings.map((binding) => this.path(binding)) ?? [],
    };
  }

  private fieldAccess(instr: ssa.FieldAddr | ssa.Field): Access | null {
    let base = this.path(instr.x);
    let owner = types.unalias(instr.x!.type());
    if (instr.$type === "FieldAddr") {
      owner = owner?.$type === "Pointer" ? types.unalias(owner.elem()) : null;
    } else if (base.endsWith("/*")) {
      // A field of a loaded struct is the field at the struct's address.
      base = base.slice(0, -2);
    } else {
      // A field of a struct value is a copy that no other goroutine can see.
      return null;
    }
    const struct = owner?.underlying();
    if (struct?.$type !== "Struct") {
      return null;
    }
    const field = struct.field(instr.field)!;
    const typeName = owner?.$type === "Named" ? `${owner.obj()!.name()}.` : "";
    return {
      object: field.origin() ?? field,
      base,
      target: typeName + field.name(),
      lockName: (name) => typeName + name,
      lock: (name) => {
        for (let i = 0; i < struct.numFields(); i++) {
          const kind = struct.field(i)!.name() === name ? lockKind(struct.field(i)!.type()) : null;
          if (kind !== null) {
            return { path: `${base}/f${i}${kind.pointer ? "/*" : ""}`, rw: kind.rw };
          }
        }
        return null;
      },
    };
  }

  private path(value: ssa.Value | null): string {
    if (value === null) {
      return "v:?";
    }
    let path = this.paths.get(value);
    if (path === undefined) {
      // A phi in a loop may reach itself, so it is a local value until resolved.
      this.paths.set(value, `v:${value.name()}`);
      path = this.resolve(value);
      this.paths.set(value, path);
    }
    return path;
  }

  private resolve(value: ssa.Value): string {
    switch (value.$type) {
      case "Parameter":
        return `p${this.fn.params.indexOf(value)}`;
      case "FreeVar":
        return `f${this.fn.freeVars.indexOf(value)}`;
      case "Global":
        return globalPath(value.object()!);
      case "Alloc":
        return `a:${value.name()}`;
      case "FieldAddr":
        return `${this.path(value.x)}/f${value.field}`;
      case "UnOp":
        return value.op === token.MUL ? `${this.path(value.x)}/*` : `v:${value.name()}`;
      case "Phi":
        if (value.edges.every((edge) => isAllocation(this.path(edge)))) {
          return `a:${value.name()}`;
        }
        return new Set(value.edges.map((edge) => this.path(edge))).size === 1 ? this.path(value.edges[0]) : `v:${value.name()}`;
      case "Call":
        return this.returnsFresh(value.call, 0) ? `a:${value.name()}` : `v:${value.name()}`;
      case "Extract":
        return value.tuple?.$type === "Call" && this.returnsFresh(value.tuple.call, value.index) ? `a:${value.name()}` : `v:${value.name()}`;
      default:
        return `v:${value.name()}`;
    }
  }

  private returnsFresh(call: ssa.CallCommon, index: number): boolean {
    const callee = staticCallee(call);
    return callee !== null && (this.checker.summary(callee)?.fresh[index] ?? false);
  }
}

// siteKey identifies a requirement by site and access, as each access is
// reported. Write requirements are also kept per value, as each one matters.
function siteKey(requirement: Requirement): string {
  const value = requirement.kind === "write" ? `|${requirement.target}` : "";
  return `${requirement.kind}|${requirement.path}|${requirement.pos}|${requirement.access}${value}`;
}

// Site maps a callee's parameters and free variables to the caller's paths.
interface Site {
  args: (string | null)[];
  frees: (string | null)[];
}

function globalAccess(object: types.Object): Access {
  return {
    object,
    base: globalPath(object),
    target: object.name(),
    lockName: (name) => name,
    lock: (name) => {
      const lock = object.pkg()?.scope()?.lookup(name) ?? null;
      const kind = lock === null ? null : lockKind(lock.type());
      return kind === null ? null : { path: `${globalPath(lock!)}${kind.pointer ? "/*" : ""}`, rw: kind.rw };
    },
  };
}

function globalPath(object: types.Object): string {
  return `g:${object.pkg()?.path()}.${object.name()}`;
}

function staticCallee(call: ssa.CallCommon): ssa.Function | null {
  const callee = call.isInvoke() ? null : call.staticCallee();
  return callee === null ? null : origin(callee);
}

function lockOp(call: ssa.CallCommon): { acquire: Mode | null } | null {
  const object = call.isInvoke() ? null : (call.staticCallee()?.object() ?? null);
  return object?.$type === "Func" ? (lockOps.get(object.fullName()) ?? null) : null;
}

// accessMode returns how an address is used: written, read, or neither.
function accessMode(addr: ssa.Value): Mode | null {
  let mode: Mode | null = null;
  for (const ref of addr.referrers() ?? []) {
    const use = ref === null ? null : useMode(addr, ref);
    if (use === "w") {
      return "w";
    }
    mode = use ?? mode;
  }
  return mode;
}

// useMode returns how an instruction uses an address. Uses other than loads
// and nested selections may write through it, so they count as writes.
function useMode(addr: ssa.Value, instr: ssa.Instruction): Mode | null {
  switch (instr.$type) {
    case "DebugRef":
      return null;
    case "UnOp":
      return instr.op === token.MUL ? contentsMode(instr) : "w";
    case "FieldAddr":
    case "IndexAddr":
      return instr.x === addr ? accessMode(instr) : "w";
    default:
      return "w";
  }
}

// contentsMode returns "w" if a loaded map or slice has its elements changed.
function contentsMode(value: ssa.Value): Mode {
  for (const ref of value.referrers() ?? []) {
    switch (ref?.$type) {
      case "MapUpdate":
        if (ref.map === value) {
          return "w";
        }
        break;
      case "IndexAddr":
        if (accessMode(ref) === "w") {
          return "w";
        }
        break;
      case "Call": {
        const builtin = ref.call.value?.$type === "Builtin" ? ref.call.value.name() : "";
        if ((builtin === "delete" || builtin === "clear" || builtin === "copy") && ref.call.args[0] === value) {
          return "w";
        }
        break;
      }
    }
  }
  return "r";
}

// positionOf returns an instruction's position, or that of the nearest
// instruction in its block with one, as implicit operations have none.
function positionOf(instr: ssa.Instruction): token.Pos {
  if (instr.pos() !== token.NoPos) {
    return instr.pos();
  }
  for (const ref of instr.referrers() ?? []) {
    if (ref !== null && ref.pos() !== token.NoPos) {
      return ref.pos();
    }
  }
  const instrs = instr.block()!.instrs;
  const index = instrs.indexOf(instr);
  const near = [...instrs.slice(index + 1), ...instrs.slice(0, index).reverse()];
  return near.find((other) => other !== null && other.pos() !== token.NoPos)?.pos() ?? token.NoPos;
}
