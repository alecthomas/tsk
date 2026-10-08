// Package library resolves linter library imports to git commits, and caches
// each library's scripts at a pinned commit.
package library

import (
	"strings"

	"github.com/alecthomas/errors"
	. "github.com/alecthomas/types/optional"
)

// Import names a library: a repository, the version it asks for, and the
// library's directory within it, written "<repository>[@<version>][//<dir>]".
type Import struct {
	// Repository is fetched from https://<Repository>.
	Repository string
	// Version is a tag, branch, or commit. Absent asks for the latest.
	Version Option[string]
	// Dir is the library's directory, or empty for the repository's root.
	Dir string
}

// ParseImport parses "<repository>[@<version>][//<dir>]". Git refs cannot
// contain "//", so a version is never mistaken for the directory.
func ParseImport(text string) (Import, error) {
	rest, dir, hasDir := strings.Cut(text, "//")
	repository, version, hasVersion := strings.Cut(rest, "@")
	if err := checkRepository(repository); err != nil {
		return Import{}, errors.Wrapf(err, "import %s", text)
	}
	if hasDir {
		if err := checkDir(dir); err != nil {
			return Import{}, errors.Wrapf(err, "import %s", text)
		}
	}
	imported := Import{Repository: repository, Version: None[string](), Dir: dir}
	if hasVersion {
		if err := checkVersion(version); err != nil {
			return Import{}, errors.Wrapf(err, "import %s", text)
		}
		imported.Version = Some(version)
	}
	return imported, nil
}

// Path returns the library's import path, the repository joined with its
// directory, which names its scripts.
func (i Import) Path() string {
	return joinPath(i.Repository, i.Dir)
}

// String formats the import as ParseImport parses it.
func (i Import) String() string {
	text := i.Repository
	if version, ok := i.Version.Get(); ok {
		text += "@" + version
	}
	if i.Dir != "" {
		text += "//" + i.Dir
	}
	return text
}

// MarshalText implements encoding.TextMarshaler.
func (i Import) MarshalText() ([]byte, error) {
	return []byte(i.String()), nil
}

// UnmarshalText implements encoding.TextUnmarshaler.
func (i *Import) UnmarshalText(text []byte) error {
	parsed, err := ParseImport(string(text))
	if err != nil {
		return err
	}
	*i = parsed
	return nil
}

func joinPath(repository, dir string) string {
	if dir == "" {
		return repository
	}
	return repository + "/" + dir
}

func checkRepository(repository string) error {
	elements := strings.Split(repository, "/")
	if len(elements) < 2 || !strings.Contains(elements[0], ".") {
		return errors.Errorf("repository %q must be a host name followed by a path", repository)
	}
	return checkElements(repository)
}

func checkDir(dir string) error {
	if dir == "" {
		return errors.New("empty directory after \"//\"")
	}
	return checkElements(dir)
}

// checkElements accepts the characters Go allows in module paths. A leading
// "-" or "." is rejected so no element can be read as a git option or be ".".
func checkElements(path string) error {
	for element := range strings.SplitSeq(path, "/") {
		if element == "" {
			return errors.Errorf("%q has an empty path element", path)
		}
		if element[0] == '-' || element[0] == '.' {
			return errors.Errorf("path element %q cannot start with %q", element, element[0])
		}
		for _, r := range element {
			if !isAlphanumeric(r) && !strings.ContainsRune("-._~", r) {
				return errors.Errorf("path element %q contains %q", element, r)
			}
		}
	}
	return nil
}

// checkVersion accepts the characters of tags, branches, and commits. A
// leading "-" is rejected so a version cannot be read as a git option.
func checkVersion(version string) error {
	switch {
	case version == "":
		return errors.New("empty version")
	case version[0] == '-':
		return errors.Errorf("version %q cannot start with \"-\"", version)
	case strings.Contains(version, ".."):
		return errors.Errorf("version %q cannot contain \"..\"", version)
	}
	for _, r := range version {
		if !isAlphanumeric(r) && !strings.ContainsRune("-._+/", r) {
			return errors.Errorf("version %q contains %q", version, r)
		}
	}
	return nil
}

func isAlphanumeric(r rune) bool {
	return ('a' <= r && r <= 'z') || ('A' <= r && r <= 'Z') || ('0' <= r && r <= '9')
}

// CheckImports reports a library imported twice, or one nested inside
// another, whose scripts would both define the same modules.
func CheckImports(imports []Import) error {
	for i, a := range imports {
		for _, b := range imports[i+1:] {
			switch {
			case a.Path() == b.Path():
				return errors.Errorf("%s is imported twice", a.Path())
			case strings.HasPrefix(b.Path(), a.Path()+"/"), strings.HasPrefix(a.Path(), b.Path()+"/"):
				return errors.Errorf("imports %s and %s overlap; import only one of them", a, b)
			}
		}
	}
	return nil
}

// escape writes each uppercase letter as "!" and the lowercase letter, as Go's
// module cache does, so paths differing only in case stay apart on
// case-insensitive file systems. Paths are ASCII, as checkElements ensures.
func escape(path string) string {
	var escaped strings.Builder
	for _, r := range path {
		if 'A' <= r && r <= 'Z' {
			escaped.WriteByte('!')
			r += 'a' - 'A'
		}
		escaped.WriteRune(r)
	}
	return escaped.String()
}
