//go:build go1.21

package versions

func Bad(l []int) {
  for i, v := range l {
    go func() {
      print(i) // want "loop variable i captured by func literal"
      print(v) // want "loop variable v captured by func literal"
    }()
  }
}
