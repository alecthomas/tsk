import * as token from "go/token";
import { defineAnalyzer } from "tsk";
import { buildssa } from "tsk/passes";

const httpRequest = "must not be called. use net/http.NewRequestWithContext and (*net/http.Client).Do(*http.Request)";
const clientDo = "must not be called. use (*net/http.Client).Do(*http.Request)";

// replacements maps functions without a context to the advice reported for
// calls to them.
const replacements = new Map<string, string>([
  ["net.Listen", "must not be called. use (*net.ListenConfig).Listen"],
  ["net.ListenPacket", "must not be called. use (*net.ListenConfig).ListenPacket"],
  ["net.Dial", "must not be called. use (*net.Dialer).DialContext"],
  ["net.DialTimeout", "must not be called. use (*net.Dialer).DialContext with (*net.Dialer).Timeout"],
  ["net.LookupCNAME", "must not be called. use (*net.Resolver).LookupCNAME with a context"],
  ["net.LookupHost", "must not be called. use (*net.Resolver).LookupHost with a context"],
  ["net.LookupIP", "must not be called. use (*net.Resolver).LookupIPAddr with a context"],
  ["net.LookupPort", "must not be called. use (*net.Resolver).LookupPort with a context"],
  ["net.LookupSRV", "must not be called. use (*net.Resolver).LookupSRV with a context"],
  ["net.LookupMX", "must not be called. use (*net.Resolver).LookupMX with a context"],
  ["net.LookupNS", "must not be called. use (*net.Resolver).LookupNS with a context"],
  ["net.LookupTXT", "must not be called. use (*net.Resolver).LookupTXT with a context"],
  ["net.LookupAddr", "must not be called. use (*net.Resolver).LookupAddr with a context"],

  ["net/http.Get", httpRequest],
  ["net/http.Head", httpRequest],
  ["net/http.Post", httpRequest],
  ["net/http.PostForm", httpRequest],
  ["(*net/http.Client).Get", clientDo],
  ["(*net/http.Client).Head", clientDo],
  ["(*net/http.Client).Post", clientDo],
  ["(*net/http.Client).PostForm", clientDo],
  ["net/http.NewRequest", "must not be called. use net/http.NewRequestWithContext"],
  ["net/http/httptest.NewRequest", "must not be called. use net/http/httptest.NewRequestWithContext"],

  ["(*database/sql.DB).Begin", "must not be called. use (*database/sql.DB).BeginTx"],
  ...["Exec", "Ping", "Prepare", "Query", "QueryRow"].map((name): [string, string] => [
    `(*database/sql.DB).${name}`,
    `must not be called. use (*database/sql.DB).${name}Context`,
  ]),
  ...["Exec", "Prepare", "Query", "QueryRow", "Stmt"].map((name): [string, string] => [
    `(*database/sql.Tx).${name}`,
    `must not be called. use (*database/sql.Tx).${name}Context`,
  ]),
  ...["Exec", "Query", "QueryRow"].map((name): [string, string] => [
    `(*database/sql.Stmt).${name}`,
    `must not be called. use (*database/sql.Conn).${name}Context`,
  ]),

  ["os/exec.Command", "must not be called. use os/exec.CommandContext"],

  ["crypto/tls.Dial", "must not be called. use (*crypto/tls.Dialer).DialContext"],
  ["crypto/tls.DialWithDialer", "must not be called. use (*crypto/tls.Dialer).DialContext with NetDialer"],
  ["(*crypto/tls.Conn).Handshake", "must not be called. use (*crypto/tls.Conn).HandshakeContext"],
]);

export default defineAnalyzer({
  name: "noctx",
  doc: "Detects function and method with missing usage of context.Context",
  requires: [buildssa],
  run(pass) {
    for (const fn of pass.resultOf(buildssa).srcFuncs) {
      for (const block of fn!.blocks) {
        for (const instr of block!.instrs) {
          if (instr?.$type !== "Call" && instr?.$type !== "Go" && instr?.$type !== "Defer") {
            continue;
          }
          // Upstream only knows functions from packages imported directly;
          // matching the callee's name also finds calls on values from
          // packages that are not.
          const callee = instr.call.staticCallee()?.object();
          const name = callee?.$type === "Func" ? callee.fullName() : "";
          const advice = replacements.get(name);
          if (advice !== undefined && instr.pos() !== token.NoPos) {
            pass.report({ pos: instr.pos(), message: `${name} ${advice}` });
          }
        }
      }
    }
  },
});
