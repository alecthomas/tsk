import * as ast from "go/ast";
import * as build from "go/build";
import * as token from "go/token";
import * as types from "go/types";
import * as modfile from "golang.org/x/mod/modfile";
import * as os from "os";
import * as filepath from "path/filepath";
import { defineAnalyzer, defineFact, type Pass } from "tsk";

// Rule exempts a writer when it accesses or constructs a target. Names are
// module-relative, such as "Config" or "lexer.Config", full package paths,
// such as "example.com/project/lexer.Config", or "all".
interface Rule {
  /** A method receiver type or package-level function. */
  writer: string;
  /**
   * A concrete type or an interface. An interface matches types implemented
   * by its value or pointer type.
   */
  target: string;
}

// Config controls exemptions for private-field access and construction.
interface Config {
  /** Writers allowed to read the private fields of targets. */
  allowReads: Rule[];
  /**
   * Writers allowed to write the private fields of targets. Assignments,
   * increments, address-taking, and mutating builtins count as writes.
   */
  allowWrites: Rule[];
  /**
   * Factory types whose methods may return newly constructed values of
   * targets. A factory method must be declared in the constructed type's
   * package and return the new value directly or through an unreassigned
   * local.
   */
  allowFactory: Rule[];
  /**
   * Allow construction of structs declared in generated files, such as
   * Protocol Buffers messages, from any package.
   */
  allowGeneratedConstruction: boolean;
}

// Encapsulated carries construction policy to importing packages. Go's type
// checker already prevents those packages from naming private fields.
interface Encapsulated {
  directConstructor: boolean;
  // generated records the declaring file rather than the construction policy,
  // so each analyzing package applies its own configuration.
  generated: boolean;
  // module is empty when the declaring package's module is unknown.
  module: string;
}

const encapsulated = defineFact<Encapsulated>("encapsulated");

export default defineAnalyzer<Config>({
  name: "encapsulation",
  doc: `report private-field access and construction outside a struct's API

A struct is encapsulated when it is declared in the module being linted, has
private fields, and is exported or has methods. Its private fields may only be
accessed by its own methods, its constructors, functional options its
constructors return directly, and, when it has no constructor of its own, the
methods of a struct that directly embeds it. A constructor is a package-level
function in the struct's package that returns the struct, or an interface it
implements.

An encapsulated struct may only be constructed in its constructors, in a method
of an allowed factory type that returns the new value, or, when it has no
constructor of its own, as a field of a parent struct built in the parent's
constructor.

Structs from the standard library and other modules are not checked, and
neither are test files or generated files. The allow-reads, allow-writes, and
allow-factory options exempt specific writers, and allow-generated-construction
permits constructing structs declared in generated files anywhere.`,
  facts: [encapsulated],
  config: { allowReads: [], allowWrites: [], allowFactory: [], allowGeneratedConstruction: false },
  run(pass) {
    validateRules("allow-reads", pass.config.allowReads);
    validateRules("allow-writes", pass.config.allowWrites);
    validateRules("allow-factory", pass.config.allowFactory);
    const c = new Checker(pass);
    if (c.isStandardPackage(pass.pkg)) {
      return;
    }
    const files = c.checkedFiles();
    c.collectFactoryConstructions(files);
    c.collectTypes();
    for (const file of files) {
      c.checkFile(file);
    }
  },
});

function validateRules(key: string, rules: readonly Readonly<Rule>[]): void {
  for (const rule of rules) {
    if (!validAccessName(rule.writer) || !validAccessName(rule.target)) {
      throw new Error(`${key}: invalid writer:target pair "${rule.writer}:${rule.target}"`);
    }
  }
}

function validAccessName(name: string): boolean {
  if (name === "all") {
    return true;
  }
  const dot = name.lastIndexOf(".");
  return token.isIdentifier(dot >= 0 ? name.slice(dot + 1) : name);
}

