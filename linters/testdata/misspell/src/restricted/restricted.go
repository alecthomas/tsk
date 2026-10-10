package restricted

var s = "it recieves"

// A line whose comment has a misspelling is checked whole, code included.
var recieve = s /* adn */ // want "^`rec.eve` is a misspelling of `receive`$" "^`a.n` is a misspelling of `and`$"
