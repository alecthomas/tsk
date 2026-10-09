import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";

interface Config {
  /** Count writing to a field as using it. */
  fieldWritesAreUses: boolean;
  /** Count x++ and x-- as reading x. */
  postStatementsAreReads: boolean;
  /** Treat all exported fields as used. */
  exportedFieldsAreUsed: boolean;
  /** Treat all function parameters as used. */
  parametersAreUsed: boolean;
  /** Treat all local variables as used. */
  localVariablesAreUsed: boolean;
  /** Treat everything in generated files as used. */
  generatedIsUsed: boolean;
}

export default defineAnalyzer<Config>({
  name: "unused",
  doc: "Checks Go code for unused constants, variables, functions and types",
  url: "https://staticcheck.dev/docs/checks/#U1000",
  config: {
    fieldWritesAreUses: true,
    postStatementsAreReads: false,
    exportedFieldsAreUsed: true,
    parametersAreUsed: true,
    localVariablesAreUsed: true,
    generatedIsUsed: true,
  },
  run(pass) {
    const graph = new Graph(pass);
    graph.entry();
    for (const { object, kind, name } of graph.unused()) {
      pass.report({ pos: object.pos(), message: `${kind} ${name} is unused` });
    }
  },
});

interface Node {
  object: types.Object | null;
  uses: number[];
  owns: number[];
}

// Graph records which objects use and own which, after staticcheck's unused
// package. golangci-lint always treats exported identifiers as used, which
// this assumes throughout.
class Graph {
  private readonly pkg: types.Package;
  private readonly info: types.Info;
  private readonly opts: Config;
  private readonly nodes: Node[] = [{ object: null, uses: [], owns: [] }];
  private readonly objects = new Map<types.Object, number>();
  private readonly edges = new Set<string>();
  private readonly namedTypes: types.TypeName[] = [];
  private readonly interfaceTypes: types.Interface[] = [];

  constructor(private readonly pass: Pass<Config>) {
    this.pkg = pass.pkg;
    this.info = pass.typesInfo;
    this.opts = pass.config as Config;
  }

  // unused returns the objects not reachable from the root, skipping type
  // parameters and objects owned by unused ones.
  unused(): { object: types.Object; kind: string; name: string }[] {
    const ids = this.mergeByPosition();
    const seen = new Set<number>();
    const color = (id: number) => {
      if (seen.has(id)) {
        return;
      }
      seen.add(id);
      for (const used of ids.uses.get(id) ?? []) {
        color(used);
      }
    };
    color(0);
    const quiet = new Set<number>();
    const quieten = (id: number) => {
      quiet.add(id);
      for (const owned of ids.owns.get(id) ?? []) {
        quieten(owned);
      }
    };
    for (const id of ids.canonical) {
      if (!seen.has(id)) {
        for (const owned of ids.owns.get(id) ?? []) {
          quieten(owned);
        }
      }
    }
    const result: { object: types.Object; kind: string; name: string }[] = [];
    const usedKeys = new Set<string>();
    const describe = (id: number) => {
      const object = this.nodes[id].object!;
      const position = this.pass.fset.position(object.pos());
      // As staticcheck's command keys objects, by file, line and name.
      const file = position.filename.slice(position.filename.lastIndexOf("/") + 1);
      return { object, kind: kindOf(object), name: displayName(object), key: [file, position.line, displayName(object)].join(":") };
    };
    for (const id of ids.canonical) {
      if (id !== 0 && seen.has(id)) {
        usedKeys.add(describe(id).key);
      }
    }
    for (const id of ids.canonical) {
      if (id === 0 || seen.has(id) || quiet.has(id)) {
        continue;
      }
      const d = describe(id);
      // Skip objects another variant of the package uses, as staticcheck's
      // command does, and unused type parameters.
      if (d.kind !== "type param" && !usedKeys.has(d.key)) {
        result.push(d);
      }
    }
    return result;
  }

  // mergeByPosition merges nodes of objects declared at the same position,
  // as upstream's serialized graph does.
  private mergeByPosition(): { canonical: number[]; uses: Map<number, number[]>; owns: Map<number, number[]> } {
    const byPosition = new Map<string, number>();
    const canonicalOf: number[] = [];
    const canonical: number[] = [];
    this.nodes.forEach((node, id) => {
      const position = node.object === null ? null : this.pass.fset.position(node.object.pos());
      const key = position === null || position.column === 0 ? null : `${position.filename}:${position.line}:${position.column}`;
      const existing = key === null ? undefined : byPosition.get(key);
      if (existing !== undefined) {
        canonicalOf[id] = existing;
        return;
      }
      if (key !== null) {
        byPosition.set(key, id);
      }
      canonicalOf[id] = id;
      canonical.push(id);
    });
    const uses = new Map<number, number[]>();
    const owns = new Map<number, number[]>();
    this.nodes.forEach((node, id) => {
      const c = canonicalOf[id];
      uses.set(c, [...(uses.get(c) ?? []), ...node.uses.map((u) => canonicalOf[u])]);
      owns.set(c, [...(owns.get(c) ?? []), ...node.owns.map((o) => canonicalOf[o])]);
    });
    return { canonical, uses, owns };
  }

  private node(object: types.Object | null): number {
    if (object === null) {
      return 0;
    }
    const obj = origin(object);
    let id = this.objects.get(obj);
    if (id === undefined) {
      id = this.nodes.length;
      this.nodes.push({ object: obj, uses: [], owns: [] });
      this.objects.set(obj, id);
    }
    return id;
  }