interface Context {
  method: types.TypeName | null;
  fn: types.Func | null;
  target: types.Var | null;
  option: types.TypeName | null;
}

function emptyContext(): Context {
  return { method: null, fn: null, target: null, option: null };
}

// contextWriter is a method's receiver type, not its individual method name.
function contextWriter(ctx: Context): types.Object | null {
  return ctx.method ?? ctx.fn;
}

class Checker {
  private readonly info: types.Info;
  private readonly module: string;
  private readonly modulePath: string;
  private readonly facts = new Map<types.TypeName, Encapsulated>();
  private readonly allowedReads: readonly Readonly<Rule>[];
  private readonly allowedWrites: readonly Readonly<Rule>[];
  private readonly allowedFactories: readonly Readonly<Rule>[];
  private readonly allowGeneratedConstruction: boolean;
  private readonly factoryNodes = new Set<ast.Node>();
  private readonly factoryOwners = new Set<types.TypeName>();
  // Generated files are excluded from checking but still declare types.
  private readonly generatedFiles = new Set<token.File>();

  constructor(private readonly pass: Pass<Config>) {
    this.info = pass.typesInfo;
    this.module = enclosingModule(pass);
    this.modulePath = this.module !== "" ? this.module : pass.pkg.path();
    this.allowedReads = pass.config.allowReads;
    this.allowedWrites = pass.config.allowWrites;
    this.allowedFactories = pass.config.allowFactory;
    this.allowGeneratedConstruction = pass.config.allowGeneratedConstruction;
  }

  isStandardPackage(pkg: types.Package | null): boolean {
    return pkg !== null && isStandardPath(pkg.path());
  }

  checkedFiles(): ast.File[] {
    const files: ast.File[] = [];
    for (const file of this.pass.files) {
      const name = this.pass.fset.positionFor(file.pos(), false).filename;
      if (ast.isGenerated(file)) {
        this.generatedFiles.add(this.pass.fset.file(file.pos())!);
        continue;
      }
      if (name.endsWith("_test.go")) {
        continue;
      }
      files.push(file);
    }
    return files;
  }

  collectTypes(): void {
    const scope = this.pass.pkg.scope()!;
    for (const name of scope.names()) {
      const object = scope.lookup(name);
      if (object?.$type !== "TypeName") {
        continue;
      }
      const named = object.type();
      if (named?.$type !== "Named") {
        continue;
      }
      const fields = named.underlying();
      if (fields?.$type !== "Struct") {
        continue;
      }
      let hasPrivate = false;
      for (let i = 0; i < fields.numFields(); i++) {
        const field = fields.field(i)!;
        if (!field.exported() && field.name() !== "_") {
          hasPrivate = true;
        }
      }
      if (!hasPrivate || (!object.exported() && named.numMethods() === 0)) {
        continue;
      }
      const file = this.pass.fset.file(object.pos());
      const fact: Encapsulated = {
        directConstructor: this.hasLocalConstructor(object),
        generated: file !== null && this.generatedFiles.has(file),
        module: this.module,
      };
      this.facts.set(object, fact);
      if (object.exported()) {
        this.pass.exportObjectFact(object, encapsulated, fact);
      }
    }
  }

  private hasLocalConstructor(owner: types.TypeName): boolean {
    // Factory sites are collected first and the package scope is complete, so
    // source order cannot change whether a type has a direct constructor.
    if (this.factoryOwners.has(owner)) {
      return true;
    }
    const scope = this.pass.pkg.scope()!;
    for (const name of scope.names()) {
      const fn = scope.lookup(name);
      if (fn?.$type === "Func" && this.isConstructor(fn, owner)) {
        return true;
      }
    }
    return false;
  }

