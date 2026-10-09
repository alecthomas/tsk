package strict

type T struct {
	Name  string `json:"name" yaml:"name"`   // want "^tag is not aligned, should be: json:\"name\" {9}yaml:\"name\"$"
	Email string `xml:"" json:"email"`       // want "^tag is not aligned, should be: json:\"email\" xml:\"\"$"
}