  private addEdge(from: number, to: number, kind: "use" | "own"): void {
    const key = `${from}:${to}:${kind}`;
    if (this.edges.has(key)) {
      return;
    }
    this.edges.add(key);
    this.nodes[from][kind === "use" ? "uses" : "owns"].push(to);
  }

  // see records an object, owned by owner if given.
  private see(object: types.Object | null, owner: types.Object | null): void {
    if (object === null || object.pkg() !== this.pkg) {
      return;
    }
    const id = this.node(object);
    if (owner !== null) {
      this.addEdge(this.node(owner), id, "own");
    }
  }

  private use(used: types.Object | null, by: types.Object | null): void {
    if (used === null || used.pkg() !== this.pkg || (by !== null && by.pkg() !== this.pkg) || used.$type === "PkgName") {
      return;
    }
    this.addEdge(this.node(by), this.node(used), "use");
  }

  entry(): void {
    for (const file of this.pass.files) {
      for (const group of file!.comments) {
        for (const comment of group!.list) {
          // (1.8) packages use symbols linked via go:linkname
          const fields = comment!.text.split(/\s+/).filter((f) => f !== "");
          if (comment!.text.startsWith("//go:linkname ") && fields.length === 3) {
            this.use(this.pkg.scope()!.lookup(fields[1]), null);
          }
        }
      }
    }
    for (const file of this.pass.files) {
      for (const decl of file!.decls) {
        this.decl(decl!, null);
      }
    }
    if (this.opts.generatedIsUsed) {
      const generated = new Set(this.pass.files.filter((f) => isGenerated(this.pass, f!)).map((f) => this.pass.fset.position(f!.pos()).filename));
      for (const object of [...this.objects.keys()]) {
        if (generated.has(this.pass.fset.position(object.pos()).filename)) {
          this.use(object, null);
        }
      }
    }
    const allInterfaces = new Set(this.interfaceTypes);
    for (const instance of this.info.instances.values()) {
      const t = instance?.type;
      if (t?.$type === "Named" && t.obj()?.pkg() === this.pkg) {
        const iface = t.underlying();
        if (iface?.$type === "Interface") {
          allInterfaces.add(iface);
        }
      }
    }
    const processMethodSet = (named: types.TypeName, ms: types.MethodSet) => {
      for (let i = 0; i < ms.len(); i++) {
        const m = ms.at(i)!;
        if (token.isExported(m.obj()!.name())) {
          // (2.1) named types use exported methods
          // (6.4) structs use embedded fields that have exported methods
          this.readSelection(m, named);
        }
      }
      if (named.type()?.underlying()?.$type === "Interface") {
        return;
      }
      // (8.2) any concrete type implements all known interfaces
      // (6.3) structs use embedded fields that help implement interfaces
      for (const iface of allInterfaces) {
        for (const sel of implementingSelections(named.type()!, iface, ms) ?? []) {
          this.readSelection(sel, named);
        }
      }
    };
    for (const named of this.namedTypes) {
      processMethodSet(named, types.newMethodSet(named.type())!);
      processMethodSet(named, types.newMethodSet(types.newPointer(named.type()))!);
    }
    this.useIgnored();
  }

  // useIgnored uses objects on lines with a //lint:ignore U1000 directive,
  // or in files with //lint:file-ignore U1000.
  private useIgnored(): void {
    const ignores = new Set<string>();
    for (const file of this.pass.files) {
      for (const [node, groups] of ast.newCommentMap(this.pass.fset, file, file!.comments)) {
        for (const group of groups) {
          for (const comment of group!.list) {
            if (!comment!.text.startsWith("//lint:")) {
              continue;
            }
            const [command, checks] = comment!.text.slice("//lint:".length).split(" ");
            if ((command !== "ignore" && command !== "file-ignore") || checks === undefined || !checks.split(",").includes("U1000")) {
              continue;
            }
            const position = this.pass.fset.position(node.pos());
            ignores.add(`${position.filename}:${command === "ignore" ? position.line : -1}`);
          }
        }
      }
    }
    if (ignores.size === 0) {
      return;
    }
    for (const object of [...this.objects.keys()]) {
      const position = this.pass.fset.position(object.pos());
      if (!ignores.has(`${position.filename}:${position.line}`) && !ignores.has(`${position.filename}:-1`)) {
        continue;
      }
      this.use(object, null);
      if (object.$type !== "TypeName") {
        continue;
      }
      const named = types.unalias(object.type());
      // Ignoring an alias of another package's type need not walk it.
      if (object.isAlias() && named?.$type === "Named" && named.obj()?.pkg() !== object.pkg()) {
        continue;
      }
      if (named?.$type === "Named") {
        for (let i = 0; i < named.numMethods(); i++) {
          this.use(named.method(i), null);
        }
      }
      const struct = object.type()?.underlying();
      if (struct?.$type === "Struct") {
        for (let i = 0; i < struct.numFields(); i++) {
          this.use(struct.field(i), null);
        }
      }
    }
  }