  private metadata(object: types.TypeName | null): Readonly<Encapsulated> | undefined {
    if (object === null || this.isStandardPackage(object.pkg())) {
      return undefined;
    }
    if (object.pkg() === this.pass.pkg) {
      return this.facts.get(object);
    }
    const fact = this.pass.importObjectFact(object, encapsulated);
    // Like the standard library, other modules are outside the codebase being
    // linted, so their types are constructed through their public API.
    if (fact === undefined || (fact.module !== "" && this.module !== "" && fact.module !== this.module)) {
      return undefined;
    }
    return fact;
  }

  private isEncapsulated(object: types.TypeName | null): boolean {
    return this.metadata(object) !== undefined;
  }

  checkFile(file: ast.File): void {
    const options = new Map<ast.FuncLit, Context>();
    for (const decl of file.decls) {
      if (decl?.$type === "FuncDecl") {
        this.collectOptions(decl, options);
      }
    }
    const stack: Context[] = [emptyContext()];
    // Inspect enters parents before children. Keep the ancestor stack in step
    // with it so each construction can be tied to its exact field initializer.
    const ancestors: ast.Node[] = [];
    ast.inspect(file, (node) => {
      if (node === null) {
        stack.pop();
        ancestors.pop();
        return true;
      }
      let current = { ...stack[stack.length - 1] };
      switch (node.$type) {
        case "FuncDecl": {
          current = emptyContext();
          const fn = this.info.defs.get(node.name!);
          if (fn?.$type === "Func") {
            current.fn = fn;
            const signature = fn.type();
            const recv = signature?.$type === "Signature" ? signature.recv() : null;
            if (recv !== null) {
              current.method = typeName(recv.type());
            }
          }
          break;
        }
        case "FuncLit": {
          const option = options.get(node);
          current.target = option?.target ?? null;
          current.option = option?.option ?? null;
          break;
        }
        case "SelectorExpr":
          this.checkSelector(node, current, ancestors);
          break;
        case "CompositeLit":
          this.checkConstruction(node, this.info.typeOf(node), current, ancestors);
          break;
        case "CallExpr":
          this.checkNew(node, current, ancestors);
          break;
      }
      stack.push(current);
      ancestors.push(node);
      return true;
    });
  }

  private checkSelector(sel: ast.SelectorExpr, ctx: Context, ancestors: readonly ast.Node[]): void {
    const selection = this.info.selections.get(sel);
    if (!selection || selection.kind() !== types.FieldVal) {
      return;
    }
    const field = selection.obj();
    if (field?.$type !== "Var" || field.exported()) {
      return;
    }
    const owner = fieldOwner(selection);
    const fact = this.metadata(owner);
    if (owner === null || fact === undefined) {
      return;
    }
    if (ctx.method === owner || this.isConstructor(ctx.fn, owner)) {
      return;
    }
    // A type without its own constructor can be owned by the struct that
    // directly embeds it, but only through that struct's field selection.
    if (!fact.directConstructor && this.isEmbeddedFieldAccess(sel, selection, ctx.method, owner)) {
      return;
    }
    if (ctx.option === owner && this.isTarget(sel.x, ctx.target)) {
      return;
    }
    const rules = this.isWrite(sel, ancestors) ? this.allowedWrites : this.allowedReads;
    if (this.allows(rules, contextWriter(ctx), owner, true)) {
      return;
    }
    this.pass.report({
      pos: sel.sel!.pos(),
      message: `private field ${owner.pkg()!.path()}.${owner.name()}.${field.name()} may only be accessed by its methods, constructor, a direct functional option, or an eligible embedding type's methods`,
    });
  }

  private isEmbeddedFieldAccess(sel: ast.SelectorExpr, selection: types.Selection, method: types.TypeName | null, owner: types.TypeName): boolean {
    if (method === null) {
      return false;
    }
    if (typeName(selection.recv()) === method) {
      const index = selection.index();
      return index.length === 2 && isEmbeddedField(method, index[0], owner);
    }
    // An explicitly selected anonymous field, such as p.Checkpoint.private,
    // still belongs to the embedding method's receiver.
    const embedded = sel.x;
    if (embedded?.$type !== "SelectorExpr") {
      return false;
    }
    const parent = this.info.selections.get(embedded);
    return (
      !!parent &&
      parent.kind() === types.FieldVal &&
      typeName(parent.recv()) === method &&
      parent.index().length === 1 &&
      isEmbeddedField(method, parent.index()[0], owner)
    );
  }

