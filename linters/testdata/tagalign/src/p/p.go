package p

type Aligned struct {
	Name  string `json:"name"     yaml:"name"`
	Email string `json:"email"    yaml:"email"`
	Phone string `json:"phone_no" yaml:"phone"`
}

type Unaligned struct {
	Name  string `json:"name" yaml:"name"`         // want "^tag is not aligned, should be: json:\"name\"  yaml:\"name\"$"
	Email string `yaml:"email" json:"email"`       // want "^tag is not aligned, should be: json:\"email\" yaml:\"email\"$"
}

type Single struct {
	Name string `yaml:"name" json:"name"` // want "^tag is not aligned , should be: json:\"name\" yaml:\"name\"$"
}

type Bad struct {
	Name string `json:name` // want "^bad syntax for struct tag value$"
}
