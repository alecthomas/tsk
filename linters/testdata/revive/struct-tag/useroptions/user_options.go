// Adapted from github.com/mgechev/revive's tests, MIT License.

package useroptions

import (
	"time"

	"example.com/revive/struct-tag/metav1"
)

type RangeAllocation struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Range             string `json:"range,outline"`
	Data              []byte `json:"data,flow"` // want `^struct-tag: unknown option "flow" in json tag$`
}

type RangeAllocation2 struct {
	metav1.TypeMeta   `bson:",minsize,gnu"`
	metav1.ObjectMeta `bson:"metadata,omitempty"`
	Range             string `bson:"range,flow"` // want `^struct-tag: unknown option "flow" in bson tag$`
	Data              []byte `bson:"data,inline"`
}

type RequestQueryOptions struct {
	Properties       []string `url:"properties,commmma,omitempty"` // want `^struct-tag: unknown option "commmma" in url tag$`
	CustomProperties []string `url:"-"`
	Archived         bool     `url:"archived,myURLOption"`
}

type Fields struct {
	Field      string `datastore:",noindex,flatten,omitempty,myDatastoreOption"`
	OtherField string `datastore:",unknownOption"` // want `^struct-tag: unknown option "unknownOption" in datastore tag$`
}

type MapStruct struct {
	Field1     string `mapstructure:",squash,reminder,omitempty,myMapstructureOption"`
	OtherField string `mapstructure:",unknownOption"` // want `^struct-tag: unknown option "unknownOption" in mapstructure tag$`
}

type ValidateUser struct {
	Username    string `validate:"required,min=3,max=32"`
	Email       string `validate:"required,email"`
	Password    string `validate:"required,min=8,max=32"`
	Biography   string `validate:"min=0,max=1000"`
	DisplayName string `validate:"displayName,min=3,max=32"`
	Complex     string `validate:"gt=0,dive,keys,eq=1|eq=2,endkeys,required"`
	BadComplex  string `validate:"gt=0,keys,eq=1|eq=2,endkeys,required"` // want `^struct-tag: option "keys" must follow a "dive" option in validate tag$`
	BadComplex2 string `validate:"gt=0,dive,eq=1|eq=2,endkeys,required"` // want `^struct-tag: option "endkeys" without a previous "keys" option in validate tag$`
	BadComplex3 string `validate:"gt=0,dive,keys,eq=1|eq=2,endkeys,endkeys,required"` // want `^struct-tag: option "endkeys" without a previous "keys" option in validate tag$`
}

type TomlUser struct {
	Username string `toml:"username,omitempty"`
	Location string `toml:"location,unknown"`
}

type SpannerUserOptions struct {
	ID   int    `spanner:"user_id,mySpannerOption"`
	A    int    `spanner:"-,mySpannerOption"` // want `^struct-tag: useless option mySpannerOption for ignored field in spanner tag$`
	Name string `spanner:"full_name,unknownOption"` // want `^struct-tag: unknown option "unknownOption" in spanner tag$`
}

type uselessOptions struct {
	A  int       `bson:"-,"` // want `^struct-tag: unknown option "" in bson tag$`
	B  int       `bson:"-,omitempty"` // want `^struct-tag: useless option omitempty for ignored field in bson tag$`
	C  int       `bson:"-,omitempty,omitempty"` // want `^struct-tag: useless options omitempty,omitempty for ignored field in bson tag$`
	D  int       `datastore:"-,"` // want `^struct-tag: unknown option "" in datastore tag$`
	E  int       `datastore:"-,omitempty"` // want `^struct-tag: useless option omitempty for ignored field in datastore tag$`
	F  int       `datastore:"-,omitempty,omitempty"` // want `^struct-tag: useless options omitempty,omitempty for ignored field in datastore tag$`
	G  int       `json:"-,"`
	H  int       `json:"-,omitempty"` // want `^struct-tag: useless option omitempty for ignored field in json tag$`
	I  int       `json:"-,omitempty,omitempty"` // want `^struct-tag: useless options omitempty,omitempty for ignored field in json tag$`
	J  int       `mapstructure:"-,"` // want `^struct-tag: unknown option "" in mapstructure tag$`
	K  int       `mapstructure:"-,squash"` // want `^struct-tag: useless option squash for ignored field in mapstructure tag$`
	L  int       `mapstructure:"-,omitempty,omitempty"` // want `^struct-tag: useless options omitempty,omitempty for ignored field in mapstructure tag$`
	M  int       `properties:"-,"` // want `^struct-tag: unknown or malformed option "" in properties tag$`
	N  int       `properties:"-,default=15"` // want `^struct-tag: useless option default=15 for ignored field in properties tag$`
	O  time.Time `properties:"-,layout=2006-01-02,default=2006-01-02"` // want `^struct-tag: useless options layout=2006-01-02,default=2006-01-02 for ignored field in properties tag$`
	P  int       `spanner:"-,"` // want `^struct-tag: unknown option "" in spanner tag$`
	Q  int       `spanner:"-,mySpannerOption"` // want `^struct-tag: useless option mySpannerOption for ignored field in spanner tag$`
	R  int       `spanner:"-,mySpannerOption,mySpannerOption"` // want `^struct-tag: useless options mySpannerOption,mySpannerOption for ignored field in spanner tag$`
	S  int       `toml:"-,"` // want `^struct-tag: unknown option "" in toml tag$`
	T  int       `toml:"-,omitempty"` // want `^struct-tag: useless option omitempty for ignored field in toml tag$`
	U  int       `toml:"-,omitempty,omitempty"` // want `^struct-tag: useless options omitempty,omitempty for ignored field in toml tag$`
	V  int       `url:"-,"` // want `^struct-tag: unknown option "" in url tag$`
	W  int       `url:"-,omitempty"` // want `^struct-tag: useless option omitempty for ignored field in url tag$`
	X  int       `url:"-,omitempty,omitempty"` // want `^struct-tag: useless options omitempty,omitempty for ignored field in url tag$`
	Y  int       `xml:"-,"` // want `^struct-tag: unknown option "" in xml tag$`
	Z  int       `xml:"-,omitempty"` // want `^struct-tag: useless option omitempty for ignored field in xml tag$`
	Aa int       `xml:"-,omitempty,omitempty"` // want `^struct-tag: useless options omitempty,omitempty for ignored field in xml tag$`
	Ba int       `yaml:"-,"` // want `^struct-tag: unknown option "" in yaml tag$`
	Ca int       `yaml:"-,omitempty"` // want `^struct-tag: useless option omitempty for ignored field in yaml tag$`
	Da int       `yaml:"-,omitempty,omitempty"` // want `^struct-tag: useless options omitempty,omitempty for ignored field in yaml tag$`

}

type CodecUserOptions struct {
	ID   int    `codec:"user_id,myCodecOption"`
	Name string `codec:"full_name,unknownOption"` // want `^struct-tag: unknown option "unknownOption" in codec tag$`
}

type CborUserOptions struct {
	InputsOk   string `cbor:"8,keyasint,myCborOption"`
	OutputsOk  string `cbor:"-100,keyasint,unknownOption"` // want `^struct-tag: unknown option "unknownOption" in cbor tag$`
	ErrorsOk   string `cbor:"-1,keyasint"`
	InputsOk2  string `cbor:"inputs,omitempty"`
	OutputsOk2 string `cbor:",toarray"`
}
