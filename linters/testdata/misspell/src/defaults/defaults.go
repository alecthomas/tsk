package defaults

/* We recieve it. */ // want "^`rec.eve` is a misspelling of `receive`$"

/* Definately, DEFINATELY. */ // want "^`Defin.tely` is a misspelling of `Definitely`$" "^`DEFIN.TELY` is a misspelling of `DEFINITELY`$"

/* See https://example.com/recieve, /usr/recieve/path, and me@recieve.com. */

var s = "it recieves" // want "^`rec.eves` is a misspelling of `receives`$"

// Lower-case identifiers are words too; mixed-case ones are skipped.
var recieve, recieveCount = s, s // want "^`rec.eve` is a misspelling of `receive`$"

/* The colour and the color. */