  private read(node: ast.Node | null, by: types.Object | null): void {
    if (node === null) {
      return;
    }
    switch (node.$type) {
      case "Ident":
        // Among other things, (7.1) field accesses use fields
        this.use(this.info.objectOf(node), by);
        break;
      case "BasicLit":
        break;
      case "SliceExpr":
        this.read(node.x, by);
        this.read(node.low, by);
        this.read(node.high, by);
        this.read(node.max, by);
        break;
      case "UnaryExpr":
      case "ParenExpr":
      case "StarExpr":
        this.read(node.x, by);
        break;
      case "ArrayType":
        this.read(node.len, by);
        this.read(node.elt, by);
        break;
      case "SelectorExpr":
        this.readSelectorExpr(node, by);
        break;
      case "IndexExpr":
        // (2.6) named types use all their type arguments
        this.read(node.x, by);
        this.read(node.index, by);
        break;
      case "IndexListExpr":
        this.read(node.x, by);
        for (const index of node.indices) {
          this.read(index, by);
        }
        break;
      case "BinaryExpr":
        this.read(node.x, by);
        this.read(node.y, by);
        break;
      case "CompositeLit":
        this.compositeLit(node, by);
        break;
      case "KeyValueExpr":
        this.read(node.key, by);
        this.read(node.value, by);
        break;
      case "MapType":
        this.read(node.key, by);
        this.read(node.value, by);
        break;
      case "FuncLit": {
        this.read(node.type, by);
        // Unnamed parameters have no identifiers for the AST walk to find.
        const sig = this.info.typeOf(node);
        if (sig?.$type === "Signature") {
          this.seeParams(sig, by);
        }
        this.block(node.body, by);
        break;
      }
      case "FuncType": {
        const skip = new Set<types.Object>();
        if (!this.opts.parametersAreUsed) {
          for (const field of node.params!.list) {
            for (const name of field!.names) {
              skip.add(this.info.objectOf(name!)!);
            }
          }
        }
        this.seeScope(node, by, skip);
        // (4.1) functions use all their arguments, return parameters and receivers
        // (12.1) type parameters use their constraint type
        this.read(node.typeParams, by);
        if (this.opts.parametersAreUsed) {
          this.read(node.params, by);
        }
        this.read(node.results, by);
        break;
      }
      case "FieldList":
        // Only parameter lists reach here; struct fields and interface
        // methods are handled elsewhere.
        for (const field of node.list) {
          if (field!.names.length === 0) {
            this.read(field!.type, by);
          }
          for (const name of field!.names) {
            const object = this.info.objectOf(name!);
            this.use(object, by);
            this.read(field!.type, object);
          }
        }
        break;
      case "ChanType":
        this.read(node.value, by);
        break;
      case "StructType":
        // Only anonymous struct types reach here. (11.1) they use all their fields.
        for (const field of node.fields!.list) {
          if (field!.names.length === 0) {
            this.use(this.embeddedField(field!.type!, by), by);
          }
          for (const name of field!.names) {
            const object = this.info.objectOf(name!);
            this.see(object, by);
            this.use(object, by);
            this.read(field!.type, object);
          }
        }
        break;
      case "TypeAssertExpr":
        this.read(node.x, by);
        this.read(node.type, by);
        break;
      case "InterfaceType": {
        const iface = this.info.typeOf(node);
        if (node.methods!.list.length !== 0 && iface?.$type === "Interface") {
          this.interfaceTypes.push(iface);
        }
        for (const method of node.methods!.list) {
          if (method!.names.length === 0) {
            // (8.4) embedded interfaces and type sets are used
            this.read(method!.type, by);
          } else {
            // (8.3) all interface methods are used
            const object = this.info.objectOf(method!.names[0]!);
            this.see(object, by);
            this.use(object, by);
            this.read(method!.type, object);
          }
        }
        break;
      }
      case "Ellipsis":
        this.read(node.elt, by);
        break;
      case "CallExpr":
        this.read(node.fun, by);
        for (const arg of node.args) {
          this.read(arg, by);
        }
        this.conversion(node, by);
        break;
    }
  }

  private compositeLit(node: ast.CompositeLit, by: types.Object | null): void {
    this.read(node.type, by);
    // The literal's own type covers nested literals of the kind T{{...}}.
    const struct = coreType(this.info.typeOf(node));
    if (struct?.$type !== "Struct") {
      for (const elt of node.elts) {
        this.read(elt, by);
      }
      return;
    }
    const unkeyed = node.elts.length !== 0 && node.elts[0]!.$type !== "KeyValueExpr";
    if (this.opts.fieldWritesAreUses && unkeyed) {
      // An unkeyed literal names no fields, so use them all.
      for (let i = 0; i < struct.numFields(); i++) {
        this.use(struct.field(i), by);
      }
    }
    if (this.opts.fieldWritesAreUses || unkeyed) {
      for (const elt of node.elts) {
        this.read(elt, by);
      }
    } else {
      for (const elt of node.elts) {
        const kv = elt as ast.KeyValueExpr;
        this.write(kv.key, by);
        this.read(kv.value, by);
      }
    }
    if (this.opts.fieldWritesAreUses && !unkeyed) {
      // Promoted fields use the embedded fields leading to them.
      for (const elt of node.elts) {
        const key = (elt as ast.KeyValueExpr).key as ast.Ident;
        const [, index] = types.lookupFieldOrMethod(struct, true, this.pkg, key.name);
        let cur: types.Type | null = struct;
        for (const step of (index ?? []).slice(0, -1)) {
          const field: types.Var | null = cur?.$type === "Struct" ? cur.field(step) : null;
          this.use(field, by);
          cur = coreType(field?.type() ?? null);
        }
      }
    }
  }

  private conversion(call: ast.CallExpr, by: types.Object | null): void {
    if (call.args.length !== 1 || call.ellipsis !== token.NoPos) {
      return;
    }
    const tSrc = coreType(dereference(this.info.typeOf(call.args[0]!)));
    const tDst = coreType(dereference(this.info.typeOf(call.fun!)));
    const unsafePointer = types.Typ[types.UnsafePointer];
    if (tSrc?.$type === "Struct" && tDst?.$type === "Struct") {
      // (5.1) fields of equivalent structs use each other.
      for (let i = 0; i < Math.min(tSrc.numFields(), tDst.numFields()); i++) {
        this.use(tDst.field(i), tSrc.field(i));
        this.use(tSrc.field(i), tDst.field(i));
      }
    } else if (tSrc?.$type === "Struct" && tDst === unsafePointer) {
      // (5.2) converting to or from unsafe.Pointer uses all fields.
      this.useAllFieldsRecursively(tSrc, by);
    } else if (tDst?.$type === "Struct" && tSrc === unsafePointer) {
      this.useAllFieldsRecursively(tDst, by);
    }
  }

