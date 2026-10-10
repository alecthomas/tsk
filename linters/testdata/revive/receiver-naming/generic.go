// Adapted from github.com/mgechev/revive's tests, MIT License.

package foo

type gen1[T any] struct{}

func (g gen1[T]) f1() {}

func (g gen1[U]) f2() {}

func (n gen1[T]) f3() {} // want "^receiver-naming: receiver name n should be consistent with previous receiver name g for gen1$"

func (n gen1[U]) f4() {} // want "^receiver-naming: receiver name n should be consistent with previous receiver name g for gen1$"

func (n gen1[V]) f5() {} // want "^receiver-naming: receiver name n should be consistent with previous receiver name g for gen1$"

func (n *gen1[T]) f6() {} // want "^receiver-naming: receiver name n should be consistent with previous receiver name g for gen1$"

func (n *gen1[U]) f7() {} // want "^receiver-naming: receiver name n should be consistent with previous receiver name g for gen1$"

func (n *gen1[V]) f8() {} // want "^receiver-naming: receiver name n should be consistent with previous receiver name g for gen1$"

type gen2[T1, T2 any] struct{}

func (g gen2[T1, T2]) f1() {}

func (g gen2[U1, U2]) f2() {}

func (n gen2[T1, T2]) f3() {} // want "^receiver-naming: receiver name n should be consistent with previous receiver name g for gen2$"

func (n gen2[U1, U2]) f4() {} // want "^receiver-naming: receiver name n should be consistent with previous receiver name g for gen2$"

func (n gen2[V1, V2]) f5() {} // want "^receiver-naming: receiver name n should be consistent with previous receiver name g for gen2$"

func (n *gen2[T1, T2]) f6() {} // want "^receiver-naming: receiver name n should be consistent with previous receiver name g for gen2$"

func (n *gen2[U1, U2]) f7() {} // want "^receiver-naming: receiver name n should be consistent with previous receiver name g for gen2$"

func (n *gen2[V1, V2]) f8() {} // want "^receiver-naming: receiver name n should be consistent with previous receiver name g for gen2$"
