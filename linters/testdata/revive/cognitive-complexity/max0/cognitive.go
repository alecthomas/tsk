// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package max0 tests cognitive-complexity with no complexity allowed.
package max0

import (
	"fmt"
	ast "go/ast"
	"log"
	"testing"
)

// Test IF and Boolean expr
func f(x int) bool { // want "^cognitive-complexity: function f has cognitive complexity 3 \\(> max enabled 0\\)$"
	if x > 0 && true || false { // +3
		return true
	} else {
		log.Printf("non-positive x: %d", x)
	}
	return false
}

// Test IF
func g(f func() bool) string { // want "^cognitive-complexity: function g has cognitive complexity 1 \\(> max enabled 0\\)$"
	if ok := f(); ok { // +1
		return "it's okay"
	} else {
		return "it's NOT okay!"
	}
}

// Test Boolean expr
func h(a, b, c, d, e, f bool) bool { // want "^cognitive-complexity: function h has cognitive complexity 3 \\(> max enabled 0\\)$"
	return a && b && c || d || e && f // +3
}

func i(a, b, c, d, e, f bool) bool { // want "^cognitive-complexity: function i has cognitive complexity 2 \\(> max enabled 0\\)$"
	result := a && b && c || d || e // +2
	return result
}

func z(b bool) bool { return b }

func j(a, b, c, d, e, f bool) bool { // want "^cognitive-complexity: function j has cognitive complexity 2 \\(> max enabled 0\\)$"
	result := z(a && !(b && c)) // +2
	return result
}

func j1(a bool, b int, c bool) bool { // want "^cognitive-complexity: function j1 has cognitive complexity 2 \\(> max enabled 0\\)$"
	return (a && !(b < 2) || c)
}

// Test Switch expr
func k(a, b, c, d bool) bool { // want "^cognitive-complexity: function k has cognitive complexity 1 \\(> max enabled 0\\)$"
	switch a { // +1
	case b:
	case c:
	default:
	}

	return d
}

// Test nesting FOR expr + nested IF
func l() int { // want "^cognitive-complexity: function l has cognitive complexity 6 \\(> max enabled 0\\)$"
	total, max := 0, 10
	for i := 1; i <= max; i++ { // +1
		for j := 2; j < i; j++ { // +1 +1(nesting)
			if i%j == 0 { // +1 +2(nesting)
				continue
			}
		}

		total += i
	}
	return total
}

// Test nesting IF
func m(i, j, max int) int { // want "^cognitive-complexity: function m has cognitive complexity 6 \\(> max enabled 0\\)$"
	total := 0
	if i <= max { // +1
		if j < i { // +1 +1(nesting)
			if i%j == 0 { // +1 +2(nesting)
				return 0
			}
		}

		total += i
	}
	return total
}

// Test nesting IF + nested FOR
func n(i, max int) int { // want "^cognitive-complexity: function n has cognitive complexity 6 \\(> max enabled 0\\)$"
	total := 0
	if i > max { // +1
		for j := 2; j < i; j++ { // +1 +1(nesting)
			if i%j == 0 { // +1 +2(nesting)
				continue
			}
		}

		total += i
	}
	return total
}

// Test nesting
func o(i, j, max, total int) { // want "^cognitive-complexity: function o has cognitive complexity 12 \\(> max enabled 0\\)$"
	if i > max { // +1
		if j < i { // +1 +1(nesting)
			if i%j == 0 { // +1 +2(nesting)
				return
			}
		}

		total += i
	}

	if i > max { // +1
		if j < i { // +1 +1(nesting)
			if i%j == 0 { // +1 +2(nesting)
				return
			}
		}

		total += i
	}
	_ = total
}

// Tests TYPE SWITCH
func p(n ast.Node) []ast.Node { // want "^cognitive-complexity: function p has cognitive complexity 1 \\(> max enabled 0\\)$"
	switch n := n.(type) { // +1
	case *ast.IfStmt:
		return []ast.Node{n.Cond, n.Body, n.Else}
	case *ast.ForStmt:
		return []ast.Node{n.Body}
	case *ast.TypeSwitchStmt:
		return []ast.Node{n.Body}
	}
	return nil
}

// Test RANGE
func q(v ast.Visitor, targets []ast.Node) { // want "^cognitive-complexity: function q has cognitive complexity 1 \\(> max enabled 0\\)$"
	for _, t := range targets { // +1
		ast.Walk(v, t)
	}
}

// Tests SELECT
func r(c chan int, quit chan struct{}) { // want "^cognitive-complexity: function r has cognitive complexity 1 \\(> max enabled 0\\)$"
	x, y := 0, 1
	select { // +1
	case c <- x:
		x, y = y, x+y
	case <-quit:
		fmt.Println("quit")
		return
	}
}

// Test jump to label
func s() { // want "^cognitive-complexity: function s has cognitive complexity 3 \\(> max enabled 0\\)$"
	for i := 0; i < 10; i++ { // +1
		break
	}
SecondLoop:
	for i := 0; i < 10; i++ { // +1
		break SecondLoop // +1
	}
}

func t() { // want "^cognitive-complexity: function t has cognitive complexity 2 \\(> max enabled 0\\)$"
FirstLoop:
	for i := 0; i < 10; i++ { // +1
		goto FirstLoop // +1
	}
}

func u() { // want "^cognitive-complexity: function u has cognitive complexity 3 \\(> max enabled 0\\)$"
	for i := 0; i < 10; i++ { // +1
		continue
	}
SecondLoop:
	for i := 0; i < 10; i++ { // +1
		continue SecondLoop // +1
	}
}