  private useAllFieldsRecursively(t: types.Type | null, by: types.Object | null): void {
    const u = t?.underlying();
    if (u?.$type === "Struct") {
      for (let i = 0; i < u.numFields(); i++) {
        this.use(u.field(i), by);
        this.useAllFieldsRecursively(u.field(i)!.type(), by);
      }
    } else if (u?.$type === "Array") {
      this.useAllFieldsRecursively(u.elem(), by);
    }
  }

  private write(node: ast.Node | null, by: types.Object | null): void {
    if (node === null) {
      return;
    }
    switch (node.$type) {
      case "Ident": {
        // `switch x := v.(type)` declares an x without an object.
        const object = this.info.objectOf(node);
        if (object === null) {
          return;
        }
        // (4.9) tests use package-level variables they assign to, as sinks.
        if (this.pass.fset.position(object.pos()).filename.endsWith("_test.go") && object.parent() === object.pkg()?.scope()) {
          this.use(object, by);
        }
        break;
      }
      case "IndexExpr":
        this.read(node.x, by);
        this.read(node.index, by);
        break;
      case "SelectorExpr":
        if (this.opts.fieldWritesAreUses) {
          // Writing to a field uses it.
          this.readSelectorExpr(node, by);
        } else {
          this.read(node.x, by);
          this.write(node.sel, by);
        }
        break;
      case "StarExpr":
        this.read(node.x, by);
        break;
      case "ParenExpr":
        this.write(node.x, by);
        break;
    }
  }

  // readSelectorExpr reads a selector, including implicit fields.
  private readSelectorExpr(sel: ast.SelectorExpr, by: types.Object | null): void {
    this.read(sel.x, by);
    this.read(sel.sel, by);
    const selection = this.info.selections.get(sel);
    if (selection) {
      this.readSelection(selection, by);
    }
  }

  private readSelection(sel: types.Selection, by: types.Object | null): void {
    const indices = sel.index();
    let base = sel.recv();
    for (const idx of indices.slice(0, -1)) {
      const struct = dereference(base?.underlying() ?? null)?.underlying();
      const field = struct?.$type === "Struct" ? struct.field(idx) : null;
      this.use(field, by);
      base = field?.type() ?? null;
    }
    this.use(sel.obj(), by);
  }

  private block(block: ast.BlockStmt | null, by: types.Object | null): void {
    if (block === null) {
      return;
    }
    this.seeScope(block, by, null);
    for (const stmt of block.list) {
      this.stmt(stmt, by);
    }
  }

  private seeParams(sig: types.Signature, by: types.Object | null): void {
    const params = sig.params();
    for (let i = 0; i < (params?.len() ?? 0); i++) {
      const param = params!.at(i)!;
      this.see(param, by);
      if (param.name() === "") {
        this.use(param, by);
      }
    }
  }

  private decl(decl: ast.Decl, by: types.Object | null): void {
    if (decl.$type === "FuncDecl") {
      this.funcDecl(decl);
      return;
    }
    if (decl.$type !== "GenDecl") {
      return;
    }
    if (decl.tok === token.CONST) {
      this.constDecl(decl, by);
    } else if (decl.tok === token.TYPE) {
      for (const spec of decl.specs) {
        this.typeSpec(spec as ast.TypeSpec, by);
      }
    } else if (decl.tok === token.VAR) {
      for (const spec of decl.specs) {
        const vspec = spec as ast.ValueSpec;
        vspec.names.forEach((name, i) => {
          const object = this.info.objectOf(name!);
          this.see(object, by);
          // Variables use their types and values.
          this.read(vspec.type, object);
          if (vspec.names.length === vspec.values.length) {
            this.read(vspec.values[i], object);
          } else if (vspec.values.length !== 0) {
            this.read(vspec.values[0], object);
          }
          if (token.isExported(name!.name) && isGlobal(object)) {
            // (1.3) packages use exported variables
            this.use(object, null);
          }
          if (name!.name === "_") {
            // (9.9) objects named the blank identifier are used
            this.use(object, by);
          }
        });
      }
    }
  }

  private constDecl(decl: ast.GenDecl, by: types.Object | null): void {
    for (const spec of decl.specs) {
      const vspec = spec as ast.ValueSpec;
      vspec.names.forEach((name, i) => {
        const object = this.info.objectOf(name!);
        this.see(object, by);
        this.read(vspec.type, object);
        if (vspec.values.length !== 0) {
          this.read(vspec.values[i], object);
        }
        if (name!.name === "_") {
          this.use(object, by);
        } else if (token.isExported(name!.name) && isGlobal(object)) {
          this.use(object, null);
        }
      });
    }
    // (10.1) a used constant of a group uses the whole group, encoded as a
    // ring. Groups are runs of specs on consecutive lines.
    for (const group of this.groupSpecs(decl.specs as ast.Spec[])) {
      let first: types.Object | null = null;
      let prev: types.Object | null = null;
      let last: types.Object | null = null;
      for (const spec of group) {
        for (const name of (spec as ast.ValueSpec).names) {
          // Blank constants do not mark the group used.
          if (name!.name === "_") {
            continue;
          }
          const object = this.info.objectOf(name!);
          if (first === null) {
            first = object;
          } else {
            this.use(object, prev);
          }
          prev = object;
          last = object;
        }
      }
      if (first !== null && first !== last) {
        this.use(first, last);
      }
    }
  }

