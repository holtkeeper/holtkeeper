import { defineCase } from './build.ts'

const goMod = (version: string) => `module example.test/widgets

go ${version}
`

/** Go cases; `tests: false` ones also check that the missing-tests rule stays quiet. */
export const goCases = [
  defineCase({
    id: 'go-ignored-open-error',
    title: 'Error from os.Open dropped, then the file is used',
    merge: { title: 'Count lines', description: 'Adds a helper that counts the lines of a file.' },
    files: { 'go.mod': goMod('1.22') },
    changes: {
      'lines.go': {
        after: `package widgets

import (
	"bufio"
	"os"
)

// CountLines returns the number of lines in the file at path.
func CountLines(path string) (int, error) {
	f, _ := os.Open(path)
	defer f.Close()

	n := 0
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		n++
	}
	return n, scanner.Err()
}
`,
      },
    },
    tests: false,
    problems: [
      {
        id: 'ignored-error',
        path: 'lines.go',
        find: 'f, _ := os.Open(path)',
        note: 'A missing file gives a nil *os.File; Close and the scanner then fail on nil instead of returning the error.',
        minSeverity: 'major',
      },
    ],
  }),

  defineCase({
    id: 'go-defer-in-loop',
    title: 'defer inside a loop keeps every file open',
    merge: {
      title: 'Concatenate files',
      description: 'Reads many files and returns their total size.',
    },
    files: { 'go.mod': goMod('1.22') },
    changes: {
      'size.go': {
        after: `package widgets

import (
	"io"
	"os"
)

// TotalSize returns the combined size of the files at paths.
func TotalSize(paths []string) (int64, error) {
	var total int64
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			return 0, err
		}
		defer f.Close()

		n, err := io.Copy(io.Discard, f)
		if err != nil {
			return 0, err
		}
		total += n
	}
	return total, nil
}
`,
      },
    },
    tests: false,
    problems: [
      {
        id: 'defer-loop',
        path: 'size.go',
        find: 'defer f.Close()',
        note: 'Deferred closes run when the function returns, so all files stay open at once.',
        minSeverity: 'minor',
      },
    ],
  }),

  defineCase({
    id: 'go-concurrent-map',
    title: 'Goroutines write to one map without a lock',
    merge: {
      title: 'Parallel word count',
      description: 'Counts words of several texts in parallel.',
    },
    files: { 'go.mod': goMod('1.22') },
    changes: {
      'count.go': {
        after: `package widgets

import (
	"strings"
	"sync"
)

// CountWords returns how often each word occurs over all texts.
func CountWords(texts []string) map[string]int {
	counts := map[string]int{}
	var wg sync.WaitGroup
	for _, text := range texts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for _, word := range strings.Fields(text) {
				counts[word]++
			}
		}()
	}
	wg.Wait()
	return counts
}
`,
      },
    },
    tests: false,
    problems: [
      {
        id: 'data-race',
        path: 'count.go',
        find: 'counts[word]++',
        note: 'Concurrent writes to a map crash the program or lose counts; guard with a mutex or merge per-goroutine maps.',
        minSeverity: 'critical',
      },
    ],
  }),

  defineCase({
    id: 'go-old-loop-capture',
    title: 'Loop variable captured by a goroutine on a Go version that shares it',
    merge: {
      title: 'Process widgets in parallel',
      description: 'Runs `process` for every widget in its own goroutine.',
    },
    files: { 'go.mod': goMod('1.20') },
    changes: {
      'run.go': {
        after: `package widgets

import "sync"

type Widget struct{ ID int }

// ProcessAll calls process for every widget concurrently and waits for all of them.
func ProcessAll(widgets []Widget, process func(Widget)) {
	var wg sync.WaitGroup
	for _, w := range widgets {
		wg.Add(1)
		go func() {
			defer wg.Done()
			process(w)
		}()
	}
	wg.Wait()
}
`,
      },
    },
    tests: false,
    problems: [
      {
        id: 'capture',
        path: 'run.go',
        find: 'process(w)',
        note: 'go.mod says go 1.20, where w is one variable shared by all iterations: most goroutines see the last widget.',
        minSeverity: 'major',
      },
    ],
  }),

  defineCase({
    id: 'go-nil-map',
    title: 'Map field never initialized',
    merge: {
      title: 'Registry',
      description: 'Adds a registry that counts how often a key was added.',
    },
    files: { 'go.mod': goMod('1.22') },
    changes: {
      'registry.go': {
        after: `package widgets

// Registry counts keys.
type Registry struct {
	items map[string]int
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{}
}

// Add counts one more occurrence of key.
func (r *Registry) Add(key string) {
	r.items[key]++
}
`,
      },
    },
    tests: false,
    problems: [
      {
        id: 'nil-map',
        path: 'registry.go',
        find: `func NewRegistry() *Registry {
	return &Registry{}
}

// Add counts one more occurrence of key.
func (r *Registry) Add(key string) {
	r.items[key]++`,
        note: 'items is nil, so the first Add panics with an assignment to a nil map.',
        minSeverity: 'major',
      },
    ],
  }),
]