  private isWrite(sel: ast.SelectorExpr, ancestors: readonly ast.Node[]): boolean {
    for (const ancestor of ancestors) {
      switch (ancestor.$type) {
        case "AssignStmt":
          if (ancestor.lhs.some((lhs) => writeTargetContains(lhs, sel))) {
            return true;
          }
          break;
        case "IncDecStmt":
          if (writeTargetContains(ancestor.x, sel)) {
            return true;
          }
          break;
        case "RangeStmt":
          if (ancestor.tok === token.ASSIGN && (writeTargetContains(ancestor.key, sel) || writeTargetContains(ancestor.value, sel))) {
            return true;
          }
          break;
        case "UnaryExpr":
          if (ancestor.op === token.AND && writeTargetContains(ancestor.x, sel)) {
            return true;
          }
          break;
        case "CallExpr":
          if (ancestor.args.length > 0 && this.isMutatingBuiltin(ancestor.fun) && writeTargetContains(ancestor.args[0], sel)) {
            return true;
          }
          break;
      }
    }
    return false;
  }

  private isMutatingBuiltin(expr: ast.Expr | null): boolean {
    if (expr?.$type !== "Ident") {
      return false;
    }
    const builtin = this.info.uses.get(expr);
    return builtin?.$type === "Builtin" && ["clear", "close", "copy", "delete"].includes(builtin.name());
  }

  private isTarget(expr: ast.Expr | null, target: types.Var | null): boolean {
    if (target === null) {
      return false;
    }
    for (;;) {
      if (expr?.$type === "ParenExpr" || expr?.$type === "StarExpr") {
        expr = expr.x;
        continue;
      }
      return expr?.$type === "Ident" && this.info.uses.get(expr) === target;
    }
  }

  private checkConstruction(node: ast.Node, t: types.Type | null, ctx: Context, ancestors: readonly ast.Node[]): void {
    const owner = typeName(t);
    const fact = this.metadata(owner);
    if (owner === null || fact === undefined) {
      return;
    }
    if ((fact.generated && this.allowGeneratedConstruction) || this.isConstructor(ctx.fn, owner) || this.factoryNodes.has(node)) {
      return;
    }
    if (!fact.directConstructor && this.inParentField(owner, ctx, ancestors, node)) {
      return;
    }
    this.pass.report({
      pos: node.pos(),
      message: `encapsulated struct ${owner.pkg()!.path()}.${owner.name()} may only be constructed in its constructor, returned from an allowed factory method, or used as a field in an eligible parent constructor`,
    });
  }

  private checkNew(call: ast.CallExpr, ctx: Context, ancestors: readonly ast.Node[]): void {
    const t = this.newType(call);
    if (t !== null) {
      this.checkConstruction(call, t, ctx, ancestors);
    }
  }

  private newType(call: ast.CallExpr): types.Type | null {
    if (call.fun?.$type !== "Ident" || call.args.length !== 1) {
      return null;
    }
    const builtin = this.info.uses.get(call.fun);
    if (builtin?.$type !== "Builtin" || builtin.name() !== "new") {
      return null;
    }
    return this.info.typeOf(call.args[0]);
  }