  private groupSpecs(specs: ast.Spec[]): ast.Spec[][] {
    const groups: ast.Spec[][] = [];
    for (const spec of specs) {
      const group = groups[groups.length - 1];
      const prevEnd = group === undefined ? -2 : this.pass.fset.position(group[group.length - 1].end()).line;
      if (group === undefined || this.pass.fset.position(spec.pos()).line - 1 !== prevEnd) {
        groups.push([spec]);
      } else {
        group.push(spec);
      }
    }
    return groups;
  }

  private typeSpec(tspec: ast.TypeSpec, by: types.Object | null): void {
    const object = this.info.objectOf(tspec.name!) as types.TypeName;
    this.see(object, by);
    this.seeScope(tspec, object, null);
    if (tspec.assign === token.NoPos) {
      this.namedTypes.push(object);
    }
    if (token.isExported(tspec.name!.name) && isGlobal(object)) {
      // (1.1) packages use exported named types
      this.use(object, null);
    }
    // (2.5) named types use all their type parameters
    this.read(tspec.typeParams, object);
    this.namedType(object, tspec.type!);
    if (tspec.name!.name === "_") {
      this.use(object, by);
    }
  }

  private funcDecl(decl: ast.FuncDecl): void {
    const object = (this.info.objectOf(decl.name!) as types.Func).origin()!;
    this.see(object, null);
    const name = decl.name!.name;
    if (token.isExported(name)) {
      if (decl.recv === null) {
        // (1.2) packages use exported functions
        this.use(object, null);
      }
    } else if (name === "init" || (name === "main" && this.pkg.name() === "main")) {
      // (1.5) init functions, and (1.7) main in a main package
      this.use(object, null);
    }
    // (4.1) functions use their receivers
    this.read(decl.recv, object);
    this.read(decl.type, object);
    this.block(decl.body, object);
    // Unnamed parameters have no identifiers for the AST walk to find.
    const sig = this.info.typeOf(decl.name!);
    if (sig?.$type === "Signature") {
      this.seeParams(sig, object);
    }
    if (name === "_") {
      this.use(object, null);
    }
    if (decl.doc?.list.some((c) => c!.text.startsWith("//go:cgo_export_"))) {
      // (1.6) packages use functions exported to cgo
      this.use(object, null);
    }
  }

  // seeScope sees the objects in a node's scope, using local variables unless
  // skipped, when local variables count as used.
  private seeScope(node: ast.Node, by: types.Object | null, skip: Set<types.Object> | null): void {
    const scope = this.info.scopes.get(node);
    if (!scope) {
      return;
    }
    for (const name of scope.names()) {
      const object = scope.lookup(name);
      this.see(object, by);
      if (this.opts.localVariablesAreUsed && object?.$type === "Var" && !object.isField() && !skip?.has(object)) {
        this.use(object, by);
      }
    }
  }

  private stmt(stmt: ast.Stmt | null, by: types.Object | null): void {
    // Labels do not matter.
    while (stmt?.$type === "LabeledStmt") {
      stmt = stmt.stmt;
    }
    if (stmt === null) {
      return;
    }
    switch (stmt.$type) {
      case "AssignStmt":
        for (const lhs of stmt.lhs) {
          this.write(lhs, by);
        }
        for (const rhs of stmt.rhs) {
          this.read(rhs, by);
        }
        break;
      case "BlockStmt":
        this.block(stmt, by);
        break;
      case "DeclStmt":
        this.decl(stmt.decl!, by);
        break;
      case "DeferStmt":
      case "GoStmt":
        this.read(stmt.call, by);
        break;
      case "ExprStmt":
        this.read(stmt.x, by);
        break;
      case "ForStmt":
        this.seeScope(stmt, by, null);
        this.stmt(stmt.init, by);
        this.read(stmt.cond, by);
        this.stmt(stmt.post, by);
        this.block(stmt.body, by);
        break;
      case "IfStmt":
        this.seeScope(stmt, by, null);
        this.stmt(stmt.init, by);
        this.read(stmt.cond, by);
        this.block(stmt.body, by);
        this.stmt(stmt.else, by);
        break;
      case "IncDecStmt":
        // x++ only writes x, unless configured otherwise.
        if (this.opts.postStatementsAreReads) {
          this.read(stmt.x, by);
        }
        this.write(stmt.x, by);
        break;
      case "RangeStmt":
        this.seeScope(stmt, by, null);
        this.write(stmt.key, by);
        this.write(stmt.value, by);
        this.read(stmt.x, by);
        this.block(stmt.body, by);
        break;
      case "ReturnStmt":
        for (const result of stmt.results) {
          this.read(result, by);
        }
        break;
      case "SelectStmt":
        for (const clause of stmt.body!.list) {
          const cc = clause as ast.CommClause;
          this.seeScope(cc, by, null);
          const comm = cc.comm;
          if (comm?.$type === "SendStmt") {
            this.read(comm.chan, by);
            this.read(comm.value, by);
          } else if (comm?.$type === "ExprStmt") {
            let x = comm.x;
            while (x?.$type === "ParenExpr") {
              x = x.x;
            }
            this.read(x?.$type === "UnaryExpr" ? x.x : x, by);
          } else if (comm?.$type === "AssignStmt") {
            for (const lhs of comm.lhs) {
              this.write(lhs, by);
            }
            for (const rhs of comm.rhs) {
              this.read(rhs, by);
            }
          }
          for (const body of cc.body) {
            this.stmt(body, by);
          }
        }
        break;
      case "SendStmt":
        this.read(stmt.chan, by);
        this.read(stmt.value, by);
        break;
      case "SwitchStmt":
      case "TypeSwitchStmt":
        this.seeScope(stmt, by, null);
        this.stmt(stmt.init, by);
        if (stmt.$type === "SwitchStmt") {
          this.read(stmt.tag, by);
        } else {
          this.stmt(stmt.assign, by);
        }
        for (const clause of stmt.body!.list) {
          const cc = clause as ast.CaseClause;
          this.seeScope(cc, by, null);
          for (const expr of cc.list) {
            this.read(expr, by);
          }
          for (const body of cc.body) {
            this.stmt(body, by);
          }
        }
        break;
    }
  }

