// Adapted from github.com/manuelarte/funcorder's tests, MIT License.
package order

func NewEarly() *Thing { // want `^constructor "NewEarly" for struct "Thing" should be placed after the struct declaration$`
	return &Thing{}
}

type Thing struct{}

func NewThing() *Thing {
	return &Thing{}
}

func (t *Thing) private() {} // want `^unexported method "private" for struct "Thing" should be placed after the exported method "Public"$`

func (t *Thing) Public() {}

func MustThing() Thing { // want `^constructor "MustThing" for struct "Thing" should be placed before struct method "private"$`
	return Thing{}
}

// New alone is not a constructor.
func New() *Thing { return nil }

func helper() {}

func Exported() {}
