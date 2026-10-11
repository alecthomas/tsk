// Adapted from github.com/mgechev/revive's tests, MIT License.

package omit

import (
	"time"

	"example.com/revive/struct-tag/metav1"
)

type RangeAllocation struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Range             string `json:"range,outline"`
	Data              []byte `json:"data,flow"` // want `^unknown option "flow" in json tag$`
}

type RangeAllocation2 struct {
	metav1.TypeMeta   `bson:",minsize,gnu"`
	metav1.ObjectMeta `bson:"metadata,omitempty"`
	Range             string `bson:"range,flow"` // want `^unknown option "flow" in bson tag$`
	Data              []byte `bson:"data,inline"`
}

type RequestQueryOptions struct {
	Properties       []string `url:"properties,commmma,omitempty"` // want `^unknown option "commmma" in url tag$`
	CustomProperties []string `url:"-"`
	Archived         bool     `url:"archived,myURLOption"`
}

type Fields struct {
	Field      string `datastore:",noindex,flatten,omitempty,myDatastoreOption"`
	OtherField string `datastore:",unknownOption"` // want `^unknown option "unknownOption" in datastore tag$`
}

type MapStruct struct {
	Field1     string `mapstructure:",squash,reminder,omitempty,myMapstructureOption"`
	OtherField string `mapstructure:",unknownOption"` // want `^unknown option "unknownOption" in mapstructure tag$`
}

type ValidateUser struct {
	Username    string `validate:"required,min=3,max=32"`
	Email       string `validate:"required,email"`
	Password    string `validate:"required,min=8,max=32"`
	Biography   string `validate:"min=0,max=1000"`
	DisplayName string `validate:"displayName,min=3,max=32"`
	Complex     string `validate:"gt=0,dive,keys,eq=1|eq=2,endkeys,required"`
	BadComplex  string `validate:"gt=0,keys,eq=1|eq=2,endkeys,required"`
	BadComplex2 string `validate:"gt=0,dive,eq=1|eq=2,endkeys,required"`
	BadComplex3 string `validate:"gt=0,dive,keys,eq=1|eq=2,endkeys,endkeys,required"`
}

type TomlUser struct {
	Username string `toml:"username,omitempty"`
	Location string `toml:"location,unknown"`
}

type SpannerUserOptions struct {
	ID   int    `spanner:"user_id,mySpannerOption"`
	A    int    `spanner:"-,mySpannerOption"` // want `^useless option mySpannerOption for ignored field in spanner tag$`
	Name string `spanner:"full_name,unknownOption"` // want `^unknown option "unknownOption" in spanner tag$`
}

type uselessOptions struct {
	A  int       `bson:"-,"` // want `^unknown option "" in bson tag$`
	B  int       `bson:"-,omitempty"` // want `^useless option omitempty for ignored field in bson tag$`
	C  int       `bson:"-,omitempty,omitempty"` // want `^useless options omitempty,omitempty for ignored field in bson tag$`
	D  int       `datastore:"-,"` // want `^unknown option "" in datastore tag$`
	E  int       `datastore:"-,omitempty"` // want `^useless option omitempty for ignored field in datastore tag$`
	F  int       `datastore:"-,omitempty,omitempty"` // want `^useless options omitempty,omitempty for ignored field in datastore tag$`
	G  int       `json:"-,"`
	H  int       `json:"-,omitempty"` // want `^useless option omitempty for ignored field in json tag$`
	I  int       `json:"-,omitempty,omitempty"` // want `^useless options omitempty,omitempty for ignored field in json tag$`
	J  int       `mapstructure:"-,"` // want `^unknown option "" in mapstructure tag$`
	K  int       `mapstructure:"-,squash"` // want `^useless option squash for ignored field in mapstructure tag$`
	L  int       `mapstructure:"-,omitempty,omitempty"` // want `^useless options omitempty,omitempty for ignored field in mapstructure tag$`
	M  int       `properties:"-,"` // want `^unknown or malformed option "" in properties tag$`
	N  int       `properties:"-,default=15"` // want `^useless option default=15 for ignored field in properties tag$`
	O  time.Time `properties:"-,layout=2006-01-02,default=2006-01-02"` // want `^useless options layout=2006-01-02,default=2006-01-02 for ignored field in properties tag$`
	P  int       `spanner:"-,"` // want `^unknown option "" in spanner tag$`
	Q  int       `spanner:"-,mySpannerOption"` // want `^useless option mySpannerOption for ignored field in spanner tag$`
	R  int       `spanner:"-,mySpannerOption,mySpannerOption"` // want `^useless options mySpannerOption,mySpannerOption for ignored field in spanner tag$`
	S  int       `toml:"-,"`
	T  int       `toml:"-,omitempty"`
	U  int       `toml:"-,omitempty,omitempty"`
	V  int       `url:"-,"` // want `^unknown option "" in url tag$`
	W  int       `url:"-,omitempty"` // want `^useless option omitempty for ignored field in url tag$`
	X  int       `url:"-,omitempty,omitempty"` // want `^useless options omitempty,omitempty for ignored field in url tag$`
	Y  int       `xml:"-,"` // want `^unknown option "" in xml tag$`
	Z  int       `xml:"-,omitempty"` // want `^useless option omitempty for ignored field in xml tag$`
	Aa int       `xml:"-,omitempty,omitempty"` // want `^useless options omitempty,omitempty for ignored field in xml tag$`
	Ba int       `yaml:"-,"` // want `^unknown option "" in yaml tag$`
	Ca int       `yaml:"-,omitempty"` // want `^useless option omitempty for ignored field in yaml tag$`
	Da int       `yaml:"-,omitempty,omitempty"` // want `^useless options omitempty,omitempty for ignored field in yaml tag$`

}