  // embeddedField sees the field an embedded field node declares, and marks
  // its type as used by the field.
  private embeddedField(node: ast.Expr, by: types.Object | null): types.Var | null {
    const pending: ast.Expr[] = [];
    let cur: ast.Expr | null = node;
    for (;;) {
      if (cur?.$type === "Ident") {
        const field = this.info.objectOf(cur) as types.Var | null;
        this.see(field, by);
        for (const n of pending) {
          this.read(n, field);
        }
        const typeName = this.info.uses.get(cur);
        if (typeName?.$type === "TypeName" && typeName.isAlias()) {
          // Embedding an alias uses the alias, not its target.
          this.use(typeName, field);
        } else {
          const t = dereference(this.info.typeOf(cur));
          if (t?.$type === "Named") {
            // (7.2) fields use their types
            this.use(t.obj(), field);
          }
        }
        return field;
      }
      if (cur?.$type === "StarExpr") {
        cur = cur.x;
      } else if (cur?.$type === "SelectorExpr") {
        pending.push(cur.x!);
        cur = cur.sel;
      } else if (cur?.$type === "IndexExpr") {
        pending.push(cur.index!);
        cur = cur.x;
      } else if (cur?.$type === "IndexListExpr") {
        cur = cur.x;
      } else {
        return null;
      }
    }
  }

  // namedType records what a named type uses: (2.2) the type it is based
  // on, or for structs, the fields that count as used.
  private namedType(typeName: types.TypeName, spec: ast.Expr): void {
    if (spec.$type !== "StructType") {
      this.read(spec, typeName);
      return;
    }
    let hasHostLayout = false;
    const self = this.info.typeOf(spec);
    for (const field of spec.fields!.list) {
      // Skips the struct itself, as in `type x struct { *x; F int }`.
      const seen = new Set<types.Type | null>([self]);
      const hasExportedField = (t: types.Type | null): boolean => {
        const struct = dereference(t)?.underlying();
        if (struct?.$type !== "Struct" || seen.has(struct)) {
          return false;
        }
        seen.add(struct);
        for (let i = 0; i < struct.numFields(); i++) {
          const f = struct.field(i)!;
          if (f.exported() || (f.embedded() && hasExportedField(f.type()))) {
            return true;
          }
        }
        return false;
      };
      if (field!.names.length === 0) {
        const fieldVar = this.embeddedField(field!.type!, typeName);
        if (fieldVar !== null && token.isExported(fieldVar.name())) {
          // (6.2) structs use exported fields
          this.use(fieldVar, typeName);
        }
        if (fieldVar !== null && this.opts.exportedFieldsAreUsed && hasExportedField(fieldVar.type())) {
          // (6.5) structs use embedded structs that have exported fields
          this.use(fieldVar, typeName);
        }
      }
      for (const name of field!.names) {
        const object = this.info.objectOf(name!);
        this.see(object, typeName);
        // (7.2) fields use their types
        this.read(field!.type, object);
        if (name!.name === "_" || token.isExported(name!.name)) {
          // (9.9) blank fields, and (6.2) exported fields, are used
          this.use(object, typeName);
        }
        if (isNoCopyType(object?.type() ?? null)) {
          // (6.1) structs use NoCopy sentinel fields
          this.use(object, typeName);
        }
      }
      // (6.6) a structs.HostLayout field makes every field matter.
      const fieldType = types.unalias(this.info.typeOf(field!.type!));
      if (fieldType?.$type === "Named" && fieldType.obj()?.name() === "HostLayout" && fieldType.obj()?.pkg()?.path() === "structs") {
        hasHostLayout = true;
      }
    }
    if (hasHostLayout) {
      this.useAllFieldsRecursively(typeName.type(), typeName);
    }
  }
}

function origin(object: types.Object): types.Object {
  if (object.$type === "Var" || object.$type === "Func") {
    return object.origin() ?? object;
  }
  return object;
}

function isGlobal(object: types.Object | null): boolean {
  return object !== null && object.parent() === object.pkg()?.scope();
}

function kindOf(object: types.Object): string {
  switch (object.$type) {
    case "Func":
      return "func";
    case "Var":
      return object.isField() ? "field" : "var";
    case "Const":
      return "const";
    case "TypeName":
      return object.type()?.$type === "TypeParam" ? "type param" : "type";
    default:
      return "identifier";
  }
}

// displayName names an object, qualifying methods by receiver, as
// "(*T).m" or "T.m".
function displayName(object: types.Object): string {
  const sig = object.type();
  const recv = sig?.$type === "Signature" ? sig.recv() : null;
  const recvType = types.unalias(recv?.type() ?? null);
  if (recvType?.$type !== "Named" && recvType?.$type !== "Pointer") {
    return object.name();
  }
  const typ = types.typeString(recv!.type(), () => "");
  if (typ.startsWith("*")) {
    return `(${typ}).${object.name()}`;
  }
  return typ === "" ? object.name() : `${typ}.${object.name()}`;
}

