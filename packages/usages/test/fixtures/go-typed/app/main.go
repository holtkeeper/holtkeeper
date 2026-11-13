package main

import (
	"fmt"

	"example.com/acme/app/render"
	"example.com/acme/shapes/canvas"
)

type square struct{ side float64 }

func (s square) Area() float64 { return s.side * s.side }

func main() {
	c := canvas.New()
	c.Width = 3
	if err := c.Draw(square{2}); err != nil {
		fmt.Println(err)
	}
	opts := c.Options()
	fmt.Println("ünïcode", opts.Color, render.Frame(c))
}
