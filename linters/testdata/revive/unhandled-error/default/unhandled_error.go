// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

import (
	"bytes"
	"fmt"
	fmt2 "fmt"
	"os"
	"strings"
)

func unhandledError1(a int) (int, error) {
	return a, nil
}

func unhandledError2() error {
	_, err := unhandledError1(1)
	unhandledError1(1)   // want `^unhandled-error: Unhandled error in call to function unhandledError1$`
	fmt.Fprintf(nil, "") // want `^unhandled-error: Unhandled error in call to function fmt\.Fprintf$`

	var sb strings.Builder
	fmt.Fprintf(&sb, "formatted string: %v", 1)

	var bb bytes.Buffer
	fmt2.Fprintf(&bb, "formatted string: %v", 1)

	fmt.Fprintf(os.Stdout, "") // want `^unhandled-error: Unhandled error in call to function fmt\.Fprintf$`
	os.Chdir("..")             // want `^unhandled-error: Unhandled error in call to function os\.Chdir$`
	_ = os.Chdir("..")
	func() error { return nil }() // want `^unhandled-error: Unhandled error in call to function func\(\) error \{\n\treturn nil\n\}$`
	return err
}
