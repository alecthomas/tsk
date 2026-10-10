package extra

import (
	fff "fmt"
	stdio "io" // want `^import "io" has alias "stdio" which is not part of config$`
	"os"
)

func use() {
	fff.Println(os.Args)
	_, _ = stdio.Pipe()
}
