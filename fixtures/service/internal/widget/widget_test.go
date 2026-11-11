package widget

import "testing"

func TestName(t *testing.T) {
	if got := Name(3); got != "widget-3" {
		t.Fatalf("Name(3) = %q", got)
	}
}
