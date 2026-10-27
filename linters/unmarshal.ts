// Port of golang.org/x/tools/go/analysis/passes/unmarshal at v0.50.0.
import * as ast from "go/ast";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import { receiverNamed } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "unmarshal",
  doc: `report passing non-pointer or non-interface values to unmarshal

The unmarshal analysis reports calls to functions such as json.Unmarshal
in which the argument type is not a pointer or an interface.`,
  group: "govet",
  requires: [inspect],
  run(pass) {
    switch (pass.pkg.path()) {
      case "encoding/gob":
      case "encoding/json":
      case "encoding/xml":
      case "encoding/asn1":
        // These packages know how to use their own APIs, and test misuse.
        return;
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      const fn = typeutil.staticCallee(pass.typesInfo, call);
      if (fn === null) {
        continue;
      }
      let argidx = -1;
      const recv = fn.signature()!.recv();
      if (fn.name() === "Unmarshal" && recv === null) {
        switch (fn.pkg()!.path()) {
          case "encoding/json":
          case "encoding/xml":
          case "encoding/asn1":
            argidx = 1;
        }
      } else if (fn.name() === "Decode" && recv !== null) {
        const tname = receiverNamed(recv).named?.obj();
        if (tname?.name() === "Decoder") {
          switch (tname.pkg()!.path()) {
            case "encoding/json":
            case "encoding/xml":
            case "encoding/gob":
              argidx = 0;
          }
        }
      }
      // Too few arguments happens when they are another call's results.
      if (argidx < 0 || call.args.length < argidx + 1) {
        continue;
      }
      const t = pass.typesInfo.types.get(call.args[argidx]!)!.type!;
      const u = t.underlying()?.$type;
      if (u === "Pointer" || u === "Interface" || u === "TypeParam") {
        continue;
      }
      const message = argidx === 0 ? `call of ${fn.name()} passes non-pointer` : `call of ${fn.name()} passes non-pointer as second argument`;
      pass.report({ pos: call.lparen, message });
    }
  },
});
