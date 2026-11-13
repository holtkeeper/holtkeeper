// Command typedusages type-checks the packages of Go modules and prints, as JSON, the fields and
// methods their code reaches through values of types declared in other modules.
//
// Usage: typedusages -root DIR -C DIR [-gowork off|FILE] [-max N] [-timeout D] [patterns]
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

type listedModule struct {
	Path string
	Main bool
}

type listedPackage struct {
	ImportPath string
	Name       string
	Dir        string
	GoFiles    []string
	Export     string
	ImportMap  map[string]string
	Module     *listedModule
	Error      *struct{ Err string }
}

type site struct {
	File       string `json:"file"`
	Line       int    `json:"line"`
	Column     int    `json:"column"`
	ImportPath string `json:"importPath"`
	Export     string `json:"export"`
	Member     string `json:"member"`
	Kind       string `json:"kind"`
}

type result struct {
	Packages  int      `json:"packages"`
	Sites     []site   `json:"sites"`
	Truncated bool     `json:"truncated,omitempty"`
	Errors    []string `json:"errors,omitempty"`
}

const maxErrors = 20

func main() {
	root := flag.String("root", ".", "directory file paths are reported relative to")
	dir := flag.String("C", ".", "directory to run go list in")
	gowork := flag.String("gowork", "", "GOWORK for go list: off or a go.work file")
	maxSites := flag.Int("max", 100000, "most sites to report")
	timeout := flag.Duration("timeout", 5*time.Minute, "time limit")
	flag.Parse()
	patterns := flag.Args()
	if len(patterns) == 0 {
		patterns = []string{"./..."}
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	out, err := run(ctx, *root, *dir, *gowork, *maxSites, patterns)
	if err != nil {
		fmt.Fprintln(os.Stderr, "typedusages:", err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "typedusages:", err)
		os.Exit(1)
	}
}

func absolute(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real, nil
	}
	return abs, nil
}

