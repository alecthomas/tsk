package generatedconsumer

import "example/generated"

func use() {
	_ = &generated.Message{Name: "consumer"}
	_ = new(generated.Message)
	_ = generated.Local{} // want "encapsulated struct example/generated.Local may only be constructed"
}
