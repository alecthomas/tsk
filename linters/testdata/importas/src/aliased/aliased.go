package aliased

import (
	_ "embed"
	"encoding/json" // want `^import "encoding/json" imported without alias but must be with alias "encjson" according to config$`
	wrong "fmt"     // want `^import "fmt" imported as "wrong" but must be "fff" according to config$`
	extra "io"
	nethttp "net/http"
	neturl "net/url" // OK
	"os"             // want `^import "os" imported without alias but must be with alias "stdos" according to config$`
	. "strings"
)

func use() {
	_, _ = json.Marshal(nil)
	wrong.Println(ToUpper("x"))
	_, _ = extra.Pipe()
	_ = nethttp.StatusOK
	_, _ = neturl.Parse("")
	_ = os.Stdout
	wrong.Println(os.Args)
}
