package single

type Single interface {
	Write([]byte) (int, error)
	Copy(string, string) // want `^interface method Copy must have named param for type string$` `^interface method Copy must have named param for type string$`
}
