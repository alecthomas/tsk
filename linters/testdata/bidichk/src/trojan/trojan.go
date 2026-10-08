package trojan

import "fmt"

func override() {
	fmt.Println("é LEFT-TO-RIGHT-OVERRIDE: '‭'") // want "found dangerous unicode character sequence LEFT-TO-RIGHT-OVERRIDE"
}

func commentingOut() {
	isAdmin := false
	isSuperAdmin := false
	isAdmin = isAdmin || isSuperAdmin
	/*‮ } ⁦if (isAdmin)⁩ ⁦ begin admins only */ // want "found dangerous unicode character sequence LEFT-TO-RIGHT-ISOLATE" "found dangerous unicode character sequence RIGHT-TO-LEFT-OVERRIDE" "found dangerous unicode character sequence LEFT-TO-RIGHT-ISOLATE" "found dangerous unicode character sequence POP-DIRECTIONAL-ISOLATE"
	fmt.Println("You are an admin.")
	/* end admins only ‮ { ⁦*/ // want "found dangerous unicode character sequence LEFT-TO-RIGHT-ISOLATE" "found dangerous unicode character sequence RIGHT-TO-LEFT-OVERRIDE"
}
