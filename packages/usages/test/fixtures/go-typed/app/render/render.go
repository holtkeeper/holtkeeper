package render

import (
	"fmt"

	"example.com/acme/shapes/canvas"
)

// Frame describes a canvas.
func Frame(c *canvas.Canvas) string {
	var s canvas.Shape
	_ = s
	return fmt.Sprint(c.Width)
}