  private inParentField(owner: types.TypeName, ctx: Context, ancestors: readonly ast.Node[], node: ast.Node): boolean {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const lit = ancestors[i];
      if (lit.$type !== "CompositeLit" || !this.isConstructor(ctx.fn, typeName(this.info.typeOf(lit)))) {
        continue;
      }
      const element = i + 1 < ancestors.length ? ancestors[i + 1] : node;
      const field = this.literalField(lit, element);
      if (field !== null && fieldContainsType(field.type(), owner)) {
        return true;
      }
    }
    return false;
  }

  private literalField(lit: ast.CompositeLit, element: ast.Node): types.Var | null {
    const fields = types.unalias(this.info.typeOf(lit))?.underlying();
    if (fields?.$type !== "Struct") {
      return null;
    }
    if (element.$type === "KeyValueExpr") {
      if (element.key?.$type !== "Ident") {
        return null;
      }
      const field = this.info.uses.get(element.key);
      return field?.$type === "Var" ? field : null;
    }
    const index = lit.elts.indexOf(element as ast.Expr);
    return index >= 0 && index < fields.numFields() ? fields.field(index) : null;
  }

  private isConstructor(fn: types.Func | null, owner: types.TypeName | null): boolean {
    if (fn === null || owner === null || fn.pkg() !== this.pass.pkg) {
      return false;
    }
    const signature = fn.type();
    if (signature?.$type !== "Signature" || signature.recv() !== null) {
      return false;
    }
    const results = signature.results();
    for (let i = 0; i < (results?.len() ?? 0); i++) {
      if (constructorResult(results!.at(i)!.type(), owner)) {
        return true;
      }
    }
    return false;
  }

  private collectOptions(fn: ast.FuncDecl, options: Map<ast.FuncLit, Context>): void {
    const object = this.info.defs.get(fn.name!);
    if (object?.$type !== "Func" || fn.body === null) {
      return;
    }
    const signature = object.type();
    if (signature?.$type !== "Signature") {
      return;
    }
    // A nil Tuple is Go's empty tuple.
    const resultCount = signature.results()?.len() ?? 0;
    ast.inspect(fn.body, (node) => {
      if (node?.$type === "FuncLit") {
        return false;
      }
      if (node?.$type !== "ReturnStmt" || node.results.length !== resultCount) {
        return true;
      }
      for (const [i, expr] of node.results.entries()) {
        const [option, lit] = this.directOption(expr, signature.results()!.at(i)!.type());
        if (option === null || lit === null) {
          continue;
        }
        const optionSignature = option.underlying();
        if (optionSignature?.$type !== "Signature" || optionSignature.params()?.len() !== 1) {
          continue;
        }
        const owner = typeName(optionSignature.params()!.at(0)!.type());
        if (!this.isEncapsulated(owner)) {
          continue;
        }
        const params = lit.type!.params!.list;
        if (params.length !== 1 || params[0]!.names.length !== 1) {
          continue;
        }
        const target = this.info.defs.get(params[0]!.names[0]!);
        if (target?.$type === "Var") {
          options.set(lit, { method: null, fn: null, target, option: owner });
        }
      }
      return true;
    });
  }

  private directOption(expr: ast.Expr | null, result: types.Type | null): [types.Named | null, ast.FuncLit | null] {
    expr = ast.unparen(expr);
    if (expr?.$type === "FuncLit") {
      const option = types.unalias(result);
      return [option?.$type === "Named" ? option : null, expr];
    }
    if (expr?.$type !== "CallExpr" || expr.args.length !== 1) {
      return [null, null];
    }
    const conversion = this.info.types.get(expr.fun!);
    if (conversion === undefined || !conversion.isType()) {
      return [null, null];
    }
    const option = types.unalias(conversion.type);
    if (option?.$type !== "Named" || !types.assignableTo(option, result)) {
      return [null, null];
    }
    const arg = ast.unparen(expr.args[0]);
    return [option, arg?.$type === "FuncLit" ? arg : null];
  }

  private allows(rules: readonly Readonly<Rule>[], writer: types.Object | null, owner: types.TypeName, interfaces: boolean): boolean {
    for (const rule of rules) {
      if (!matchesAccessName(rule.writer, writer, this.modulePath)) {
        continue;
      }
      if (matchesAccessName(rule.target, owner, this.modulePath) || (interfaces && this.matchesInterfaceTarget(rule.target, owner))) {
        return true;
      }
    }
    return false;
  }

  // matchesInterfaceTarget accepts interfaces declared in, or directly
  // imported by, the target's package.
  private matchesInterfaceTarget(name: string, owner: types.TypeName): boolean {
    const pkg = owner.pkg();
    const named = owner.type();
    if (pkg === null || named?.$type !== "Named") {
      return false;
    }
    for (const candidatePackage of [pkg, ...pkg.imports()]) {
      const scope = candidatePackage!.scope()!;
      for (const symbol of scope.names()) {
        const candidate = scope.lookup(symbol);
        if (candidate?.$type !== "TypeName" || !matchesAccessName(name, candidate, this.modulePath)) {
          continue;
        }
        const iface = types.unalias(candidate.type())?.underlying();
        if (iface?.$type === "Interface" && implementedBy(named, iface)) {
          return true;
        }
      }
    }
    return false;
  }

  // Factory sites are collected before type facts so a later method
  // declaration still suppresses the parent-constructor fallback for its
  // returned type.
  collectFactoryConstructions(files: readonly ast.File[]): void {
    if (this.allowedFactories.length === 0) {
      return;
    }
    for (const file of files) {
      for (const declaration of file.decls) {
        if (declaration?.$type !== "FuncDecl" || declaration.body === null) {
          continue;
        }
        const fn = this.info.defs.get(declaration.name!);
        const signature = fn?.$type === "Func" ? fn.type() : null;
        if (signature?.$type !== "Signature") {
          continue;
        }
        const recv = signature.recv();
        const factory = recv === null ? null : typeName(recv.type());
        if (factory === null) {
          continue;
        }
        ast.inspect(declaration.body, (node) => {
          if (node?.$type === "FuncLit") {
            return false;
          }
          let owner: types.TypeName | null = null;
          if (node?.$type === "CompositeLit") {
            owner = typeName(this.info.typeOf(node));
          } else if (node?.$type === "CallExpr") {
            owner = typeName(this.newType(node));
          }
          if (node === null || owner === null || owner.pkg() !== this.pass.pkg || !this.allows(this.allowedFactories, factory, owner, true)) {
            return true;
          }
          if (this.factoryReturnsConstruction(declaration, signature, owner, node)) {
            this.factoryNodes.add(node);
            this.factoryOwners.add(owner);
          }
          return true;
        });
      }
    }
  }

  private factoryReturnsConstruction(method: ast.FuncDecl, signature: types.Signature, owner: types.TypeName, construction: ast.Node): boolean {
    const results = signature.results();
    const resultCount = results?.len() ?? 0;
    const returned = new Map<types.Var, token.Pos>();
    let direct = false;
    ast.inspect(method.body, (node) => {
      if (node?.$type === "FuncLit") {
        return false;
      }
      if (node?.$type !== "ReturnStmt") {
        return true;
      }
      if (node.results.length === 0) {
        for (let i = 0; i < resultCount; i++) {
          const result = results!.at(i)!;
          if (result.name() !== "" && constructorResult(result.type(), owner)) {
            returned.set(result, node.pos());
          }
        }
        return true;
      }
      if (node.results.length !== resultCount) {
        return true;
      }
      for (const [i, expr] of node.results.entries()) {
        if (!constructorResult(results!.at(i)!.type(), owner)) {
          continue;
        }
        const value = this.unwrapFactoryValue(expr);
        if (value === construction) {
          direct = true;
        }
        if (value?.$type === "Ident") {
          const variable = this.variable(value);
          if (variable !== null && node.pos() > (returned.get(variable) ?? 0)) {
            returned.set(variable, node.pos());
          }
        }
      }
      return true;
    });
    if (direct) {
      return true;
    }
    for (const [variable, returnPos] of returned) {
      if (returnPos > construction.pos() && this.singleFactoryAssignment(method.body!, variable, construction)) {
        return true;
      }
    }
    return false;
  }

  private unwrapFactoryValue(expr: ast.Expr | null): ast.Expr | null {
    for (;;) {
      if (expr?.$type === "ParenExpr") {
        expr = expr.x;
      } else if (expr?.$type === "UnaryExpr") {
        if (expr.op !== token.AND && expr.op !== token.MUL) {
          return expr;
        }
        expr = expr.x;
      } else if (expr?.$type === "CallExpr") {
        if (expr.args.length !== 1 || !(this.info.types.get(expr.fun!)?.isType() ?? false)) {
          return expr;
        }
        expr = expr.args[0];
      } else {
        return expr;
      }
    }
  }

  private variable(id: ast.Ident): types.Var | null {
    const defined = this.info.defs.get(id);
    if (defined?.$type === "Var") {
      return defined;
    }
    const used = this.info.uses.get(id);
    return used?.$type === "Var" ? used : null;
  }

  private singleFactoryAssignment(body: ast.BlockStmt, variable: types.Var, construction: ast.Node): boolean {
    let writes = 0;
    let matched = false;
    const isVariable = (expr: ast.Expr | null) => expr?.$type === "Ident" && this.variable(expr) === variable;
    ast.inspect(body, (node) => {
      switch (node?.$type) {
        case "FuncLit":
          return false;
        case "AssignStmt":
          for (const [i, lhs] of node.lhs.entries()) {
            if (!isVariable(lhs)) {
              continue;
            }
            writes++;
            if (node.lhs.length === node.rhs.length && this.unwrapFactoryValue(node.rhs[i]) === construction) {
              matched = true;
            }
          }
          break;
        case "ValueSpec":
          for (const [i, id] of node.names.entries()) {
            if (!isVariable(id) || node.values.length === 0) {
              continue;
            }
            writes++;
            if (node.names.length === node.values.length && this.unwrapFactoryValue(node.values[i]) === construction) {
              matched = true;
            }
          }
          break;
        case "RangeStmt":
          if (node.tok === token.ASSIGN) {
            writes += [node.key, node.value].filter(isVariable).length;
          }
          break;
        case "IncDecStmt":
          if (isVariable(node.x)) {
            writes++;
          }
          break;
      }
      return true;
    });
    return writes === 1 && matched;
  }
}

