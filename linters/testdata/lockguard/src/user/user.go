package user

import "dep"

func Read(s *dep.Shared) int {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	return s.Value
}

func Write(s *dep.Shared) {
	s.Value = 1 // want `^"Shared.Value" written without locking "Shared.Mu"$`
}
