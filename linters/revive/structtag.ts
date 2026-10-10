// Ports github.com/fatih/structtag's Parse (v1.2.0), which struct-tag uses,
// under its license:
//
// Copyright (c) 2017, Fatih Arslan
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// * Redistributions of source code must retain the above copyright notice, this
//   list of conditions and the following disclaimer.
//
// * Redistributions in binary form must reproduce the above copyright notice,
//   this list of conditions and the following disclaimer in the documentation
//   and/or other materials provided with the distribution.
//
// * Neither the name of structtag nor the names of its
//   contributors may be used to endorse or promote products derived from
//   this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
// FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
// DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
// SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
// CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
// OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
// This software includes some portions from Go. Go is used under the terms of the
// BSD like license.
//
// Copyright (c) 2012 The Go Authors. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//    * Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following disclaimer
// in the documentation and/or other materials provided with the
// distribution.
//    * Neither the name of Google Inc. nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

import * as constant from "go/constant";
import * as token from "go/token";

/** A tag of a field, as github.com/fatih/structtag parses it. */
export interface Tag {
  key: string;
  name: string;
  options: string[];
}

/** Parses a struct tag, returning null where Parse returns an error or no tags. */
export function parseTags(tag: string): Tag[] | null {
  const tags: Tag[] = [];
  const hasTag = tag !== "";
  while (tag !== "") {
    let i = 0;
    while (i < tag.length && tag[i] === " ") {
      i++;
    }
    tag = tag.slice(i);
    if (tag === "") {
      break;
    }
    i = 0;
    while (i < tag.length && tag[i] > " " && tag[i] !== ":" && tag[i] !== '"' && tag[i] !== "\x7f") {
      i++;
    }
    if (i === 0 || i + 1 >= tag.length || tag[i] !== ":" || tag[i + 1] !== '"') {
      return null;
    }
    const key = tag.slice(0, i);
    tag = tag.slice(i + 1);
    i = 1;
    while (i < tag.length && tag[i] !== '"') {
      if (tag[i] === "\\") {
        i++;
      }
      i++;
    }
    if (i >= tag.length) {
      return null;
    }
    const qvalue = tag.slice(0, i + 1);
    tag = tag.slice(i + 1);
    // MakeFromLiteral unquotes with strconv.Unquote, yielding Unknown on error.
    const value = constant.makeFromLiteral(qvalue, token.STRING, 0);
    if (value === null || value.kind() !== constant.String) {
      return null;
    }
    const [tagName, ...options] = constant.stringVal(value).split(",");
    tags.push({ key, name: tagName, options });
  }
  return hasTag && tags.length === 0 ? null : tags;
}