// standardPaths caches isStandardPath. Each runtime evaluates this module
// once, so the cache lasts for the runtime's life.
const standardPaths = new Map<string, boolean>();

// isStandardPath checks GOROOT instead of inferring standard-library ownership
// from the import path, which would also exclude packages in dotless modules.
// IgnoreVendor keeps build.Import in-process; otherwise, in module mode, it
// runs go list for every path outside GOROOT.
function isStandardPath(importPath: string): boolean {
  let standard = standardPaths.get(importPath);
  if (standard === undefined) {
    try {
      standard = build.import_(importPath, "", build.FindOnly | build.IgnoreVendor)!.goroot;
    } catch {
      standard = false; // Import fails for paths it cannot find.
    }
    standardPaths.set(importPath, standard);
  }
  return standard;
}

function matchesAccessName(name: string, object: types.Object | null, modulePath: string): boolean {
  if (name === "all") {
    return true;
  }
  const pkg = object?.pkg() ?? null;
  if (object === null || pkg === null) {
    return false;
  }
  const path = pkg.path();
  if (name === `${path}.${object.name()}`) {
    return true;
  }
  if (path === modulePath) {
    return name === object.name();
  }
  if (path.startsWith(`${modulePath}/`)) {
    return name === `${path.slice(modulePath.length + 1)}.${object.name()}`;
  }
  return false;
}