// Tests FUNC LITERAL
func v() { // want "^cognitive-complexity: function v has cognitive complexity 2 \\(> max enabled 0\\)$"
	myFunc := func(b bool) {
		if b { // +1 +1(nesting)

		}
	}
	_ = myFunc
}

func v2(t *testing.T) {
	t.Run("desc", func(t *testing.T) {})
}

func w() { // want "^cognitive-complexity: function w has cognitive complexity 3 \\(> max enabled 0\\)$"
	defer func(b bool) {
		if b { // +1 +1(nesting)

		}
	}(false || true) // +1
}

// Test from Cognitive Complexity white paper
func sumOfPrimes(max int) int { // want "^cognitive-complexity: function sumOfPrimes has cognitive complexity 7 \\(> max enabled 0\\)$"
	total := 0
OUT:
	for i := 1; i <= max; i++ { // +1
		for j := 2; j < i; j++ { // +1 +1(nesting)
			if i%j == 0 { // +1 +2(nesting)
				continue OUT // +1
			}
		}

		total += i
	}
	return total
}

type EtcdVersion struct{ Major, Minor int }

func (v *EtcdVersion) MajorMinorEquals(o *EtcdVersion) bool { return *v == *o }

type EtcdVersionPair struct {
	version        *EtcdVersion
	storageVersion string
}

const (
	storageEtcd2 = "etcd2"
	storageEtcd3 = "etcd3"
)

type versionFile struct{}

func (versionFile) Exists() (bool, error) { return false, nil }

func (versionFile) Read() (*EtcdVersionPair, error) { return nil, nil }

func (versionFile) Write(*EtcdVersionPair) error { return nil }

type dataDirectory struct {
	path        string
	versionFile versionFile
}

func (*dataDirectory) Initialize(*EtcdVersionPair) error { return nil }

type supportedVersions struct{}

func (supportedVersions) NextVersionPair(p *EtcdVersionPair) *EtcdVersionPair { return p }

type migratorConfig struct{ supportedVersions supportedVersions }

type Migrator struct {
	dataDirectory *dataDirectory
	cfg           *migratorConfig
}

func (*Migrator) minorVersionUpgrade(_, t *EtcdVersionPair) (*EtcdVersionPair, error) { return t, nil }

func (*Migrator) rollbackEtcd3MinorVersion(_, t *EtcdVersionPair) (*EtcdVersionPair, error) {
	return t, nil
}

// Test from K8S
func (m *Migrator) MigrateIfNeeded(target *EtcdVersionPair) error { // want "^cognitive-complexity: function \\(\\*Migrator\\).MigrateIfNeeded has cognitive complexity 18 \\(> max enabled 0\\)$"
	log.Printf("Starting migration to %v", target)
	err := m.dataDirectory.Initialize(target)
	if err != nil { // +1
		return fmt.Errorf("failed to initialize data directory %s: %v", m.dataDirectory.path, err)
	}

	var current *EtcdVersionPair
	vfExists, err := m.dataDirectory.versionFile.Exists()
	if err != nil { // +1
		return err
	}
	if vfExists { // +1
		current, err = m.dataDirectory.versionFile.Read()
		if err != nil { // +1 +1
			return err
		}
	} else {
		return fmt.Errorf("existing data directory '%s' is missing version.txt file, unable to migrate", m.dataDirectory.path)
	}

	for { // +1
		log.Printf("Converging current version '%v' to target version '%v'", current, target)
		currentNextMinorVersion := &EtcdVersion{}
		switch { // +1 +1
		case current.version.MajorMinorEquals(target.version) || currentNextMinorVersion.MajorMinorEquals(target.version): // +1
			log.Printf("current version '%v' equals or is one minor version previous of target version '%v' - migration complete", current, target)
			err = m.dataDirectory.versionFile.Write(target)
			if err != nil { // +1 +2
				return fmt.Errorf("failed to write version.txt to '%s': %v", m.dataDirectory.path, err)
			}
			return nil
		case current.storageVersion == storageEtcd2 && target.storageVersion == storageEtcd3: // +1
			return fmt.Errorf("upgrading from etcd2 storage to etcd3 storage is not supported")
		case current.version.Major == 3 && target.version.Major == 2: // +1
			return fmt.Errorf("downgrading from etcd 3.x to 2.x is not supported")
		case current.version.Major == target.version.Major && current.version.Minor < target.version.Minor: // +1
			stepVersion := m.cfg.supportedVersions.NextVersionPair(current)
			log.Printf("upgrading etcd from %v to %v", current, stepVersion)
			current, err = m.minorVersionUpgrade(current, stepVersion)
		case current.version.Major == 3 && target.version.Major == 3 && current.version.Minor > target.version.Minor: // +1
			log.Printf("rolling etcd back from %v to %v", current, target)
			current, err = m.rollbackEtcd3MinorVersion(current, target)
		}
		if err != nil { // +1 +1
			return err
		}
	}
}

type Tree struct {
	Left, Right *Tree
	Value       int
}

// Recursive functions
func Walk(t *Tree, ch chan int) { // want "^cognitive-complexity: function Walk has cognitive complexity 3 \\(> max enabled 0\\)$"
	if t == nil { // +1
		return
	}
	Walk(t.Left, ch) // +1
	ch <- t.Value
	Walk(t.Right, ch) // +1
}

func foo() {}
func bar() {}
func baz() {}
func qux() {}

// Test if-else if chains
func chainedIfElse(a, b, c, d bool) { // want "^cognitive-complexity: function chainedIfElse has cognitive complexity 4 \\(> max enabled 0\\)$"
	if a { // +1
		foo()
	} else if b && c { // +2
		bar()
	} else if d { // +1
		baz()
	} else {
		qux()
	}
}
