// Adapted from github.com/mgechev/revive's tests, MIT License.
package results

func getfoo() (int, int, error) { // want "^confusing-results: unnamed results of the same type may be confusing, consider using named results$"
	return 0, 0, nil
}

func getBar(a, b int) (int, error, int) {
	return 0, nil, 0
}

func Getbaz(a string, b int) (int, float32, string, string) { // want "^confusing-results: unnamed results of the same type may be confusing, consider using named results$"
	return 0, 0, "", ""
}

func GetTaz(a string, b int) string {
	return ""
}

type t struct{}

func (t *t) GetTaz(a int, b int) {

}

func namedResults() (a string, b string) {
	return "nil", "nil"
}

func pointerResults() (*string, *string) { // want "^confusing-results: unnamed results of the same type may be confusing, consider using named results$"
	return nil, nil
}

func multiline() (
	int,
	int, // want "^confusing-results: unnamed results of the same type may be confusing, consider using named results$"
) {
	return 0, 0
}