function namedType(t: types.Type | null): types.Named | null {
  t = types.unalias(t);
  if (t?.$type === "Pointer") {
    t = types.unalias(t.elem());
  }
  return t?.$type === "Named" ? t.origin() : null;
}

function typeName(t: types.Type | null): types.TypeName | null {
  return namedType(t)?.obj() ?? null;
}

function implementedBy(named: types.Named, iface: types.Interface): boolean {
  return types.implements_(named, iface) || types.implements_(types.newPointer(named), iface);
}

function isEmbeddedField(method: types.TypeName, index: number, owner: types.TypeName): boolean {
  const fields = method.type()?.underlying();
  if (fields?.$type !== "Struct" || index >= fields.numFields()) {
    return false;
  }
  const field = fields.field(index)!;
  return field.anonymous() && typeName(field.type()) === owner;
}

function writeTargetContains(expr: ast.Expr | null, target: ast.SelectorExpr): boolean {
  if (expr === target) {
    return true;
  }
  switch (expr?.$type) {
    case "ParenExpr":
    case "StarExpr":
    case "SelectorExpr":
    case "IndexExpr":
    case "SliceExpr":
      return writeTargetContains(expr.x, target);
  }
  return false;
}

function fieldOwner(selection: types.Selection): types.TypeName | null {
  let t = selection.recv();
  const index = selection.index();
  for (const [step, i] of index.entries()) {
    t = types.unalias(t);
    if (t?.$type === "Pointer") {
      t = types.unalias(t.elem());
    }
    const owner = typeName(t);
    const fields = t?.underlying();
    if (fields?.$type !== "Struct" || i >= fields.numFields()) {
      return null;
    }
    if (step === index.length - 1) {
      return owner;
    }
    t = fields.field(i)!.type();
  }
  return null;
}

