package widget

import "fmt"

// Name returns the display name of widget n.
func Name(n int) string {
	return fmt.Sprintf("widget-%d", n)
}