func list(ctx context.Context, dir, gowork string, patterns []string) ([]*listedPackage, error) {
	args := []string{"list", "-e", "-export", "-deps", "-test",
		"-json=ImportPath,Name,Dir,GoFiles,Export,ImportMap,Module,Error"}
	if gowork == "off" && !strings.Contains(os.Getenv("GOFLAGS"), "-mod=") {
		args = append(args, "-mod=mod")
	}
	args = append(args, patterns...)
	cmd := exec.CommandContext(ctx, "go", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if gowork != "" {
		cmd.Env = append(cmd.Env, "GOWORK="+gowork)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var packages []*listedPackage
	decoder := json.NewDecoder(stdout)
	for {
		var pkg listedPackage
		if err := decoder.Decode(&pkg); err != nil {
			if !errors.Is(err, io.EOF) {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				return nil, fmt.Errorf("reading go list output: %w", err)
			}
			break
		}
		packages = append(packages, &pkg)
	}
	if err := cmd.Wait(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if len(message) > 2000 {
			message = message[len(message)-2000:]
		}
		return nil, fmt.Errorf("go list: %v: %s", err, message)
	}
	return packages, nil
}

func basePath(path string) string {
	if at := strings.Index(path, " ["); at >= 0 {
		return path[:at]
	}
	return path
}

type mappedImporter struct {
	base      types.ImporterFrom
	importMap map[string]string
}

func (m mappedImporter) Import(path string) (*types.Package, error) {
	return m.ImportFrom(path, "", 0)
}

func (m mappedImporter) ImportFrom(path, dir string, mode types.ImportMode) (*types.Package, error) {
	if mapped, ok := m.importMap[path]; ok {
		path = mapped
	}
	return m.base.ImportFrom(path, dir, mode)
}

func run(ctx context.Context, rootDir, dir, gowork string, max int, patterns []string) (*result, error) {
	root, err := absolute(rootDir)
	if err != nil {
		return nil, err
	}
	workDir, err := absolute(dir)
	if err != nil {
		return nil, err
	}
	if gowork != "" && gowork != "off" {
		if gowork, err = absolute(gowork); err != nil {
			return nil, err
		}
	}
	packages, err := list(ctx, workDir, gowork, patterns)
	if err != nil {
		return nil, err
	}

	exports := map[string]string{}
	modules := map[string]*listedModule{}
	variants := map[string]bool{}
	for _, pkg := range packages {
		if pkg.Export != "" {
			exports[pkg.ImportPath] = pkg.Export
		}
		if pkg.Module != nil {
			modules[basePath(pkg.ImportPath)] = pkg.Module
		}
		if pkg.ImportPath != basePath(pkg.ImportPath) {
			variants[basePath(pkg.ImportPath)] = true
		}
	}

	out := &result{Sites: []site{}}
	seen := map[string]bool{}
	report := func(message string) {
		if len(out.Errors) < maxErrors {
			out.Errors = append(out.Errors, message)
		}
	}
	for _, pkg := range packages {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if pkg.Module == nil || !pkg.Module.Main || strings.HasSuffix(pkg.ImportPath, ".test") {
			continue
		}
		if pkg.ImportPath == basePath(pkg.ImportPath) && variants[pkg.ImportPath] {
			continue
		}
		if pkg.Error != nil {
			message := strings.TrimSpace(pkg.Error.Err)
			if strings.HasPrefix(message, "#") {
				_, message, _ = strings.Cut(message, "\n")
			}
			report(fmt.Sprintf("%s: %s", basePath(pkg.ImportPath), strings.TrimSpace(message)))
		}
		out.Packages++
		if !check(pkg, root, exports, modules, max, seen, out, report) {
			out.Truncated = true
			break
		}
	}
	return out, nil
}

func check(
	pkg *listedPackage,
	root string,
	exports map[string]string,
	modules map[string]*listedModule,
	max int,
	seen map[string]bool,
	out *result,
	report func(string),
) bool {
	fset := token.NewFileSet()
	var files []*ast.File
	sources := map[*token.File][]byte{}
	paths := map[*token.File]string{}
	pkgDir, err := absolute(pkg.Dir)
	if err != nil {
		report(fmt.Sprintf("%s: %v", pkg.ImportPath, err))
		return true
	}
	for _, name := range pkg.GoFiles {
		path := name
		if !filepath.IsAbs(path) {
			path = filepath.Join(pkgDir, name)
		}
		relative, err := filepath.Rel(root, path)
		if err != nil || strings.HasPrefix(relative, "..") {
			continue
		}
		source, err := os.ReadFile(path)
		if err != nil {
			report(fmt.Sprintf("%s: %v", relative, err))
			continue
		}
		file, err := parser.ParseFile(fset, path, source, parser.SkipObjectResolution)
		if file == nil {
			report(fmt.Sprintf("%s: %v", relative, err))
			continue
		}
		tokenFile := fset.File(file.Pos())
		sources[tokenFile] = source
		paths[tokenFile] = filepath.ToSlash(relative)
		files = append(files, file)
	}
	if len(files) == 0 {
		return true
	}

	lookup := func(path string) (io.ReadCloser, error) {
		export, ok := exports[path]
		if !ok {
			return nil, fmt.Errorf("no export data for %s", path)
		}
		return os.Open(export)
	}
	base, _ := importer.ForCompiler(fset, "gc", lookup).(types.ImporterFrom)
	typeErrors := 0
	config := types.Config{
		Importer: mappedImporter{base: base, importMap: pkg.ImportMap},
		Error: func(err error) {
			if typeErrors == 0 {
				report(relativeError(err, root))
			}
			typeErrors++
		},
	}
	info := &types.Info{
		Selections: map[*ast.SelectorExpr]*types.Selection{},
		Uses:       map[*ast.Ident]types.Object{},
	}
	_, _ = config.Check(basePath(pkg.ImportPath), fset, files, info)

	external := func(object *types.TypeName) (string, bool) {
		if object.Pkg() == nil {
			return "", false
		}
		path := basePath(object.Pkg().Path())
		module, ok := modules[path]
		if !ok || module.Main {
			return "", false
		}
		return path, true
	}

	for _, file := range files {
		calls := map[ast.Expr]bool{}
		ast.Inspect(file, func(node ast.Node) bool {
			if call, ok := node.(*ast.CallExpr); ok {
				calls[ast.Unparen(call.Fun)] = true
			}
			return true
		})
		tokenFile := fset.File(file.Pos())
		source := sources[tokenFile]
		ok := true
		ast.Inspect(file, func(node ast.Node) bool {
			if !ok {
				return false
			}
			selector, isSelector := node.(*ast.SelectorExpr)
			if !isSelector {
				return true
			}
			selection := info.Selections[selector]
			if selection == nil || qualified(selector.X, info) {
				return true
			}
			owner := ownerOf(selection)
			if owner == nil {
				return true
			}
			importPath, isExternal := external(owner)
			if !isExternal {
				return true
			}
			position := fset.Position(selector.Sel.Pos())
			column := utf16Column(source, position.Offset, position.Column)
			key := fmt.Sprintf("%s:%d:%d", paths[tokenFile], position.Line, column)
			if seen[key] {
				return true
			}
			if len(out.Sites) >= max {
				ok = false
				return false
			}
			seen[key] = true
			kind := "member"
			if calls[selector] {
				kind = "call"
			}
			out.Sites = append(out.Sites, site{
				File:       paths[tokenFile],
				Line:       position.Line,
				Column:     column,
				ImportPath: importPath,
				Export:     owner.Name(),
				Member:     selection.Obj().Name(),
				Kind:       kind,
			})
			return true
		})
		if !ok {
			return false
		}
	}
	return true
}

func qualified(expr ast.Expr, info *types.Info) bool {
	for {
		switch node := expr.(type) {
		case *ast.SelectorExpr:
			expr = node.X
		case *ast.Ident:
			_, isPackage := info.Uses[node].(*types.PkgName)
			return isPackage
		default:
			return false
		}
	}
}

func namedOf(t types.Type) *types.TypeName {
	t = types.Unalias(t)
	if pointer, ok := t.(*types.Pointer); ok {
		t = types.Unalias(pointer.Elem())
	}
	named, ok := t.(*types.Named)
	if !ok {
		return nil
	}
	object := named.Origin().Obj()
	if !object.Exported() || object.Pkg() == nil {
		return nil
	}
	return object
}

func ownerOf(selection *types.Selection) *types.TypeName {
	current := selection.Recv()
	owner := namedOf(current)
	indices := selection.Index()
	for _, index := range indices[:len(indices)-1] {
		under := types.Unalias(current)
		if pointer, ok := under.(*types.Pointer); ok {
			under = pointer.Elem()
		}
		structure, ok := under.Underlying().(*types.Struct)
		if !ok || index >= structure.NumFields() {
			break
		}
		current = structure.Field(index).Type()
		if named := namedOf(current); named != nil {
			owner = named
		}
	}
	if function, ok := selection.Obj().(*types.Func); ok {
		if signature, ok := function.Type().(*types.Signature); ok && signature.Recv() != nil {
			if named := namedOf(signature.Recv().Type()); named != nil {
				owner = named
			}
		}
	}
	return owner
}

func utf16Column(source []byte, offset, column int) int {
	start := offset - (column - 1)
	if start < 0 || offset > len(source) {
		return column
	}
	units := 0
	for line := source[start:offset]; len(line) > 0; {
		r, size := utf8.DecodeRune(line)
		units += len(utf16.Encode([]rune{r}))
		line = line[size:]
	}
	return units + 1
}

func relativeError(err error, root string) string {
	typeError, ok := err.(types.Error)
	if !ok {
		return err.Error()
	}
	position := typeError.Fset.Position(typeError.Pos)
	if relative, err := filepath.Rel(root, position.Filename); err == nil {
		position.Filename = filepath.ToSlash(relative)
	}
	return fmt.Sprintf("%s: %s", position, typeError.Msg)
}