function fieldContainsType(t: types.Type | null, owner: types.TypeName): boolean {
  t = types.unalias(t);
  switch (t?.$type) {
    case "Named":
      return t.origin()?.obj() === owner;
    case "Pointer":
    case "Slice":
    case "Array":
      return fieldContainsType(t.elem(), owner);
    case "Map":
      return fieldContainsType(t.key(), owner) || fieldContainsType(t.elem(), owner);
  }
  return false;
}

function constructorResult(result: types.Type | null, owner: types.TypeName): boolean {
  if (typeName(result) === owner) {
    return true;
  }
  const named = owner.type();
  const iface = types.unalias(result)?.underlying();
  return named?.$type === "Named" && iface?.$type === "Interface" && iface.numMethods() > 0 && implementedBy(named, iface);
}

// enclosingModule returns the module containing the analyzed package, or ""
// when neither the driver nor an enclosing go.mod identifies one.
function enclosingModule(pass: Pass<Config>): string {
  // Drivers know the module of vendored packages, which a go.mod search
  // cannot find.
  if (pass.module !== undefined && pass.module.path !== "") {
    return pass.module.path;
  }
  const path = pass.pkg.path();
  for (const file of pass.files) {
    let filename = pass.fset.positionFor(file.pos(), false).filename;
    try {
      filename = filepath.abs(filename);
    } catch {
      // Keep the relative name, as the Go linter does.
    }
    for (let dir = filepath.dir(filename); dir !== "."; dir = filepath.dir(dir)) {
      const data = readFile(filepath.join(dir, "go.mod"));
      if (data !== undefined) {
        const module = modfile.modulePath(data);
        // The nearest go.mod is the module boundary, even when this package
        // was loaded under a different import path.
        return module !== "" && (path === module || path.startsWith(`${module}/`)) ? module : "";
      }
      if (filepath.dir(dir) === dir) {
        break;
      }
    }
  }
  return "";
}

// readFile returns undefined when os.ReadFile fails, which it reports by
// throwing.
function readFile(name: string): string | undefined {
  try {
    return os.readFile(name);
  } catch {
    return undefined;
  }
}
