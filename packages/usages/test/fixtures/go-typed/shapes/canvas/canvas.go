package canvas

import "errors"

// Shape is anything with an area.
type Shape interface {
	Area() float64
}

// Options configure a Canvas.
type Options struct {
	Color string
	Scale float64
}

type history struct {
	steps int
}

// Reset forgets every drawn step.
func (h *history) Reset() { h.steps = 0 }

// Canvas collects shapes.
type Canvas struct {
	history
	Width  int
	opts   Options
	shapes []Shape
}

// New returns an empty Canvas.
func New() *Canvas { return &Canvas{opts: Options{Color: "black", Scale: 1}} }

// Draw adds a shape.
func (c *Canvas) Draw(s Shape) error {
	if s == nil {
		return errors.New("nil shape")
	}
	c.shapes = append(c.shapes, s)
	c.steps++
	return nil
}

// Options returns the current options.
func (c *Canvas) Options() Options { return c.opts }
