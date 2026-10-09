# Linters

This library holds linters written for `tsk` and ports of golangci-lint's
linters. Add it to a project with `tsk get github.com/alecthomas/tsk//linters`.
Every linter runs once the library is imported; turn off the ones you do not
want with `disable` in `.tsk/config.toml`. `tsk config` documents each
linter's options.

## Original linters

| Linter | Reports |
|---|---|
| `encapsulation` | Private-field access and construction outside a struct's API. |
| `optionalnil` | `nil` used to mean "no value" where an option type could be used. |
| `sumtype` | Type switches on sealed interfaces that miss a variant. |

## Ports

Each port reproduces its upstream linter as golangci-lint v2.14.0 runs it, with
the same options and defaults. The version is the one ported. The license is
upstream's; each port is a translation of that code.

| Linter | Upstream | Version | License |
|---|---|---|---|
| `asasalint` | [alingse/asasalint](https://github.com/alingse/asasalint) | v0.0.11 | MIT |
| `asciicheck` | [golangci/asciicheck](https://github.com/golangci/asciicheck) | v0.5.0 | MIT |
| `bidichk` | [breml/bidichk](https://github.com/breml/bidichk) | v0.3.3 | MIT |
| `bodyclose` | [timakin/bodyclose](https://github.com/timakin/bodyclose) | 857993a2939c | MIT |
| `canonicalheader` | [golangci/canonicalheader](https://github.com/golangci/canonicalheader) | a25c71c521f6 | MIT |
| `copyloopvar` | [karamaru-alpha/copyloopvar](https://github.com/karamaru-alpha/copyloopvar) | v1.2.2 | MIT |
| `cyclop` | [bkielbasa/cyclop](https://github.com/bkielbasa/cyclop) | v1.2.3 | MIT |
| `decorder` | [bosi/decorder](https://gitlab.com/bosi/decorder) | v0.4.2 | MIT |
| `dupl` | [golangci/dupl](https://github.com/golangci/dupl) | c99c5cf5c202 | MIT |
| `durationcheck` | [charithe/durationcheck](https://github.com/charithe/durationcheck) | v0.0.11 | Apache-2.0 |
| `embeddedstructfieldcheck` | [manuelarte/embeddedstructfieldcheck](https://github.com/manuelarte/embeddedstructfieldcheck) | v0.4.0 | Apache-2.0 |
| `errcheck` | [kisielk/errcheck](https://github.com/kisielk/errcheck) | v1.20.0 | MIT |
| `errname` | [Antonboom/errname](https://github.com/Antonboom/errname) | v1.1.2 | MIT |
| `errorlint` | [polyfloyd/go-errorlint](https://codeberg.org/polyfloyd/go-errorlint) | v1.9.0 | MIT |
| `exhaustive` | [nishanths/exhaustive](https://github.com/nishanths/exhaustive) | v0.13.0 | BSD-2-Clause |
| `exhaustruct` | [GaijinEntertainment/go-exhaustruct](https://github.com/GaijinEntertainment/go-exhaustruct) | v5.2.0 | MIT |
| `exptostd` | [ldez/exptostd](https://github.com/ldez/exptostd) | v0.4.5 | Apache-2.0 |
| `fatcontext` | [Crocmagnon/fatcontext](https://github.com/Crocmagnon/fatcontext) | v0.10.1 | MIT |
| `forbidigo` | [ashanbrown/forbidigo](https://github.com/ashanbrown/forbidigo) | v2.3.1 | Apache-2.0 |
| `funcorder` | [manuelarte/funcorder](https://github.com/manuelarte/funcorder) | v0.6.0 | Apache-2.0 |
| `funlen` | [ultraware/funlen](https://github.com/ultraware/funlen) | v0.2.0 | MIT |
| `gocheckcompilerdirectives` | [leighmcculloch/gocheckcompilerdirectives](https://github.com/leighmcculloch/gocheckcompilerdirectives) | v1.4.0 | MIT |
| `gochecknoglobals` | [leighmcculloch/gochecknoglobals](https://github.com/leighmcculloch/gochecknoglobals) | v0.2.2 | MIT |
| `goconst` | [jgautheron/goconst](https://github.com/jgautheron/goconst) | v1.11.0 | MIT |
| `godoclint` | [godoc-lint/godoc-lint](https://github.com/godoc-lint/godoc-lint) | v0.11.4 | MIT |
| `godot` | [tetafro/godot](https://github.com/tetafro/godot) | v1.5.6 | MIT |
| `godox` | [matoous/godox](https://github.com/matoous/godox) | v1.1.0 | MIT |
| `gomoddirectives` | [ldez/gomoddirectives](https://github.com/ldez/gomoddirectives) | v0.10.0 | Apache-2.0 |
| `goprintffuncname` | [golangci/go-printf-func-name](https://github.com/golangci/go-printf-func-name) | v0.1.1 | MIT |
| `iface` | [uudashr/iface](https://github.com/uudashr/iface) | v1.5.1 | Apache-2.0 |
| `inamedparam` | [macabu/inamedparam](https://github.com/macabu/inamedparam) | v0.2.0 | MIT |
| `ineffassign` | [gordonklaus/ineffassign](https://github.com/gordonklaus/ineffassign) | v0.2.0 | MIT |
| `interfacebloat` | [sashamelentyev/interfacebloat](https://github.com/sashamelentyev/interfacebloat) | v1.1.0 | MIT |
| `intrange` | [ckaznocha/intrange](https://github.com/ckaznocha/intrange) | v0.3.1 | MIT |
| `iotamixing` | [AdminBenni/iota-mixing](https://github.com/AdminBenni/iota-mixing) | v1.0.0 | MIT |
| `ireturn` | [butuzov/ireturn](https://github.com/butuzov/ireturn) | v0.4.1 | MIT |
| `loggercheck` | [timonwong/loggercheck](https://github.com/timonwong/loggercheck) | v0.12.0 | MIT |
| `makezero` | [ashanbrown/makezero](https://github.com/ashanbrown/makezero) | v2.2.1 | Apache-2.0 |
| `mirror` | [butuzov/mirror](https://github.com/butuzov/mirror) | v1.3.3 | MIT |
| `nakedret` | [alexkohler/nakedret](https://github.com/alexkohler/nakedret) | v2.0.6 | MIT |
| `nilerr` | [gostaticanalysis/nilerr](https://github.com/gostaticanalysis/nilerr) | v0.1.2 | MIT |
| `nilnesserr` | [alingse/nilnesserr](https://github.com/alingse/nilnesserr) | v0.2.0 | MIT |
| `nilnil` | [Antonboom/nilnil](https://github.com/Antonboom/nilnil) | v1.1.2 | MIT |
| `noctx` | [sonatard/noctx](https://github.com/sonatard/noctx) | v0.5.1 | MIT |
| `nosprintfhostport` | [stbenjam/no-sprintf-host-port](https://github.com/stbenjam/no-sprintf-host-port) | v0.3.1 | MIT |
| `perfsprint` | [catenacyber/perfsprint](https://github.com/catenacyber/perfsprint) | v0.10.1 | MIT |
| `predeclared` | [nishanths/predeclared](https://github.com/nishanths/predeclared) | v0.2.2 | BSD-3-Clause |
| `promlinter` | [yeya24/promlinter](https://github.com/yeya24/promlinter) | v0.3.0 | Apache-2.0 |
| `protogetter` | [ghostiam/protogetter](https://github.com/ghostiam/protogetter) | v1.0.1 | MIT |
| `reassign` | [curioswitch/go-reassign](https://github.com/curioswitch/go-reassign) | v0.3.0 | MIT |
| `recvcheck` | [raeperd/recvcheck](https://github.com/raeperd/recvcheck) | v0.3.1 | MIT |
| `rowserrcheck` | [golangci/rowserrcheck](https://github.com/golangci/rowserrcheck) | c5f79b8a11ba | MIT |
| `spancheck` | [jjti/go-spancheck](https://github.com/jjti/go-spancheck) | v0.6.5 | MIT |
| `sqlclosecheck` | [ryanrolds/sqlclosecheck](https://github.com/ryanrolds/sqlclosecheck) | v0.6.0 | MIT |
| `testableexamples` | [maratori/testableexamples](https://github.com/maratori/testableexamples) | v1.0.1 | MIT |
| `testifylint` | [Antonboom/testifylint](https://github.com/Antonboom/testifylint) | v1.6.4 | MIT |
| `testpackage` | [maratori/testpackage](https://github.com/maratori/testpackage) | v1.1.2 | MIT |
| `tparallel` | [moricho/tparallel](https://github.com/moricho/tparallel) | v0.3.2 | MIT |
| `unconvert` | [golangci/unconvert](https://github.com/golangci/unconvert) | a129a6e6413e | BSD-3-Clause |
| `unparam` | [mvdan/unparam](https://github.com/mvdan/unparam) | 2fa3d841b0c8 | BSD-3-Clause |
| `unused` | [dominikh/go-tools](https://github.com/dominikh/go-tools) | v0.8.1 | MIT |
| `usestdlibvars` | [sashamelentyev/usestdlibvars](https://github.com/sashamelentyev/usestdlibvars) | v1.29.0 | MIT |
| `usetesting` | [ldez/usetesting](https://github.com/ldez/usetesting) | v0.5.0 | Apache-2.0 |
| `wastedassign` | [sanposhiho/wastedassign](https://github.com/sanposhiho/wastedassign) | v2.1.0 | MIT |
| `whitespace` | [ultraware/whitespace](https://github.com/ultraware/whitespace) | v0.2.0 | MIT |
| `wrapcheck` | [tomarrell/wrapcheck](https://github.com/tomarrell/wrapcheck) | v2.12.0 | MIT |
