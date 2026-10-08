package sorted

type Thing struct{}

func NewB() Thing { return Thing{} }

func NewA() Thing { return Thing{} } // want `^constructor "NewA" for struct "Thing" should be placed before constructor "NewB"$`

func (Thing) B() {}

func (Thing) A() {} // want `^method "A" for struct "Thing" should be placed before method "B"$`

func helper() {} // want `^unexported function "helper" should be placed after the exported function "Exported"$`

func init() {}

func Exported() {}