function dereference(t: types.Type | null): types.Type | null {
  const u = t?.underlying();
  return u?.$type === "Pointer" ? u.elem() : t;
}

// coreType returns a type's underlying type or, for a type parameter, the
// underlying type all its constraint's terms share. Upstream's special case
// for directional channels is left out.
function coreType(t: types.Type | null): types.Type | null {
  const u = t?.underlying() ?? null;
  if (u?.$type !== "Interface") {
    return u;
  }
  const terms = constraintTerms(u);
  if (terms === null || terms.length === 0) {
    return null;
  }
  const first = terms[0].underlying();
  return terms.every((term) => types.identical(term.underlying(), first)) ? first : null;
}

// constraintTerms lists the types an interface's type set is built from, or
// null if it is not restricted to specific types.
function constraintTerms(iface: types.Interface): types.Type[] | null {
  let result: types.Type[] | null = null;
  for (let i = 0; i < iface.numEmbeddeds(); i++) {
    const embedded = iface.embeddedType(i);
    let terms: types.Type[] | null;
    if (embedded?.$type === "Union") {
      terms = [...Array(embedded.len()).keys()].map((j) => embedded.term(j)!.type()!);
    } else if (embedded?.underlying()?.$type === "Interface") {
      terms = constraintTerms(embedded.underlying() as types.Interface);
    } else {
      terms = embedded === null ? null : [embedded];
    }
    if (terms !== null) {
      // Intersecting term sets is approximated by keeping the last.
      result = terms;
    }
  }
  return result;
}

// isNoCopyType reports whether a type is a field-less struct whose only
// methods are Lock and Unlock, used to prevent copying.
function isNoCopyType(t: types.Type | null): boolean {
  const struct = t?.underlying();
  const named = types.unalias(t);
  if (struct?.$type !== "Struct" || struct.numFields() !== 0 || named?.$type !== "Named") {
    return false;
  }
  const n = named.numMethods();
  if (n !== 1 && n !== 2) {
    return false;
  }
  for (let i = 0; i < n; i++) {
    const m = named.method(i)!;
    const sig = m.type() as types.Signature;
    if ((m.name() !== "Lock" && m.name() !== "Unlock") || (sig.params()?.len() ?? 0) !== 0 || (sig.results()?.len() ?? 0) !== 0) {
      return false;
    }
  }
  return true;
}

// isGenerated reports whether a file has a "// Code generated ... DO NOT
// EDIT." line, or an old cgo marker.
function isGenerated(pass: Pass<Config>, file: ast.File): boolean {
  let source: string;
  try {
    source = pass.readFile(pass.fset.position(file.pos()).filename);
  } catch {
    return false;
  }
  return source
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .some((line) => (line.startsWith("// Code generated ") && line.endsWith(" DO NOT EDIT.")) || line === "// Created by cgo - DO NOT EDIT");
}

// implementingSelections returns the methods by which a type with method set
// ms implements iface, or null if it does not.
function implementingSelections(t: types.Type, iface: types.Interface, ms: types.MethodSet): types.Selection[] | null {
  if (iface.empty()) {
    return [];
  }
  const ityp = t.underlying();
  if (ityp?.$type === "Interface") {
    for (let i = 0; i < iface.numMethods(); i++) {
      const m = iface.method(i)!;
      const obj = lookupInterfaceMethod(ityp, m.pkg(), m.name());
      if (obj === null || !types.identical(obj.type(), m.type())) {
        return null;
      }
    }
    return [];
  }
  const sels: types.Selection[] = [];
  const mapping = new Map<types.TypeParam, types.Type | null>();
  for (let i = 0; i < iface.numMethods(); i++) {
    const m = iface.method(i)!;
    const sel = ms.lookup(m.pkg(), m.name());
    const f = sel?.obj();
    if (!sel || f?.$type !== "Func" || !unify(f.type(), m.type(), mapping)) {
      return null;
    }
    sels.push(sel);
  }
  for (const [tparam, targ] of mapping) {
    if (targ !== null && !types.satisfies(targ, tparam.constraint()!.underlying() as types.Interface)) {
      return null;
    }
  }
  return sels;
}

function lookupInterfaceMethod(t: types.Interface, pkg: types.Package | null, name: string): types.Func | null {
  if (name === "_") {
    return null;
  }
  for (let i = 0; i < t.numMethods(); i++) {
    const m = t.method(i)!;
    if (m.name() !== name) {
      continue;
    }
    if (m.exported() || (pkg === null || m.pkg() === null ? pkg === m.pkg() : pkg.path() === m.pkg()!.path())) {
      return m;
    }
  }
  return null;
}

