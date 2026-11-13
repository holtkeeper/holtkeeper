package render_test

import (
	"testing"

	"example.com/acme/app/render"
	"example.com/acme/shapes/canvas"
)

func TestFrame(t *testing.T) {
	c := canvas.New()
	c.Width = 7
	if render.Frame(c) != "7" {
		t.Fatal(c.Options().Color)
	}
}
