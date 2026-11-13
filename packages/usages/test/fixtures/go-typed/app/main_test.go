package main

import (
	"testing"

	"example.com/acme/shapes/canvas"
)

func TestReset(t *testing.T) {
	c := canvas.New()
	c.Reset()
	if c.Options().Scale != 1 {
		t.Fatal("scale")
	}
}