// unify reports whether two types unify, binding type parameters as needed,
// after staticcheck's typeutil.Unify.
function unify(x: types.Type | null, y: types.Type | null, unifier: Map<types.TypeParam, types.Type | null>): boolean {
  // Cells let unbound parameters that unify share one binding.
  const bindings = new Map<types.TypeParam, { t: types.Type | null }>();
  for (const [tp, t] of unifier) {
    bindings.set(tp, { t });
  }
  const bindingFor = (tp: types.TypeParam | null) => {
    if (tp === null) {
      return null;
    }
    let b = bindings.get(tp);
    if (b === undefined) {
      b = { t: null };
      bindings.set(tp, b);
    }
    return b;
  };
  const bind = (b: { t: types.Type | null }, t: types.Type | null) => {
    // The occurs check.
    if (typeParamsOf(t).some((tp) => bindings.get(tp) === b)) {
      return false;
    }
    b.t = t;
    return true;
  };
  let depth = 0;
  const uni = (x0: types.Type | null, y0: types.Type | null): boolean => {
    if (++depth > 100) {
      throw new Error("unify: max depth exceeded");
    }
    try {
      let x = types.unalias(x0);
      let y = types.unalias(y0);
      const tpx = x?.$type === "TypeParam" ? x : null;
      const tpy = y?.$type === "TypeParam" ? y : null;
      if (tpx !== null || tpy !== null) {
        if (tpx === tpy) {
          return true;
        }
        const bx = bindingFor(tpx);
        const by = bindingFor(tpy);
        if (bx !== null && by !== null && bx.t === null && by.t === null) {
          bindings.set(tpx!, by);
          return true;
        }
        if (bx !== null && bx.t !== null) {
          x = bx.t;
        }
        if (by !== null && by.t !== null) {
          y = by.t;
        }
        if (bx !== null && bx.t === null) {
          return bind(bx, y);
        }
        if (by !== null && by.t === null) {
          return bind(by, x);
        }
        return uni(x, y);
      }
      if (x === null || y === null || x.$type !== y.$type) {
        return false;
      }
      switch (x.$type) {
        case "Array": {
          const ya = y as types.Array;
          return x.len() === ya.len() && uni(x.elem(), ya.elem());
        }
        case "Basic":
          return x.kind() === (y as types.Basic).kind();
        case "Chan": {
          const yc = y as types.Chan;
          return x.dir() === yc.dir() && uni(x.elem(), yc.elem());
        }
        case "Interface":
          // Upstream only compares method counts.
          return x.numMethods() === (y as types.Interface).numMethods();
        case "Map": {
          const ym = y as types.Map;
          return uni(x.key(), ym.key()) && uni(x.elem(), ym.elem());
        }
        case "Named": {
          const yn = y as types.Named;
          if (x.origin() !== yn.origin()) {
            return false;
          }
          const xa = x.typeArgs();
          const ya = yn.typeArgs();
          const n = xa?.len() ?? 0;
          if (n !== (ya?.len() ?? 0)) {
            return false;
          }
          for (let i = 0; i < n; i++) {
            if (!uni(xa!.at(i), ya!.at(i))) {
              return false;
            }
          }
          return true;
        }
        case "Pointer":
          return uni(x.elem(), (y as types.Pointer).elem());
        case "Signature": {
          const ys = y as types.Signature;
          return x.variadic() === ys.variadic() && uniTuple(x.params(), ys.params()) && uniTuple(x.results(), ys.results());
        }
        case "Slice":
          return uni(x.elem(), (y as types.Slice).elem());
        case "Struct": {
          const yst = y as types.Struct;
          if (x.numFields() !== yst.numFields()) {
            return false;
          }
          for (let i = 0; i < x.numFields(); i++) {
            const xf = x.field(i)!;
            const yf = yst.field(i)!;
            if (
              xf.embedded() !== yf.embedded() ||
              xf.name() !== yf.name() ||
              x.tag(i) !== yst.tag(i) ||
              (!xf.exported() && xf.pkg() !== yf.pkg()) ||
              !uni(xf.type(), yf.type())
            ) {
              return false;
            }
          }
          return true;
        }
        case "Tuple":
          return uniTuple(x, y as types.Tuple);
        default:
          return false;
      }
    } finally {
      depth--;
    }
  };
  const uniTuple = (x: types.Tuple | null, y: types.Tuple | null): boolean => {
    const n = x?.len() ?? 0;
    if (n !== (y?.len() ?? 0)) {
      return false;
    }
    for (let i = 0; i < n; i++) {
      if (!uni(x!.at(i)!.type(), y!.at(i)!.type())) {
        return false;
      }
    }
    return true;
  };
  if (!uni(x, y)) {
    unifier.clear();
    return false;
  }
  for (const [tp, b] of bindings) {
    unifier.set(tp, b.t);
  }
  return true;
}

// typeParamsOf returns the type parameters occurring in a type.
function typeParamsOf(t: types.Type | null): types.TypeParam[] {
  const seen = new Set<types.TypeParam>();
  const visit = (t0: types.Type | null) => {
    const u = types.unalias(t0);
    switch (u?.$type) {
      case "TypeParam":
        seen.add(u);
        break;
      case "Array":
      case "Chan":
      case "Slice":
      case "Pointer":
        visit(u.elem());
        break;
      case "Map":
        visit(u.key());
        visit(u.elem());
        break;
      case "Named": {
        if (u.origin() === u) {
          const tps = u.typeParams();
          for (let i = 0; i < (tps?.len() ?? 0); i++) {
            visit(tps!.at(i));
          }
        } else {
          const args = u.typeArgs();
          for (let i = 0; i < (args?.len() ?? 0); i++) {
            visit(args!.at(i));
          }
        }
        break;
      }
      case "Signature":
        for (const tuple of [u.params(), u.results()]) {
          for (let i = 0; i < (tuple?.len() ?? 0); i++) {
            visit(tuple!.at(i)!.type());
          }
        }
        break;
      case "Struct":
        for (let i = 0; i < u.numFields(); i++) {
          visit(u.field(i)!.type());
        }
        break;
      case "Tuple":
        for (let i = 0; i < u.len(); i++) {
          visit(u.at(i)!.type());
        }
        break;
    }
  };
  visit(t);
  return [...seen];
}
