package capital

// Capital checks sentences. second one is lower case. Third is fine, e.g. this. // want `^Sentence should start with a capital letter$` `^Comment should end in a period$`
const Capital = 1

// lower may start a declaration's doc.
const lower = 2

func f() {
	// all comments are checked in this scope // want `^Sentence should start with a capital letter$` `^Comment should end in a period$`
	_ = 1
}
