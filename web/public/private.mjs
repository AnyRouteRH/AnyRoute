#!/usr/bin/env node
// anyroute-private: a local OpenAI-compatible proxy that sends every call to AnyRoute over Tor, on the unlinkable
// lane, paid with blind tokens. Apache License 2.0. Source: packages/private in the AnyRoute repository.
// Run it with Node 20 or later: node private.mjs start   (buy and status are the other commands)
// This is one file with everything it needs bundled in, not minified. Its SHA-256 is on the documentation page.
//
// Bundled third-party code
//   @cloudflare/blindrsa-ts 0.4.6. Copyright (c) 2023 Cloudflare, Inc. Apache License 2.0, http://www.apache.org/licenses/LICENSE-2.0
//   sjcl 1.0.9, which blindrsa-ts includes. Copyright (c) 2009-2015, Emily Stark, Mike Hamburg and Dan Boneh at Stanford University.
//     All rights reserved. Used under the BSD 2-Clause licence: redistributions in binary form must reproduce this copyright
//     notice, the list of conditions and the following disclaimer. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND
//     CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
//     MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
//     CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
//     BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
//     INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
//     NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
import { createRequire } from "node:module";
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// node_modules/@cloudflare/blindrsa-ts/lib/src/sjcl/index.js
var sjcl, sbp, sjcl_default;
var init_sjcl = __esm(() => {
  sjcl = {
    cipher: {},
    hash: {},
    keyexchange: {},
    mode: {},
    misc: {},
    codec: {},
    exception: {
      corrupt: function(message) {
        this.toString = function() {
          return "CORRUPT: " + this.message;
        };
        this.message = message;
      },
      invalid: function(message) {
        this.toString = function() {
          return "INVALID: " + this.message;
        };
        this.message = message;
      },
      bug: function(message) {
        this.toString = function() {
          return "BUG: " + this.message;
        };
        this.message = message;
      },
      notReady: function(message) {
        this.toString = function() {
          return "NOT READY: " + this.message;
        };
        this.message = message;
      }
    }
  };
  sjcl.cipher.aes = function(key) {
    if (!this._tables[0][0][0]) {
      this._precompute();
    }
    var i, j, tmp, encKey, decKey, sbox = this._tables[0][4], decTable = this._tables[1], keyLen = key.length, rcon = 1;
    if (keyLen !== 4 && keyLen !== 6 && keyLen !== 8) {
      throw new sjcl.exception.invalid("invalid aes key size");
    }
    this._key = [encKey = key.slice(0), decKey = []];
    for (i = keyLen;i < 4 * keyLen + 28; i++) {
      tmp = encKey[i - 1];
      if (i % keyLen === 0 || keyLen === 8 && i % keyLen === 4) {
        tmp = sbox[tmp >>> 24] << 24 ^ sbox[tmp >> 16 & 255] << 16 ^ sbox[tmp >> 8 & 255] << 8 ^ sbox[tmp & 255];
        if (i % keyLen === 0) {
          tmp = tmp << 8 ^ tmp >>> 24 ^ rcon << 24;
          rcon = rcon << 1 ^ (rcon >> 7) * 283;
        }
      }
      encKey[i] = encKey[i - keyLen] ^ tmp;
    }
    for (j = 0;i; j++, i--) {
      tmp = encKey[j & 3 ? i : i - 4];
      if (i <= 4 || j < 4) {
        decKey[j] = tmp;
      } else {
        decKey[j] = decTable[0][sbox[tmp >>> 24]] ^ decTable[1][sbox[tmp >> 16 & 255]] ^ decTable[2][sbox[tmp >> 8 & 255]] ^ decTable[3][sbox[tmp & 255]];
      }
    }
  };
  sjcl.cipher.aes.prototype = {
    encrypt: function(data) {
      return this._crypt(data, 0);
    },
    decrypt: function(data) {
      return this._crypt(data, 1);
    },
    _tables: [[[], [], [], [], []], [[], [], [], [], []]],
    _precompute: function() {
      var encTable = this._tables[0], decTable = this._tables[1], sbox = encTable[4], sboxInv = decTable[4], i, x, xInv, d = [], th = [], x2, x4, x8, s, tEnc, tDec;
      for (i = 0;i < 256; i++) {
        th[(d[i] = i << 1 ^ (i >> 7) * 283) ^ i] = i;
      }
      for (x = xInv = 0;!sbox[x]; x ^= x2 || 1, xInv = th[xInv] || 1) {
        s = xInv ^ xInv << 1 ^ xInv << 2 ^ xInv << 3 ^ xInv << 4;
        s = s >> 8 ^ s & 255 ^ 99;
        sbox[x] = s;
        sboxInv[s] = x;
        x8 = d[x4 = d[x2 = d[x]]];
        tDec = x8 * 16843009 ^ x4 * 65537 ^ x2 * 257 ^ x * 16843008;
        tEnc = d[s] * 257 ^ s * 16843008;
        for (i = 0;i < 4; i++) {
          encTable[i][x] = tEnc = tEnc << 24 ^ tEnc >>> 8;
          decTable[i][s] = tDec = tDec << 24 ^ tDec >>> 8;
        }
      }
      for (i = 0;i < 5; i++) {
        encTable[i] = encTable[i].slice(0);
        decTable[i] = decTable[i].slice(0);
      }
    },
    _crypt: function(input, dir) {
      if (input.length !== 4) {
        throw new sjcl.exception.invalid("invalid aes block size");
      }
      var key = this._key[dir], a = input[0] ^ key[0], b = input[dir ? 3 : 1] ^ key[1], c = input[2] ^ key[2], d = input[dir ? 1 : 3] ^ key[3], a2, b2, c2, nInnerRounds = key.length / 4 - 2, i, kIndex = 4, out = [0, 0, 0, 0], table = this._tables[dir], t0 = table[0], t1 = table[1], t2 = table[2], t3 = table[3], sbox = table[4];
      for (i = 0;i < nInnerRounds; i++) {
        a2 = t0[a >>> 24] ^ t1[b >> 16 & 255] ^ t2[c >> 8 & 255] ^ t3[d & 255] ^ key[kIndex];
        b2 = t0[b >>> 24] ^ t1[c >> 16 & 255] ^ t2[d >> 8 & 255] ^ t3[a & 255] ^ key[kIndex + 1];
        c2 = t0[c >>> 24] ^ t1[d >> 16 & 255] ^ t2[a >> 8 & 255] ^ t3[b & 255] ^ key[kIndex + 2];
        d = t0[d >>> 24] ^ t1[a >> 16 & 255] ^ t2[b >> 8 & 255] ^ t3[c & 255] ^ key[kIndex + 3];
        kIndex += 4;
        a = a2;
        b = b2;
        c = c2;
      }
      for (i = 0;i < 4; i++) {
        out[dir ? 3 & -i : i] = sbox[a >>> 24] << 24 ^ sbox[b >> 16 & 255] << 16 ^ sbox[c >> 8 & 255] << 8 ^ sbox[d & 255] ^ key[kIndex++];
        a2 = a;
        a = b;
        b = c;
        c = d;
        d = a2;
      }
      return out;
    }
  };
  sjcl.bitArray = {
    bitSlice: function(a, bstart, bend) {
      a = sjcl.bitArray._shiftRight(a.slice(bstart / 32), 32 - (bstart & 31)).slice(1);
      return bend === undefined ? a : sjcl.bitArray.clamp(a, bend - bstart);
    },
    extract: function(a, bstart, blength) {
      var x, sh = Math.floor(-bstart - blength & 31);
      if ((bstart + blength - 1 ^ bstart) & -32) {
        x = a[bstart / 32 | 0] << 32 - sh ^ a[bstart / 32 + 1 | 0] >>> sh;
      } else {
        x = a[bstart / 32 | 0] >>> sh;
      }
      return x & (1 << blength) - 1;
    },
    concat: function(a1, a2) {
      if (a1.length === 0 || a2.length === 0) {
        return a1.concat(a2);
      }
      var last = a1[a1.length - 1], shift = sjcl.bitArray.getPartial(last);
      if (shift === 32) {
        return a1.concat(a2);
      } else {
        return sjcl.bitArray._shiftRight(a2, shift, last | 0, a1.slice(0, a1.length - 1));
      }
    },
    bitLength: function(a) {
      var l = a.length, x;
      if (l === 0) {
        return 0;
      }
      x = a[l - 1];
      return (l - 1) * 32 + sjcl.bitArray.getPartial(x);
    },
    clamp: function(a, len) {
      if (a.length * 32 < len) {
        return a;
      }
      a = a.slice(0, Math.ceil(len / 32));
      var l = a.length;
      len = len & 31;
      if (l > 0 && len) {
        a[l - 1] = sjcl.bitArray.partial(len, a[l - 1] & 2147483648 >> len - 1, 1);
      }
      return a;
    },
    partial: function(len, x, _end) {
      if (len === 32) {
        return x;
      }
      return (_end ? x | 0 : x << 32 - len) + len * 1099511627776;
    },
    getPartial: function(x) {
      return Math.round(x / 1099511627776) || 32;
    },
    equal: function(a, b) {
      if (sjcl.bitArray.bitLength(a) !== sjcl.bitArray.bitLength(b)) {
        return false;
      }
      var x = 0, i;
      for (i = 0;i < a.length; i++) {
        x |= a[i] ^ b[i];
      }
      return x === 0;
    },
    _shiftRight: function(a, shift, carry, out) {
      var i, last2 = 0, shift2;
      if (out === undefined) {
        out = [];
      }
      for (;shift >= 32; shift -= 32) {
        out.push(carry);
        carry = 0;
      }
      if (shift === 0) {
        return out.concat(a);
      }
      for (i = 0;i < a.length; i++) {
        out.push(carry | a[i] >>> shift);
        carry = a[i] << 32 - shift;
      }
      last2 = a.length ? a[a.length - 1] : 0;
      shift2 = sjcl.bitArray.getPartial(last2);
      out.push(sjcl.bitArray.partial(shift + shift2 & 31, shift + shift2 > 32 ? carry : out.pop(), 1));
      return out;
    },
    _xor4: function(x, y) {
      return [x[0] ^ y[0], x[1] ^ y[1], x[2] ^ y[2], x[3] ^ y[3]];
    },
    byteswapM: function(a) {
      var i, v, m = 65280;
      for (i = 0;i < a.length; ++i) {
        v = a[i];
        a[i] = v >>> 24 | v >>> 8 & m | (v & m) << 8 | v << 24;
      }
      return a;
    }
  };
  sjcl.codec.utf8String = {
    fromBits: function(arr) {
      var out = "", bl = sjcl.bitArray.bitLength(arr), i, tmp;
      for (i = 0;i < bl / 8; i++) {
        if ((i & 3) === 0) {
          tmp = arr[i / 4];
        }
        out += String.fromCharCode(tmp >>> 8 >>> 8 >>> 8);
        tmp <<= 8;
      }
      return decodeURIComponent(escape(out));
    },
    toBits: function(str) {
      str = unescape(encodeURIComponent(str));
      var out = [], i, tmp = 0;
      for (i = 0;i < str.length; i++) {
        tmp = tmp << 8 | str.charCodeAt(i);
        if ((i & 3) === 3) {
          out.push(tmp);
          tmp = 0;
        }
      }
      if (i & 3) {
        out.push(sjcl.bitArray.partial(8 * (i & 3), tmp));
      }
      return out;
    }
  };
  sjcl.codec.hex = {
    fromBits: function(arr) {
      var out = "", i;
      for (i = 0;i < arr.length; i++) {
        out += ((arr[i] | 0) + 263882790666240).toString(16).substr(4);
      }
      return out.substr(0, sjcl.bitArray.bitLength(arr) / 4);
    },
    toBits: function(str) {
      var i, out = [], len;
      str = str.replace(/\s|0x/g, "");
      len = str.length;
      str = str + "00000000";
      for (i = 0;i < str.length; i += 8) {
        out.push(parseInt(str.substr(i, 8), 16) ^ 0);
      }
      return sjcl.bitArray.clamp(out, len * 4);
    }
  };
  sjcl.codec.base64 = {
    _chars: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
    fromBits: function(arr, _noEquals, _url) {
      var out = "", i, bits = 0, c = sjcl.codec.base64._chars, ta = 0, bl = sjcl.bitArray.bitLength(arr);
      if (_url) {
        c = c.substr(0, 62) + "-_";
      }
      for (i = 0;out.length * 6 < bl; ) {
        out += c.charAt((ta ^ arr[i] >>> bits) >>> 26);
        if (bits < 6) {
          ta = arr[i] << 6 - bits;
          bits += 26;
          i++;
        } else {
          ta <<= 6;
          bits -= 6;
        }
      }
      while (out.length & 3 && !_noEquals) {
        out += "=";
      }
      return out;
    },
    toBits: function(str, _url) {
      str = str.replace(/\s|=/g, "");
      var out = [], i, bits = 0, c = sjcl.codec.base64._chars, ta = 0, x;
      if (_url) {
        c = c.substr(0, 62) + "-_";
      }
      for (i = 0;i < str.length; i++) {
        x = c.indexOf(str.charAt(i));
        if (x < 0) {
          throw new sjcl.exception.invalid("this isn't base64!");
        }
        if (bits > 26) {
          bits -= 26;
          out.push(ta ^ x >>> bits);
          ta = x << 32 - bits;
        } else {
          bits += 6;
          ta ^= x << 32 - bits;
        }
      }
      if (bits & 56) {
        out.push(sjcl.bitArray.partial(bits & 56, ta, 1));
      }
      return out;
    }
  };
  sjcl.codec.base64url = {
    fromBits: function(arr) {
      return sjcl.codec.base64.fromBits(arr, 1, 1);
    },
    toBits: function(str) {
      return sjcl.codec.base64.toBits(str, 1);
    }
  };
  sjcl.codec.bytes = {
    fromBits: function(arr) {
      var out = [], bl = sjcl.bitArray.bitLength(arr), i, tmp;
      for (i = 0;i < bl / 8; i++) {
        if ((i & 3) === 0) {
          tmp = arr[i / 4];
        }
        out.push(tmp >>> 24);
        tmp <<= 8;
      }
      return out;
    },
    toBits: function(bytes) {
      var out = [], i, tmp = 0;
      for (i = 0;i < bytes.length; i++) {
        tmp = tmp << 8 | bytes[i];
        if ((i & 3) === 3) {
          out.push(tmp);
          tmp = 0;
        }
      }
      if (i & 3) {
        out.push(sjcl.bitArray.partial(8 * (i & 3), tmp));
      }
      return out;
    }
  };
  sjcl.hash.sha256 = function(hash) {
    if (!this._key[0]) {
      this._precompute();
    }
    if (hash) {
      this._h = hash._h.slice(0);
      this._buffer = hash._buffer.slice(0);
      this._length = hash._length;
    } else {
      this.reset();
    }
  };
  sjcl.hash.sha256.hash = function(data) {
    return new sjcl.hash.sha256().update(data).finalize();
  };
  sjcl.hash.sha256.prototype = {
    blockSize: 512,
    reset: function() {
      this._h = this._init.slice(0);
      this._buffer = [];
      this._length = 0;
      return this;
    },
    update: function(data) {
      if (typeof data === "string") {
        data = sjcl.codec.utf8String.toBits(data);
      }
      var i, b = this._buffer = sjcl.bitArray.concat(this._buffer, data), ol = this._length, nl = this._length = ol + sjcl.bitArray.bitLength(data);
      if (nl > 9007199254740991) {
        throw new sjcl.exception.invalid("Cannot hash more than 2^53 - 1 bits");
      }
      if (typeof Uint32Array !== "undefined") {
        var c = new Uint32Array(b);
        var j = 0;
        for (i = 512 + ol - (512 + ol & 511);i <= nl; i += 512) {
          this._block(c.subarray(16 * j, 16 * (j + 1)));
          j += 1;
        }
        b.splice(0, 16 * j);
      } else {
        for (i = 512 + ol - (512 + ol & 511);i <= nl; i += 512) {
          this._block(b.splice(0, 16));
        }
      }
      return this;
    },
    finalize: function() {
      var i, b = this._buffer, h = this._h;
      b = sjcl.bitArray.concat(b, [sjcl.bitArray.partial(1, 1)]);
      for (i = b.length + 2;i & 15; i++) {
        b.push(0);
      }
      b.push(Math.floor(this._length / 4294967296));
      b.push(this._length | 0);
      while (b.length) {
        this._block(b.splice(0, 16));
      }
      this.reset();
      return h;
    },
    _init: [],
    _key: [],
    _precompute: function() {
      var i = 0, prime = 2, factor, isPrime;
      function frac(x) {
        return (x - Math.floor(x)) * 4294967296 | 0;
      }
      for (;i < 64; prime++) {
        isPrime = true;
        for (factor = 2;factor * factor <= prime; factor++) {
          if (prime % factor === 0) {
            isPrime = false;
            break;
          }
        }
        if (isPrime) {
          if (i < 8) {
            this._init[i] = frac(Math.pow(prime, 1 / 2));
          }
          this._key[i] = frac(Math.pow(prime, 1 / 3));
          i++;
        }
      }
    },
    _block: function(w) {
      var i, tmp, a, b, h = this._h, k = this._key, h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3], h4 = h[4], h5 = h[5], h6 = h[6], h7 = h[7];
      for (i = 0;i < 64; i++) {
        if (i < 16) {
          tmp = w[i];
        } else {
          a = w[i + 1 & 15];
          b = w[i + 14 & 15];
          tmp = w[i & 15] = (a >>> 7 ^ a >>> 18 ^ a >>> 3 ^ a << 25 ^ a << 14) + (b >>> 17 ^ b >>> 19 ^ b >>> 10 ^ b << 15 ^ b << 13) + w[i & 15] + w[i + 9 & 15] | 0;
        }
        tmp = tmp + h7 + (h4 >>> 6 ^ h4 >>> 11 ^ h4 >>> 25 ^ h4 << 26 ^ h4 << 21 ^ h4 << 7) + (h6 ^ h4 & (h5 ^ h6)) + k[i];
        h7 = h6;
        h6 = h5;
        h5 = h4;
        h4 = h3 + tmp | 0;
        h3 = h2;
        h2 = h1;
        h1 = h0;
        h0 = tmp + (h1 & h2 ^ h3 & (h1 ^ h2)) + (h1 >>> 2 ^ h1 >>> 13 ^ h1 >>> 22 ^ h1 << 30 ^ h1 << 19 ^ h1 << 10) | 0;
      }
      h[0] = h[0] + h0 | 0;
      h[1] = h[1] + h1 | 0;
      h[2] = h[2] + h2 | 0;
      h[3] = h[3] + h3 | 0;
      h[4] = h[4] + h4 | 0;
      h[5] = h[5] + h5 | 0;
      h[6] = h[6] + h6 | 0;
      h[7] = h[7] + h7 | 0;
    }
  };
  sjcl.mode.ccm = {
    name: "ccm",
    _progressListeners: [],
    listenProgress: function(cb) {
      sjcl.mode.ccm._progressListeners.push(cb);
    },
    unListenProgress: function(cb) {
      var index = sjcl.mode.ccm._progressListeners.indexOf(cb);
      if (index > -1) {
        sjcl.mode.ccm._progressListeners.splice(index, 1);
      }
    },
    _callProgressListener: function(val) {
      var p = sjcl.mode.ccm._progressListeners.slice(), i;
      for (i = 0;i < p.length; i += 1) {
        p[i](val);
      }
    },
    encrypt: function(prf, plaintext, iv, adata, tlen) {
      var L, out = plaintext.slice(0), tag, w = sjcl.bitArray, ivl = w.bitLength(iv) / 8, ol = w.bitLength(out) / 8;
      tlen = tlen || 64;
      adata = adata || [];
      if (ivl < 7) {
        throw new sjcl.exception.invalid("ccm: iv must be at least 7 bytes");
      }
      for (L = 2;L < 4 && ol >>> 8 * L; L++) {}
      if (L < 15 - ivl) {
        L = 15 - ivl;
      }
      iv = w.clamp(iv, 8 * (15 - L));
      tag = sjcl.mode.ccm._computeTag(prf, plaintext, iv, adata, tlen, L);
      out = sjcl.mode.ccm._ctrMode(prf, out, iv, tag, tlen, L);
      return w.concat(out.data, out.tag);
    },
    decrypt: function(prf, ciphertext, iv, adata, tlen) {
      tlen = tlen || 64;
      adata = adata || [];
      var L, w = sjcl.bitArray, ivl = w.bitLength(iv) / 8, ol = w.bitLength(ciphertext), out = w.clamp(ciphertext, ol - tlen), tag = w.bitSlice(ciphertext, ol - tlen), tag2;
      ol = (ol - tlen) / 8;
      if (ivl < 7) {
        throw new sjcl.exception.invalid("ccm: iv must be at least 7 bytes");
      }
      for (L = 2;L < 4 && ol >>> 8 * L; L++) {}
      if (L < 15 - ivl) {
        L = 15 - ivl;
      }
      iv = w.clamp(iv, 8 * (15 - L));
      out = sjcl.mode.ccm._ctrMode(prf, out, iv, tag, tlen, L);
      tag2 = sjcl.mode.ccm._computeTag(prf, out.data, iv, adata, tlen, L);
      if (!w.equal(out.tag, tag2)) {
        throw new sjcl.exception.corrupt("ccm: tag doesn't match");
      }
      return out.data;
    },
    _macAdditionalData: function(prf, adata, iv, tlen, ol, L) {
      var mac, tmp, i, macData = [], w = sjcl.bitArray, xor = w._xor4;
      mac = [w.partial(8, (adata.length ? 1 << 6 : 0) | tlen - 2 << 2 | L - 1)];
      mac = w.concat(mac, iv);
      mac[3] |= ol;
      mac = prf.encrypt(mac);
      if (adata.length) {
        tmp = w.bitLength(adata) / 8;
        if (tmp <= 65279) {
          macData = [w.partial(16, tmp)];
        } else if (tmp <= 4294967295) {
          macData = w.concat([w.partial(16, 65534)], [tmp]);
        }
        macData = w.concat(macData, adata);
        for (i = 0;i < macData.length; i += 4) {
          mac = prf.encrypt(xor(mac, macData.slice(i, i + 4).concat([0, 0, 0])));
        }
      }
      return mac;
    },
    _computeTag: function(prf, plaintext, iv, adata, tlen, L) {
      var mac, i, w = sjcl.bitArray, xor = w._xor4;
      tlen /= 8;
      if (tlen % 2 || tlen < 4 || tlen > 16) {
        throw new sjcl.exception.invalid("ccm: invalid tag length");
      }
      if (adata.length > 4294967295 || plaintext.length > 4294967295) {
        throw new sjcl.exception.bug("ccm: can't deal with 4GiB or more data");
      }
      mac = sjcl.mode.ccm._macAdditionalData(prf, adata, iv, tlen, w.bitLength(plaintext) / 8, L);
      for (i = 0;i < plaintext.length; i += 4) {
        mac = prf.encrypt(xor(mac, plaintext.slice(i, i + 4).concat([0, 0, 0])));
      }
      return w.clamp(mac, tlen * 8);
    },
    _ctrMode: function(prf, data, iv, tag, tlen, L) {
      var enc2, i, w = sjcl.bitArray, xor = w._xor4, ctr, l = data.length, bl = w.bitLength(data), n = l / 50, p = n;
      ctr = w.concat([w.partial(8, L - 1)], iv).concat([0, 0, 0]).slice(0, 4);
      tag = w.bitSlice(xor(tag, prf.encrypt(ctr)), 0, tlen);
      if (!l) {
        return { tag, data: [] };
      }
      for (i = 0;i < l; i += 4) {
        if (i > n) {
          sjcl.mode.ccm._callProgressListener(i / l);
          n += p;
        }
        ctr[3]++;
        enc2 = prf.encrypt(ctr);
        data[i] ^= enc2[0];
        data[i + 1] ^= enc2[1];
        data[i + 2] ^= enc2[2];
        data[i + 3] ^= enc2[3];
      }
      return { tag, data: w.clamp(data, bl) };
    }
  };
  sjcl.misc.hmac = function(key, Hash) {
    this._hash = Hash = Hash || sjcl.hash.sha256;
    var exKey = [[], []], i, bs = Hash.prototype.blockSize / 32;
    this._baseHash = [new Hash, new Hash];
    if (key.length > bs) {
      key = Hash.hash(key);
    }
    for (i = 0;i < bs; i++) {
      exKey[0][i] = key[i] ^ 909522486;
      exKey[1][i] = key[i] ^ 1549556828;
    }
    this._baseHash[0].update(exKey[0]);
    this._baseHash[1].update(exKey[1]);
    this._resultHash = new Hash(this._baseHash[0]);
  };
  sjcl.misc.hmac.prototype.encrypt = sjcl.misc.hmac.prototype.mac = function(data) {
    if (!this._updated) {
      this.update(data);
      return this.digest(data);
    } else {
      throw new sjcl.exception.invalid("encrypt on already updated hmac called!");
    }
  };
  sjcl.misc.hmac.prototype.reset = function() {
    this._resultHash = new this._hash(this._baseHash[0]);
    this._updated = false;
  };
  sjcl.misc.hmac.prototype.update = function(data) {
    this._updated = true;
    this._resultHash.update(data);
  };
  sjcl.misc.hmac.prototype.digest = function() {
    var w = this._resultHash.finalize(), result = new this._hash(this._baseHash[1]).update(w).finalize();
    this.reset();
    return result;
  };
  sjcl.misc.pbkdf2 = function(password, salt, count, length, Prff) {
    count = count || 1e4;
    if (length < 0 || count < 0) {
      throw new sjcl.exception.invalid("invalid params to pbkdf2");
    }
    if (typeof password === "string") {
      password = sjcl.codec.utf8String.toBits(password);
    }
    if (typeof salt === "string") {
      salt = sjcl.codec.utf8String.toBits(salt);
    }
    Prff = Prff || sjcl.misc.hmac;
    var prf = new Prff(password), u, ui, i, j, k, out = [], b = sjcl.bitArray;
    for (k = 1;32 * out.length < (length || 1); k++) {
      u = ui = prf.encrypt(b.concat(salt, [k]));
      for (i = 1;i < count; i++) {
        ui = prf.encrypt(ui);
        for (j = 0;j < ui.length; j++) {
          u[j] ^= ui[j];
        }
      }
      out = out.concat(u);
    }
    if (length) {
      out = b.clamp(out, length);
    }
    return out;
  };
  sjcl.prng = function(defaultParanoia) {
    this._pools = [new sjcl.hash.sha256];
    this._poolEntropy = [0];
    this._reseedCount = 0;
    this._robins = {};
    this._eventId = 0;
    this._collectorIds = {};
    this._collectorIdNext = 0;
    this._strength = 0;
    this._poolStrength = 0;
    this._nextReseed = 0;
    this._key = [0, 0, 0, 0, 0, 0, 0, 0];
    this._counter = [0, 0, 0, 0];
    this._cipher = undefined;
    this._defaultParanoia = defaultParanoia;
    this._collectorsStarted = false;
    this._callbacks = { progress: {}, seeded: {} };
    this._callbackI = 0;
    this._NOT_READY = 0;
    this._READY = 1;
    this._REQUIRES_RESEED = 2;
    this._MAX_WORDS_PER_BURST = 65536;
    this._PARANOIA_LEVELS = [0, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];
    this._MILLISECONDS_PER_RESEED = 30000;
    this._BITS_PER_RESEED = 80;
  };
  sjcl.prng.prototype = {
    randomWords: function(nwords, paranoia) {
      var out = [], i, readiness = this.isReady(paranoia), g;
      if (readiness === this._NOT_READY) {
        throw new sjcl.exception.notReady("generator isn't seeded");
      } else if (readiness & this._REQUIRES_RESEED) {
        this._reseedFromPools(!(readiness & this._READY));
      }
      for (i = 0;i < nwords; i += 4) {
        if ((i + 1) % this._MAX_WORDS_PER_BURST === 0) {
          this._gate();
        }
        g = this._gen4words();
        out.push(g[0], g[1], g[2], g[3]);
      }
      this._gate();
      return out.slice(0, nwords);
    },
    setDefaultParanoia: function(paranoia, allowZeroParanoia) {
      if (paranoia === 0 && allowZeroParanoia !== "Setting paranoia=0 will ruin your security; use it only for testing") {
        throw new sjcl.exception.invalid("Setting paranoia=0 will ruin your security; use it only for testing");
      }
      this._defaultParanoia = paranoia;
    },
    addEntropy: function(data, estimatedEntropy, source) {
      source = source || "user";
      var id, i, tmp, t = new Date().valueOf(), robin = this._robins[source], oldReady = this.isReady(), err = 0, objName;
      id = this._collectorIds[source];
      if (id === undefined) {
        id = this._collectorIds[source] = this._collectorIdNext++;
      }
      if (robin === undefined) {
        robin = this._robins[source] = 0;
      }
      this._robins[source] = (this._robins[source] + 1) % this._pools.length;
      switch (typeof data) {
        case "number":
          if (estimatedEntropy === undefined) {
            estimatedEntropy = 1;
          }
          this._pools[robin].update([id, this._eventId++, 1, estimatedEntropy, t, 1, data | 0]);
          break;
        case "object":
          objName = Object.prototype.toString.call(data);
          if (objName === "[object Uint32Array]") {
            tmp = [];
            for (i = 0;i < data.length; i++) {
              tmp.push(data[i]);
            }
            data = tmp;
          } else {
            if (objName !== "[object Array]") {
              err = 1;
            }
            for (i = 0;i < data.length && !err; i++) {
              if (typeof data[i] !== "number") {
                err = 1;
              }
            }
          }
          if (!err) {
            if (estimatedEntropy === undefined) {
              estimatedEntropy = 0;
              for (i = 0;i < data.length; i++) {
                tmp = data[i];
                while (tmp > 0) {
                  estimatedEntropy++;
                  tmp = tmp >>> 1;
                }
              }
            }
            this._pools[robin].update([id, this._eventId++, 2, estimatedEntropy, t, data.length].concat(data));
          }
          break;
        case "string":
          if (estimatedEntropy === undefined) {
            estimatedEntropy = data.length;
          }
          this._pools[robin].update([id, this._eventId++, 3, estimatedEntropy, t, data.length]);
          this._pools[robin].update(data);
          break;
        default:
          err = 1;
      }
      if (err) {
        throw new sjcl.exception.bug("random: addEntropy only supports number, array of numbers or string");
      }
      this._poolEntropy[robin] += estimatedEntropy;
      this._poolStrength += estimatedEntropy;
      if (oldReady === this._NOT_READY) {
        if (this.isReady() !== this._NOT_READY) {
          this._fireEvent("seeded", Math.max(this._strength, this._poolStrength));
        }
        this._fireEvent("progress", this.getProgress());
      }
    },
    isReady: function(paranoia) {
      var entropyRequired = this._PARANOIA_LEVELS[paranoia !== undefined ? paranoia : this._defaultParanoia];
      if (this._strength && this._strength >= entropyRequired) {
        return this._poolEntropy[0] > this._BITS_PER_RESEED && new Date().valueOf() > this._nextReseed ? this._REQUIRES_RESEED | this._READY : this._READY;
      } else {
        return this._poolStrength >= entropyRequired ? this._REQUIRES_RESEED | this._NOT_READY : this._NOT_READY;
      }
    },
    getProgress: function(paranoia) {
      var entropyRequired = this._PARANOIA_LEVELS[paranoia ? paranoia : this._defaultParanoia];
      if (this._strength >= entropyRequired) {
        return 1;
      } else {
        return this._poolStrength > entropyRequired ? 1 : this._poolStrength / entropyRequired;
      }
    },
    startCollectors: function() {
      if (this._collectorsStarted) {
        return;
      }
      this._eventListener = {
        loadTimeCollector: this._bind(this._loadTimeCollector),
        mouseCollector: this._bind(this._mouseCollector),
        keyboardCollector: this._bind(this._keyboardCollector),
        accelerometerCollector: this._bind(this._accelerometerCollector),
        touchCollector: this._bind(this._touchCollector)
      };
      if (window.addEventListener) {
        window.addEventListener("load", this._eventListener.loadTimeCollector, false);
        window.addEventListener("mousemove", this._eventListener.mouseCollector, false);
        window.addEventListener("keypress", this._eventListener.keyboardCollector, false);
        window.addEventListener("devicemotion", this._eventListener.accelerometerCollector, false);
        window.addEventListener("touchmove", this._eventListener.touchCollector, false);
      } else if (document.attachEvent) {
        document.attachEvent("onload", this._eventListener.loadTimeCollector);
        document.attachEvent("onmousemove", this._eventListener.mouseCollector);
        document.attachEvent("keypress", this._eventListener.keyboardCollector);
      } else {
        throw new sjcl.exception.bug("can't attach event");
      }
      this._collectorsStarted = true;
    },
    stopCollectors: function() {
      if (!this._collectorsStarted) {
        return;
      }
      if (window.removeEventListener) {
        window.removeEventListener("load", this._eventListener.loadTimeCollector, false);
        window.removeEventListener("mousemove", this._eventListener.mouseCollector, false);
        window.removeEventListener("keypress", this._eventListener.keyboardCollector, false);
        window.removeEventListener("devicemotion", this._eventListener.accelerometerCollector, false);
        window.removeEventListener("touchmove", this._eventListener.touchCollector, false);
      } else if (document.detachEvent) {
        document.detachEvent("onload", this._eventListener.loadTimeCollector);
        document.detachEvent("onmousemove", this._eventListener.mouseCollector);
        document.detachEvent("keypress", this._eventListener.keyboardCollector);
      }
      this._collectorsStarted = false;
    },
    addEventListener: function(name, callback) {
      this._callbacks[name][this._callbackI++] = callback;
    },
    removeEventListener: function(name, cb) {
      var i, j, cbs = this._callbacks[name], jsTemp = [];
      for (j in cbs) {
        if (cbs.hasOwnProperty(j) && cbs[j] === cb) {
          jsTemp.push(j);
        }
      }
      for (i = 0;i < jsTemp.length; i++) {
        j = jsTemp[i];
        delete cbs[j];
      }
    },
    _bind: function(func) {
      var that = this;
      return function() {
        func.apply(that, arguments);
      };
    },
    _gen4words: function() {
      for (var i = 0;i < 4; i++) {
        this._counter[i] = this._counter[i] + 1 | 0;
        if (this._counter[i]) {
          break;
        }
      }
      return this._cipher.encrypt(this._counter);
    },
    _gate: function() {
      this._key = this._gen4words().concat(this._gen4words());
      this._cipher = new sjcl.cipher.aes(this._key);
    },
    _reseed: function(seedWords) {
      this._key = sjcl.hash.sha256.hash(this._key.concat(seedWords));
      this._cipher = new sjcl.cipher.aes(this._key);
      for (var i = 0;i < 4; i++) {
        this._counter[i] = this._counter[i] + 1 | 0;
        if (this._counter[i]) {
          break;
        }
      }
    },
    _reseedFromPools: function(full) {
      var reseedData = [], strength = 0, i;
      this._nextReseed = reseedData[0] = new Date().valueOf() + this._MILLISECONDS_PER_RESEED;
      for (i = 0;i < 16; i++) {
        reseedData.push(Math.random() * 4294967296 | 0);
      }
      for (i = 0;i < this._pools.length; i++) {
        reseedData = reseedData.concat(this._pools[i].finalize());
        strength += this._poolEntropy[i];
        this._poolEntropy[i] = 0;
        if (!full && this._reseedCount & 1 << i) {
          break;
        }
      }
      if (this._reseedCount >= 1 << this._pools.length) {
        this._pools.push(new sjcl.hash.sha256);
        this._poolEntropy.push(0);
      }
      this._poolStrength -= strength;
      if (strength > this._strength) {
        this._strength = strength;
      }
      this._reseedCount++;
      this._reseed(reseedData);
    },
    _keyboardCollector: function() {
      this._addCurrentTimeToEntropy(1);
    },
    _mouseCollector: function(ev) {
      var x, y;
      try {
        x = ev.x || ev.clientX || ev.offsetX || 0;
        y = ev.y || ev.clientY || ev.offsetY || 0;
      } catch (err) {
        x = 0;
        y = 0;
      }
      if (x != 0 && y != 0) {
        this.addEntropy([x, y], 2, "mouse");
      }
      this._addCurrentTimeToEntropy(0);
    },
    _touchCollector: function(ev) {
      var touch = ev.touches[0] || ev.changedTouches[0];
      var x = touch.pageX || touch.clientX, y = touch.pageY || touch.clientY;
      this.addEntropy([x, y], 1, "touch");
      this._addCurrentTimeToEntropy(0);
    },
    _loadTimeCollector: function() {
      this._addCurrentTimeToEntropy(2);
    },
    _addCurrentTimeToEntropy: function(estimatedEntropy) {
      if (typeof window !== "undefined" && window.performance && typeof window.performance.now === "function") {
        this.addEntropy(window.performance.now(), estimatedEntropy, "loadtime");
      } else {
        this.addEntropy(new Date().valueOf(), estimatedEntropy, "loadtime");
      }
    },
    _accelerometerCollector: function(ev) {
      var ac = ev.accelerationIncludingGravity.x || ev.accelerationIncludingGravity.y || ev.accelerationIncludingGravity.z;
      if (window.orientation) {
        var or = window.orientation;
        if (typeof or === "number") {
          this.addEntropy(or, 1, "accelerometer");
        }
      }
      if (ac) {
        this.addEntropy(ac, 2, "accelerometer");
      }
      this._addCurrentTimeToEntropy(0);
    },
    _fireEvent: function(name, arg) {
      var j, cbs = sjcl.random._callbacks[name], cbsTemp = [];
      for (j in cbs) {
        if (cbs.hasOwnProperty(j)) {
          cbsTemp.push(cbs[j]);
        }
      }
      for (j = 0;j < cbsTemp.length; j++) {
        cbsTemp[j](arg);
      }
    }
  };
  sjcl.random = new sjcl.prng(6);
  (function() {
    function getCryptoModule() {
      try {
        return __require("crypto");
      } catch (e) {
        return null;
      }
    }
    try {
      var buf, crypt, ab;
      if (typeof module_sjcl !== "undefined" && exports_sjcl && (crypt = getCryptoModule()) && crypt.randomBytes) {
        buf = crypt.randomBytes(1024 / 8);
        buf = new Uint32Array(new Uint8Array(buf).buffer);
        sjcl.random.addEntropy(buf, 1024, "crypto.randomBytes");
      } else if (typeof window !== "undefined" && typeof Uint32Array !== "undefined") {
        ab = new Uint32Array(32);
        if (window.crypto && window.crypto.getRandomValues) {
          window.crypto.getRandomValues(ab);
        } else if (window.msCrypto && window.msCrypto.getRandomValues) {
          window.msCrypto.getRandomValues(ab);
        } else {
          return;
        }
        sjcl.random.addEntropy(ab, 1024, "crypto.getRandomValues");
      }
    } catch (e) {
      if (typeof window !== "undefined" && window.console) {
        console.log("There was an error collecting entropy from the browser:");
        console.log(e);
      }
    }
  })();
  sjcl.json = {
    defaults: { v: 1, iter: 1e4, ks: 128, ts: 64, mode: "ccm", adata: "", cipher: "aes" },
    _encrypt: function(password, plaintext, params, rp) {
      params = params || {};
      rp = rp || {};
      var j = sjcl.json, p = j._add({ iv: sjcl.random.randomWords(4, 0) }, j.defaults), tmp, prp, adata;
      j._add(p, params);
      adata = p.adata;
      if (typeof p.salt === "string") {
        p.salt = sjcl.codec.base64.toBits(p.salt);
      }
      if (typeof p.iv === "string") {
        p.iv = sjcl.codec.base64.toBits(p.iv);
      }
      if (!sjcl.mode[p.mode] || !sjcl.cipher[p.cipher] || typeof password === "string" && p.iter <= 100 || p.ts !== 64 && p.ts !== 96 && p.ts !== 128 || p.ks !== 128 && p.ks !== 192 && p.ks !== 256 || (p.iv.length < 2 || p.iv.length > 4)) {
        throw new sjcl.exception.invalid("json encrypt: invalid parameters");
      }
      if (typeof password === "string") {
        tmp = sjcl.misc.cachedPbkdf2(password, p);
        password = tmp.key.slice(0, p.ks / 32);
        p.salt = tmp.salt;
      } else if (sjcl.ecc && password instanceof sjcl.ecc.elGamal.publicKey) {
        tmp = password.kem();
        p.kemtag = tmp.tag;
        password = tmp.key.slice(0, p.ks / 32);
      }
      if (typeof plaintext === "string") {
        plaintext = sjcl.codec.utf8String.toBits(plaintext);
      }
      if (typeof adata === "string") {
        p.adata = adata = sjcl.codec.utf8String.toBits(adata);
      }
      prp = new sjcl.cipher[p.cipher](password);
      j._add(rp, p);
      rp.key = password;
      if (p.mode === "ccm" && sjcl.arrayBuffer && sjcl.arrayBuffer.ccm && plaintext instanceof ArrayBuffer) {
        p.ct = sjcl.arrayBuffer.ccm.encrypt(prp, plaintext, p.iv, adata, p.ts);
      } else {
        p.ct = sjcl.mode[p.mode].encrypt(prp, plaintext, p.iv, adata, p.ts);
      }
      return p;
    },
    encrypt: function(password, plaintext, params, rp) {
      var j = sjcl.json, p = j._encrypt.apply(j, arguments);
      return j.encode(p);
    },
    _decrypt: function(password, ciphertext, params, rp) {
      params = params || {};
      rp = rp || {};
      var j = sjcl.json, p = j._add(j._add(j._add({}, j.defaults), ciphertext), params, true), ct, tmp, prp, adata = p.adata;
      if (typeof p.salt === "string") {
        p.salt = sjcl.codec.base64.toBits(p.salt);
      }
      if (typeof p.iv === "string") {
        p.iv = sjcl.codec.base64.toBits(p.iv);
      }
      if (!sjcl.mode[p.mode] || !sjcl.cipher[p.cipher] || typeof password === "string" && p.iter <= 100 || p.ts !== 64 && p.ts !== 96 && p.ts !== 128 || p.ks !== 128 && p.ks !== 192 && p.ks !== 256 || !p.iv || (p.iv.length < 2 || p.iv.length > 4)) {
        throw new sjcl.exception.invalid("json decrypt: invalid parameters");
      }
      if (typeof password === "string") {
        tmp = sjcl.misc.cachedPbkdf2(password, p);
        password = tmp.key.slice(0, p.ks / 32);
        p.salt = tmp.salt;
      } else if (sjcl.ecc && password instanceof sjcl.ecc.elGamal.secretKey) {
        password = password.unkem(sjcl.codec.base64.toBits(p.kemtag)).slice(0, p.ks / 32);
      }
      if (typeof adata === "string") {
        adata = sjcl.codec.utf8String.toBits(adata);
      }
      prp = new sjcl.cipher[p.cipher](password);
      if (p.mode === "ccm" && sjcl.arrayBuffer && sjcl.arrayBuffer.ccm && p.ct instanceof ArrayBuffer) {
        ct = sjcl.arrayBuffer.ccm.decrypt(prp, p.ct, p.iv, p.tag, adata, p.ts);
      } else {
        ct = sjcl.mode[p.mode].decrypt(prp, p.ct, p.iv, adata, p.ts);
      }
      j._add(rp, p);
      rp.key = password;
      if (params.raw === 1) {
        return ct;
      } else {
        return sjcl.codec.utf8String.fromBits(ct);
      }
    },
    decrypt: function(password, ciphertext, params, rp) {
      var j = sjcl.json;
      return j._decrypt(password, j.decode(ciphertext), params, rp);
    },
    encode: function(obj) {
      var i, out = "{", comma = "";
      for (i in obj) {
        if (obj.hasOwnProperty(i)) {
          if (!i.match(/^[a-z0-9]+$/i)) {
            throw new sjcl.exception.invalid("json encode: invalid property name");
          }
          out += comma + '"' + i + '":';
          comma = ",";
          switch (typeof obj[i]) {
            case "number":
            case "boolean":
              out += obj[i];
              break;
            case "string":
              out += '"' + escape(obj[i]) + '"';
              break;
            case "object":
              out += '"' + sjcl.codec.base64.fromBits(obj[i], 0) + '"';
              break;
            default:
              throw new sjcl.exception.bug("json encode: unsupported type");
          }
        }
      }
      return out + "}";
    },
    decode: function(str) {
      str = str.replace(/\s/g, "");
      if (!str.match(/^\{.*\}$/)) {
        throw new sjcl.exception.invalid("json decode: this isn't json!");
      }
      var a = str.replace(/^\{|\}$/g, "").split(/,/), out = {}, i, m;
      for (i = 0;i < a.length; i++) {
        if (!(m = a[i].match(/^\s*(?:(["']?)([a-z][a-z0-9]*)\1)\s*:\s*(?:(-?\d+)|"([a-z0-9+\/%*_.@=\-]*)"|(true|false))$/i))) {
          throw new sjcl.exception.invalid("json decode: this isn't json!");
        }
        if (m[3] != null) {
          out[m[2]] = parseInt(m[3], 10);
        } else if (m[4] != null) {
          out[m[2]] = m[2].match(/^(ct|adata|salt|iv)$/) ? sjcl.codec.base64.toBits(m[4]) : unescape(m[4]);
        } else if (m[5] != null) {
          out[m[2]] = m[5] === "true";
        }
      }
      return out;
    },
    _add: function(target, src, requireSame) {
      if (target === undefined) {
        target = {};
      }
      if (src === undefined) {
        return target;
      }
      var i;
      for (i in src) {
        if (src.hasOwnProperty(i)) {
          if (requireSame && target[i] !== undefined && target[i] !== src[i]) {
            throw new sjcl.exception.invalid("required parameter overridden");
          }
          target[i] = src[i];
        }
      }
      return target;
    },
    _subtract: function(plus, minus) {
      var out = {}, i;
      for (i in plus) {
        if (plus.hasOwnProperty(i) && plus[i] !== minus[i]) {
          out[i] = plus[i];
        }
      }
      return out;
    },
    _filter: function(src, filter) {
      var out = {}, i;
      for (i = 0;i < filter.length; i++) {
        if (src[filter[i]] !== undefined) {
          out[filter[i]] = src[filter[i]];
        }
      }
      return out;
    }
  };
  sjcl.encrypt = sjcl.json.encrypt;
  sjcl.decrypt = sjcl.json.decrypt;
  sjcl.misc._pbkdf2Cache = {};
  sjcl.misc.cachedPbkdf2 = function(password, obj) {
    var cache = sjcl.misc._pbkdf2Cache, c, cp, str, salt, iter;
    obj = obj || {};
    iter = obj.iter || 1000;
    cp = cache[password] = cache[password] || {};
    c = cp[iter] = cp[iter] || { firstSalt: obj.salt && obj.salt.length ? obj.salt.slice(0) : sjcl.random.randomWords(2, 0) };
    salt = obj.salt === undefined ? c.firstSalt : obj.salt;
    c[salt] = c[salt] || sjcl.misc.pbkdf2(password, salt, obj.iter);
    return { key: c[salt].slice(0), salt: salt.slice(0) };
  };
  sjcl.bn = function(it) {
    this.initWith(it);
  };
  sjcl.bn.prototype = {
    radix: 24,
    maxMul: 8,
    _class: sjcl.bn,
    copy: function() {
      return new this._class(this);
    },
    initWith: function(it) {
      var i = 0, k;
      switch (typeof it) {
        case "object":
          this.limbs = it.limbs.slice(0);
          break;
        case "number":
          this.limbs = [it];
          this.normalize();
          break;
        case "string":
          it = it.replace(/^0x/, "");
          this.limbs = [];
          k = this.radix / 4;
          for (i = 0;i < it.length; i += k) {
            this.limbs.push(parseInt(it.substring(Math.max(it.length - i - k, 0), it.length - i), 16));
          }
          break;
        default:
          this.limbs = [0];
      }
      return this;
    },
    equals: function(that) {
      if (typeof that === "number") {
        that = new this._class(that);
      }
      var difference = 0, i;
      this.fullReduce();
      that.fullReduce();
      for (i = 0;i < this.limbs.length || i < that.limbs.length; i++) {
        difference |= this.getLimb(i) ^ that.getLimb(i);
      }
      return difference === 0;
    },
    getLimb: function(i) {
      return i >= this.limbs.length ? 0 : this.limbs[i];
    },
    greaterEquals: function(that) {
      if (typeof that === "number") {
        that = new this._class(that);
      }
      var less = 0, greater = 0, i, a, b;
      i = Math.max(this.limbs.length, that.limbs.length) - 1;
      for (;i >= 0; i--) {
        a = this.getLimb(i);
        b = that.getLimb(i);
        greater |= b - a & ~less;
        less |= a - b & ~greater;
      }
      return (greater | ~less) >>> 31;
    },
    toString: function() {
      this.fullReduce();
      var out = "", i, s, l = this.limbs;
      for (i = 0;i < this.limbs.length; i++) {
        s = l[i].toString(16);
        while (i < this.limbs.length - 1 && s.length < 6) {
          s = "0" + s;
        }
        out = s + out;
      }
      return "0x" + out;
    },
    addM: function(that) {
      if (typeof that !== "object") {
        that = new this._class(that);
      }
      var i, l = this.limbs, ll = that.limbs;
      for (i = l.length;i < ll.length; i++) {
        l[i] = 0;
      }
      for (i = 0;i < ll.length; i++) {
        l[i] += ll[i];
      }
      return this;
    },
    doubleM: function() {
      var i, carry = 0, tmp, r = this.radix, m = this.radixMask, l = this.limbs;
      for (i = 0;i < l.length; i++) {
        tmp = l[i];
        tmp = tmp + tmp + carry;
        l[i] = tmp & m;
        carry = tmp >> r;
      }
      if (carry) {
        l.push(carry);
      }
      return this;
    },
    halveM: function() {
      var i, carry = 0, tmp, r = this.radix, l = this.limbs;
      for (i = l.length - 1;i >= 0; i--) {
        tmp = l[i];
        l[i] = tmp + carry >> 1;
        carry = (tmp & 1) << r;
      }
      if (!l[l.length - 1]) {
        l.pop();
      }
      return this;
    },
    subM: function(that) {
      if (typeof that !== "object") {
        that = new this._class(that);
      }
      var i, l = this.limbs, ll = that.limbs;
      for (i = l.length;i < ll.length; i++) {
        l[i] = 0;
      }
      for (i = 0;i < ll.length; i++) {
        l[i] -= ll[i];
      }
      return this;
    },
    mod: function(that) {
      var neg = !this.greaterEquals(new sjcl.bn(0));
      that = new sjcl.bn(that).normalize();
      var out = new sjcl.bn(this).normalize(), ci = 0;
      if (neg)
        out = new sjcl.bn(0).subM(out).normalize();
      for (;out.greaterEquals(that); ci++) {
        that.doubleM();
      }
      if (neg)
        out = that.sub(out).normalize();
      for (;ci > 0; ci--) {
        that.halveM();
        if (out.greaterEquals(that)) {
          out.subM(that).normalize();
        }
      }
      return out.trim();
    },
    inverseMod: function(p) {
      var a = new sjcl.bn(1), b = new sjcl.bn(0), x = new sjcl.bn(this), y = new sjcl.bn(p), tmp, i, nz = 1;
      if (!(p.limbs[0] & 1)) {
        throw new sjcl.exception.invalid("inverseMod: p must be odd");
      }
      do {
        if (x.limbs[0] & 1) {
          if (!x.greaterEquals(y)) {
            tmp = x;
            x = y;
            y = tmp;
            tmp = a;
            a = b;
            b = tmp;
          }
          x.subM(y);
          x.normalize();
          if (!a.greaterEquals(b)) {
            a.addM(p);
          }
          a.subM(b);
        }
        x.halveM();
        if (a.limbs[0] & 1) {
          a.addM(p);
        }
        a.normalize();
        a.halveM();
        for (i = nz = 0;i < x.limbs.length; i++) {
          nz |= x.limbs[i];
        }
      } while (nz);
      if (!y.equals(1)) {
        throw new sjcl.exception.invalid("inverseMod: p and x must be relatively prime");
      }
      return b;
    },
    add: function(that) {
      return this.copy().addM(that);
    },
    sub: function(that) {
      return this.copy().subM(that);
    },
    mul: function(that) {
      if (typeof that === "number") {
        that = new this._class(that);
      } else {
        that.normalize();
      }
      this.normalize();
      var i, j, a = this.limbs, b = that.limbs, al = a.length, bl = b.length, out = new this._class, c = out.limbs, ai, ii = this.maxMul;
      for (i = 0;i < this.limbs.length + that.limbs.length + 1; i++) {
        c[i] = 0;
      }
      for (i = 0;i < al; i++) {
        ai = a[i];
        for (j = 0;j < bl; j++) {
          c[i + j] += ai * b[j];
        }
        if (!--ii) {
          ii = this.maxMul;
          out.cnormalize();
        }
      }
      return out.cnormalize().reduce();
    },
    square: function() {
      return this.mul(this);
    },
    power: function(l) {
      l = new sjcl.bn(l).normalize().trim().limbs;
      var i, j, out = new this._class(1), pow = this;
      for (i = 0;i < l.length; i++) {
        for (j = 0;j < this.radix; j++) {
          if (l[i] & 1 << j) {
            out = out.mul(pow);
          }
          if (i == l.length - 1 && l[i] >> j + 1 == 0) {
            break;
          }
          pow = pow.square();
        }
      }
      return out;
    },
    mulmod: function(that, N) {
      return this.mod(N).mul(that.mod(N)).mod(N);
    },
    powermod: function(x, N) {
      x = new sjcl.bn(x);
      N = new sjcl.bn(N);
      if ((N.limbs[0] & 1) == 1) {
        var montOut = this.montpowermod(x, N);
        if (montOut != false) {
          return montOut;
        }
      }
      var i, j, l = x.normalize().trim().limbs, out = new this._class(1), pow = this;
      for (i = 0;i < l.length; i++) {
        for (j = 0;j < this.radix; j++) {
          if (l[i] & 1 << j) {
            out = out.mulmod(pow, N);
          }
          if (i == l.length - 1 && l[i] >> j + 1 == 0) {
            break;
          }
          pow = pow.mulmod(pow, N);
        }
      }
      return out;
    },
    montpowermod: function(x, N) {
      x = new sjcl.bn(x).normalize().trim();
      N = new sjcl.bn(N);
      var i, j, radix = this.radix, out = new this._class(1), pow = this.copy();
      var R, s, wind, bitsize = x.bitLength();
      R = new sjcl.bn({
        limbs: N.copy().normalize().trim().limbs.map(function() {
          return 0;
        })
      });
      for (s = this.radix;s > 0; s--) {
        if ((N.limbs[N.limbs.length - 1] >> s & 1) == 1) {
          R.limbs[R.limbs.length - 1] = 1 << s;
          break;
        }
      }
      if (bitsize == 0) {
        return this;
      } else if (bitsize < 18) {
        wind = 1;
      } else if (bitsize < 48) {
        wind = 3;
      } else if (bitsize < 144) {
        wind = 4;
      } else if (bitsize < 768) {
        wind = 5;
      } else {
        wind = 6;
      }
      var RR = R.copy(), NN = N.copy(), RP = new sjcl.bn(1), NP = new sjcl.bn(0), RT = R.copy();
      while (RT.greaterEquals(1)) {
        RT.halveM();
        if ((RP.limbs[0] & 1) == 0) {
          RP.halveM();
          NP.halveM();
        } else {
          RP.addM(NN);
          RP.halveM();
          NP.halveM();
          NP.addM(RR);
        }
      }
      RP = RP.normalize();
      NP = NP.normalize();
      RR.doubleM();
      var R2 = RR.mulmod(RR, N);
      if (!RR.mul(RP).sub(N.mul(NP)).equals(1)) {
        return false;
      }
      var montIn = function(c) {
        return montMul(c, R2);
      }, montMul = function(a, b) {
        var k, ab, right, abBar, mask = (1 << s + 1) - 1;
        ab = a.mul(b);
        right = ab.mul(NP);
        right.limbs = right.limbs.slice(0, R.limbs.length);
        if (right.limbs.length == R.limbs.length) {
          right.limbs[R.limbs.length - 1] &= mask;
        }
        right = right.mul(N);
        abBar = ab.add(right).normalize().trim();
        abBar.limbs = abBar.limbs.slice(R.limbs.length - 1);
        for (k = 0;k < abBar.limbs.length; k++) {
          if (k > 0) {
            abBar.limbs[k - 1] |= (abBar.limbs[k] & mask) << radix - s - 1;
          }
          abBar.limbs[k] = abBar.limbs[k] >> s + 1;
        }
        if (abBar.greaterEquals(N)) {
          abBar.subM(N);
        }
        return abBar;
      }, montOut = function(c) {
        return montMul(c, 1);
      };
      pow = montIn(pow);
      out = montIn(out);
      var h, precomp = {}, cap = (1 << wind - 1) - 1;
      precomp[1] = pow.copy();
      precomp[2] = montMul(pow, pow);
      for (h = 1;h <= cap; h++) {
        precomp[2 * h + 1] = montMul(precomp[2 * h - 1], precomp[2]);
      }
      var getBit = function(exp, i2) {
        var off = i2 % exp.radix;
        return (exp.limbs[Math.floor(i2 / exp.radix)] & 1 << off) >> off;
      };
      for (i = x.bitLength() - 1;i >= 0; ) {
        if (getBit(x, i) == 0) {
          out = montMul(out, out);
          i = i - 1;
        } else {
          var l = i - wind + 1;
          while (getBit(x, l) == 0) {
            l++;
          }
          var indx = 0;
          for (j = l;j <= i; j++) {
            indx += getBit(x, j) << j - l;
            out = montMul(out, out);
          }
          out = montMul(out, precomp[indx]);
          i = l - 1;
        }
      }
      return montOut(out);
    },
    trim: function() {
      var l = this.limbs, p;
      do {
        p = l.pop();
      } while (l.length && p === 0);
      l.push(p);
      return this;
    },
    reduce: function() {
      return this;
    },
    fullReduce: function() {
      return this.normalize();
    },
    normalize: function() {
      var carry = 0, i, pv = this.placeVal, ipv = this.ipv, l, m, limbs = this.limbs, ll = limbs.length, mask = this.radixMask;
      for (i = 0;i < ll || carry !== 0 && carry !== -1; i++) {
        l = (limbs[i] || 0) + carry;
        m = limbs[i] = l & mask;
        carry = (l - m) * ipv;
      }
      if (carry === -1) {
        limbs[i - 1] -= pv;
      }
      this.trim();
      return this;
    },
    cnormalize: function() {
      var carry = 0, i, ipv = this.ipv, l, m, limbs = this.limbs, ll = limbs.length, mask = this.radixMask;
      for (i = 0;i < ll - 1; i++) {
        l = limbs[i] + carry;
        m = limbs[i] = l & mask;
        carry = (l - m) * ipv;
      }
      limbs[i] += carry;
      return this;
    },
    toBits: function(len) {
      this.fullReduce();
      len = len || this.exponent || this.bitLength();
      var i = Math.floor((len - 1) / 24), w = sjcl.bitArray, e = (len + 7 & -8) % this.radix || this.radix, out = [w.partial(e, this.getLimb(i))];
      for (i--;i >= 0; i--) {
        out = w.concat(out, [w.partial(Math.min(this.radix, len), this.getLimb(i))]);
        len -= this.radix;
      }
      return out;
    },
    bitLength: function() {
      this.fullReduce();
      var out = this.radix * (this.limbs.length - 1), b = this.limbs[this.limbs.length - 1];
      for (;b; b >>>= 1) {
        out++;
      }
      return out + 7 & -8;
    }
  };
  sjcl.bn.fromBits = function(bits) {
    var Class = this, out = new Class, words = [], w = sjcl.bitArray, t = this.prototype, l = Math.min(this.bitLength || 4294967296, w.bitLength(bits)), e = l % t.radix || t.radix;
    words[0] = w.extract(bits, 0, e);
    for (;e < l; e += t.radix) {
      words.unshift(w.extract(bits, e, t.radix));
    }
    out.limbs = words;
    return out;
  };
  sjcl.bn.prototype.ipv = 1 / (sjcl.bn.prototype.placeVal = Math.pow(2, sjcl.bn.prototype.radix));
  sjcl.bn.prototype.radixMask = (1 << sjcl.bn.prototype.radix) - 1;
  sjcl.bn.pseudoMersennePrime = function(exponent, coeff) {
    function p(it) {
      this.initWith(it);
    }
    var ppr = p.prototype = new sjcl.bn, i, tmp, mo;
    mo = ppr.modOffset = Math.ceil(tmp = exponent / ppr.radix);
    ppr.exponent = exponent;
    ppr.offset = [];
    ppr.factor = [];
    ppr.minOffset = mo;
    ppr.fullMask = 0;
    ppr.fullOffset = [];
    ppr.fullFactor = [];
    ppr.modulus = p.modulus = new sjcl.bn(Math.pow(2, exponent));
    ppr.fullMask = 0 | -Math.pow(2, exponent % ppr.radix);
    for (i = 0;i < coeff.length; i++) {
      ppr.offset[i] = Math.floor(coeff[i][0] / ppr.radix - tmp);
      ppr.fullOffset[i] = Math.floor(coeff[i][0] / ppr.radix) - mo + 1;
      ppr.factor[i] = coeff[i][1] * Math.pow(1 / 2, exponent - coeff[i][0] + ppr.offset[i] * ppr.radix);
      ppr.fullFactor[i] = coeff[i][1] * Math.pow(1 / 2, exponent - coeff[i][0] + ppr.fullOffset[i] * ppr.radix);
      ppr.modulus.addM(new sjcl.bn(Math.pow(2, coeff[i][0]) * coeff[i][1]));
      ppr.minOffset = Math.min(ppr.minOffset, -ppr.offset[i]);
    }
    ppr._class = p;
    ppr.modulus.cnormalize();
    ppr.reduce = function() {
      var i2, k, l, mo2 = this.modOffset, limbs = this.limbs, off = this.offset, ol = this.offset.length, fac = this.factor, ll;
      i2 = this.minOffset;
      while (limbs.length > mo2) {
        l = limbs.pop();
        ll = limbs.length;
        for (k = 0;k < ol; k++) {
          limbs[ll + off[k]] -= fac[k] * l;
        }
        i2--;
        if (!i2) {
          limbs.push(0);
          this.cnormalize();
          i2 = this.minOffset;
        }
      }
      this.cnormalize();
      return this;
    };
    ppr._strongReduce = ppr.fullMask === -1 ? ppr.reduce : function() {
      var limbs = this.limbs, i2 = limbs.length - 1, k, l;
      this.reduce();
      if (i2 === this.modOffset - 1) {
        l = limbs[i2] & this.fullMask;
        limbs[i2] -= l;
        for (k = 0;k < this.fullOffset.length; k++) {
          limbs[i2 + this.fullOffset[k]] -= this.fullFactor[k] * l;
        }
        this.normalize();
      }
    };
    ppr.fullReduce = function() {
      var greater, i2;
      this._strongReduce();
      this.addM(this.modulus);
      this.addM(this.modulus);
      this.normalize();
      this._strongReduce();
      for (i2 = this.limbs.length;i2 < this.modOffset; i2++) {
        this.limbs[i2] = 0;
      }
      greater = this.greaterEquals(this.modulus);
      for (i2 = 0;i2 < this.limbs.length; i2++) {
        this.limbs[i2] -= this.modulus.limbs[i2] * greater;
      }
      this.cnormalize();
      return this;
    };
    ppr.inverse = function() {
      return this.power(this.modulus.sub(2));
    };
    p.fromBits = sjcl.bn.fromBits;
    return p;
  };
  sbp = sjcl.bn.pseudoMersennePrime;
  sjcl.bn.prime = {
    p127: sbp(127, [[0, -1]]),
    p25519: sbp(255, [[0, -19]]),
    p192k: sbp(192, [[32, -1], [12, -1], [8, -1], [7, -1], [6, -1], [3, -1], [0, -1]]),
    p224k: sbp(224, [[32, -1], [12, -1], [11, -1], [9, -1], [7, -1], [4, -1], [1, -1], [0, -1]]),
    p256k: sbp(256, [[32, -1], [9, -1], [8, -1], [7, -1], [6, -1], [4, -1], [0, -1]]),
    p192: sbp(192, [[0, -1], [64, -1]]),
    p224: sbp(224, [[0, 1], [96, -1]]),
    p256: sbp(256, [[0, -1], [96, 1], [192, 1], [224, -1]]),
    p384: sbp(384, [[0, -1], [32, 1], [96, -1], [128, -1]]),
    p521: sbp(521, [[0, -1]])
  };
  sjcl.bn.random = function(modulus, paranoia) {
    if (typeof modulus !== "object") {
      modulus = new sjcl.bn(modulus);
    }
    var words, i, l = modulus.limbs.length, m = modulus.limbs[l - 1] + 1, out = new sjcl.bn;
    while (true) {
      do {
        words = sjcl.random.randomWords(l, paranoia);
        if (words[l - 1] < 0) {
          words[l - 1] += 4294967296;
        }
      } while (Math.floor(words[l - 1] / m) === Math.floor(4294967296 / m));
      words[l - 1] %= m;
      for (i = 0;i < l - 1; i++) {
        words[i] &= modulus.radixMask;
      }
      out.limbs = words;
      if (!out.greaterEquals(modulus)) {
        return out;
      }
    }
  };
  if (typeof ArrayBuffer === "undefined") {
    (function(globals) {
      globals.ArrayBuffer = function() {};
      globals.DataView = function() {};
    })(null);
  }
  sjcl.codec.arrayBuffer = {
    fromBits: function(arr, padding, padding_count) {
      var out, i, ol, tmp, smallest;
      padding = padding == undefined ? true : padding;
      padding_count = padding_count || 8;
      if (arr.length === 0) {
        return new ArrayBuffer(0);
      }
      ol = sjcl.bitArray.bitLength(arr) / 8;
      if (sjcl.bitArray.bitLength(arr) % 8 !== 0) {
        throw new sjcl.exception.invalid("Invalid bit size, must be divisble by 8 to fit in an arraybuffer correctly");
      }
      if (padding && ol % padding_count !== 0) {
        ol += padding_count - ol % padding_count;
      }
      tmp = new DataView(new ArrayBuffer(arr.length * 4));
      for (i = 0;i < arr.length; i++) {
        tmp.setUint32(i * 4, arr[i] << 32);
      }
      out = new DataView(new ArrayBuffer(ol));
      if (out.byteLength === tmp.byteLength) {
        return tmp.buffer;
      }
      smallest = tmp.byteLength < out.byteLength ? tmp.byteLength : out.byteLength;
      for (i = 0;i < smallest; i++) {
        out.setUint8(i, tmp.getUint8(i));
      }
      return out.buffer;
    },
    toBits: function(buffer) {
      var i, out = [], len, inView, tmp;
      if (buffer.byteLength === 0) {
        return [];
      }
      inView = new DataView(buffer);
      len = inView.byteLength - inView.byteLength % 4;
      for (var i = 0;i < len; i += 4) {
        out.push(inView.getUint32(i));
      }
      if (inView.byteLength % 4 != 0) {
        tmp = new DataView(new ArrayBuffer(4));
        for (var i = 0, l = inView.byteLength % 4;i < l; i++) {
          tmp.setUint8(i + 4 - l, inView.getUint8(len + i));
        }
        out.push(sjcl.bitArray.partial(inView.byteLength % 4 * 8, tmp.getUint32(0)));
      }
      return out;
    },
    hexDumpBuffer: function(buffer) {
      var stringBufferView = new DataView(buffer);
      var string = "";
      var pad = function(n, width) {
        n = n + "";
        return n.length >= width ? n : new Array(width - n.length + 1).join("0") + n;
      };
      for (var i = 0;i < stringBufferView.byteLength; i += 2) {
        if (i % 16 == 0)
          string += `
` + i.toString(16) + "\t";
        string += pad(stringBufferView.getUint16(i).toString(16), 4) + " ";
      }
      if (typeof console === undefined) {
        console = console || { log: function() {} };
      }
      console.log(string.toUpperCase());
    }
  };
  sjcl_default = sjcl;
});

// node_modules/@cloudflare/blindrsa-ts/lib/src/util.js
function assertNever(name, x) {
  throw new Error(`unexpected ${name} identifier: ${x}`);
}
function getHashParams(hash) {
  switch (hash) {
    case "SHA-1":
      return { name: hash, hLen: 20 };
    case "SHA-256":
      return { name: hash, hLen: 32 };
    case "SHA-384":
      return { name: hash, hLen: 48 };
    case "SHA-512":
      return { name: hash, hLen: 64 };
    default:
      assertNever("Hash", hash);
  }
}
function os2ip(bytes) {
  return sjcl_default.bn.fromBits(sjcl_default.codec.bytes.toBits(Array.from(bytes)));
}
function i2osp(num, byteLength) {
  if (Math.ceil(num.bitLength() / 8) > byteLength) {
    throw new Error(`number does not fit in ${byteLength} bytes`);
  }
  const bytes = new Uint8Array(byteLength);
  const unpadded = new Uint8Array(sjcl_default.codec.bytes.fromBits(num.toBits(undefined)));
  bytes.set(unpadded, byteLength - unpadded.length);
  return bytes;
}
function int_to_bytes(num, byteLength) {
  return i2osp(new sjcl_default.bn(num), byteLength);
}
function joinAll(a) {
  let size = 0;
  for (const ai of a) {
    size += ai.length;
  }
  const ret = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const ai of a) {
    ret.set(ai, offset);
    offset += ai.length;
  }
  return ret;
}
function xor(a, b) {
  if (a.length !== b.length || a.length === 0) {
    throw new Error(`arrays of different length: ${a.length} - ${b.length}`);
  }
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  return new Uint8Array(a.length).map(() => ai.next().value ^ bi.next().value);
}
function incCounter(c) {
  c[3]++;
  if (c[3] != 0) {
    return;
  }
  c[2]++;
  if (c[2] != 0) {
    return;
  }
  c[1]++;
  if (c[1] != 0) {
    return;
  }
  c[0]++;
  return;
}
async function mgf1(h, seed, mLen) {
  const n = Math.ceil(mLen / h.hLen);
  if (n > Math.pow(2, 32)) {
    throw new Error("mask too long");
  }
  let T = new Uint8Array;
  const counter = new Uint8Array(4);
  for (let i = 0;i < n; i++) {
    const hash = new Uint8Array(await crypto.subtle.digest(h.name, joinAll([seed, counter]).slice().buffer));
    T = joinAll([T, hash]);
    incCounter(counter);
  }
  return T.subarray(0, mLen);
}
async function emsa_pss_encode(msg, emBits, opts, mgf = mgf1) {
  const { hash, sLen } = opts;
  const hashParams = getHashParams(hash);
  const { hLen } = hashParams;
  const emLen = Math.ceil(emBits / 8);
  const mHash = new Uint8Array(await crypto.subtle.digest(hash, msg.slice().buffer));
  if (emLen < hLen + sLen + 2) {
    throw new Error("encoding error");
  }
  const salt = crypto.getRandomValues(new Uint8Array(sLen));
  const mPrime = joinAll([new Uint8Array(8), mHash, salt]);
  const h = new Uint8Array(await crypto.subtle.digest(hash, mPrime.slice().buffer));
  const ps = new Uint8Array(emLen - sLen - hLen - 2);
  const db = joinAll([ps, Uint8Array.of(1), salt]);
  const dbMask = await mgf(hashParams, h, emLen - hLen - 1);
  const maskedDB = xor(db, dbMask);
  maskedDB[0] &= 255 >> 8 * emLen - emBits;
  const em = joinAll([maskedDB, h, Uint8Array.of(188)]);
  return em;
}
function rsavp1(pkS, s) {
  if (!s.greaterEquals(new sjcl_default.bn(0)) || s.greaterEquals(pkS.n)) {
    throw new Error("signature representative out of range");
  }
  const m = s.powermod(pkS.e, pkS.n);
  return m;
}
function rsasp1(skS, m) {
  if (!m.greaterEquals(new sjcl_default.bn(0)) || m.greaterEquals(skS.n)) {
    throw new Error("signature representative out of range");
  }
  const s = m.powermod(skS.d, skS.n);
  return s;
}
function is_coprime(x, n) {
  try {
    x.inverseMod(n);
  } catch {
    return false;
  }
  return true;
}
function random_integer_uniform(n, kLen) {
  const MAX_NUM_TRIES = 128;
  for (let i = 0;i < MAX_NUM_TRIES; i++) {
    const r = os2ip(crypto.getRandomValues(new Uint8Array(kLen)));
    if (!(r.greaterEquals(n) || r.equals(0))) {
      return r;
    }
  }
  throw new Error("reached maximum tries for random integer generation");
}
function inverseMod(x, p) {
  if (!(p.getLimb(0) & 1)) {
    if (!(x.getLimb(0) & 1)) {
      throw new Error("inverseMod: The given number is not invertible.");
    }
    let [old_r, r] = [BigInt(x.toString()), BigInt(p.toString())];
    let [old_s, s] = [BigInt(1), BigInt(0)];
    while (r !== 0n) {
      const quotient = old_r / r;
      [old_r, r] = [r, old_r - quotient * r];
      [old_s, s] = [s, old_s - quotient * s];
    }
    if (old_r > 1n) {
      throw new Error("inverseMod: The given number is not invertible.");
    }
    if (old_s < 0n) {
      old_s += BigInt(p.toString());
    }
    return new sjcl_default.bn(old_s.toString(16));
  }
  return x.inverseMod(p);
}
async function rsaRawBlingSign(privateKey, blindMsg) {
  if (privateKey.algorithm.name !== NATIVE_SUPPORT_NAME) {
    privateKey = await crypto.subtle.importKey("pkcs8", await crypto.subtle.exportKey("pkcs8", privateKey), { ...privateKey.algorithm, name: NATIVE_SUPPORT_NAME }, privateKey.extractable, privateKey.usages);
  }
  const signature = await crypto.subtle.sign({ name: privateKey.algorithm.name }, privateKey, blindMsg.slice().buffer);
  return new Uint8Array(signature);
}
function prepare_sjcl_random_generator() {
  const source = "crypto.getRandomValues";
  while (!sjcl_default.random.isReady(undefined)) {
    sjcl_default.random.addEntropy(Array.from(crypto.getRandomValues(new Uint32Array(4))), 128, source);
  }
}
var NATIVE_SUPPORT_NAME = "RSA-RAW";
var init_util = __esm(() => {
  init_sjcl();
});

// node_modules/@cloudflare/blindrsa-ts/lib/src/blindrsa.js
class BlindRSA {
  params;
  static NAME = "RSA-PSS";
  constructor(params) {
    this.params = params;
    switch (params.prepareType) {
      case PrepareType.Deterministic:
      case PrepareType.Randomized:
        return;
      default:
        assertNever("PrepareType", params.prepareType);
    }
  }
  toString() {
    const hash = this.params.hash.replace("-", "");
    const pssType = "PSS" + (this.params.saltLength === 0 ? "ZERO" : "");
    const prepare = PrepareType[this.params.prepareType];
    return `RSABSSA-${hash}-${pssType}-${prepare}`;
  }
  prepare(msg) {
    const msg_prefix_len = this.params.prepareType;
    const msg_prefix = crypto.getRandomValues(new Uint8Array(msg_prefix_len));
    return joinAll([msg_prefix, msg]);
  }
  async extractKeyParams(key, type) {
    if (key.type !== type || key.algorithm.name !== BlindRSA.NAME) {
      throw new Error(`key is not ${BlindRSA.NAME}`);
    }
    if (!key.extractable) {
      throw new Error("key is not extractable");
    }
    const { modulusLength: modulusLengthBits, hash: hashFn } = key.algorithm;
    const modulusLengthBytes = Math.ceil(modulusLengthBits / 8);
    const hash = hashFn.name;
    if (hash.toLowerCase() !== this.params.hash.toLowerCase()) {
      throw new Error(`hash is not ${this.params.hash}`);
    }
    const jwkKey = await crypto.subtle.exportKey("jwk", key);
    return { jwkKey, modulusLengthBits, modulusLengthBytes, hash };
  }
  async blind(publicKey, msg) {
    const { jwkKey, modulusLengthBits: modulusLength, modulusLengthBytes: kLen, hash } = await this.extractKeyParams(publicKey, "public");
    if (!jwkKey.n || !jwkKey.e) {
      throw new Error("key has invalid parameters");
    }
    const n = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.n));
    const e = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.e));
    const pk = { e, n };
    const opts = { sLen: this.params.saltLength, hash };
    const encoded_msg = await emsa_pss_encode(msg, modulusLength - 1, opts);
    const m = os2ip(encoded_msg);
    const c = is_coprime(m, n);
    if (!c) {
      throw new Error("invalid input");
    }
    const r = random_integer_uniform(n, kLen);
    let inv;
    try {
      inv = i2osp(r.inverseMod(n), kLen);
    } catch (e2) {
      throw new Error(`blinding error: ${e2.toString()}`);
    }
    const x = rsavp1(pk, r);
    const z = m.mulmod(x, n);
    const blindedMsg = i2osp(z, kLen);
    return { blindedMsg, inv };
  }
  async blindSign(privateKey, blindMsg) {
    if (this.params.supportsRSARAW) {
      return rsaRawBlingSign(privateKey, blindMsg);
    }
    const { jwkKey, modulusLengthBytes: kLen } = await this.extractKeyParams(privateKey, "private");
    if (!jwkKey.n || !jwkKey.d || !jwkKey.e) {
      throw new Error("key has invalid parameters");
    }
    const n = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.n));
    const d = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.d));
    const e = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.e));
    const sk = { n, d };
    const pk = { n, e };
    const m = os2ip(blindMsg);
    const s = rsasp1(sk, m);
    const mp = rsavp1(pk, s);
    if (!m.equals(mp)) {
      throw new Error("signing failure");
    }
    return i2osp(s, kLen);
  }
  async finalize(publicKey, msg, blindSig, inv) {
    const { jwkKey, modulusLengthBytes: kLen } = await this.extractKeyParams(publicKey, "public");
    if (!jwkKey.n) {
      throw new Error("key has invalid parameters");
    }
    const n = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.n));
    if (inv.length != kLen) {
      throw new Error("unexpected input size");
    }
    const rInv = os2ip(inv);
    if (blindSig.length != kLen) {
      throw new Error("unexpected input size");
    }
    const z = os2ip(blindSig);
    const s = z.mulmod(rInv, n);
    const sig = i2osp(s, kLen);
    const algorithm = { name: BlindRSA.NAME, saltLength: this.params.saltLength };
    const ok = await crypto.subtle.verify(algorithm, publicKey, sig.slice().buffer, msg.slice().buffer);
    if (!ok) {
      throw new Error("invalid signature");
    }
    return sig;
  }
  static generateKey(algorithm) {
    return crypto.subtle.generateKey({ ...algorithm, name: BlindRSA.NAME }, true, [
      "sign",
      "verify"
    ]);
  }
  generateKey(algorithm) {
    return BlindRSA.generateKey({ ...algorithm, hash: this.params.hash });
  }
  verify(publicKey, signature, message) {
    return crypto.subtle.verify({ name: BlindRSA.NAME, saltLength: this.params.saltLength }, publicKey, signature.slice().buffer, message.slice().buffer);
  }
}
var PrepareType;
var init_blindrsa = __esm(() => {
  init_sjcl();
  init_util();
  (function(PrepareType2) {
    PrepareType2[PrepareType2["Deterministic"] = 0] = "Deterministic";
    PrepareType2[PrepareType2["Randomized"] = 32] = "Randomized";
  })(PrepareType || (PrepareType = {}));
});

// node_modules/@cloudflare/blindrsa-ts/lib/src/prime.js
function millerRabinTest(n, SEC_PARAM = 20) {
  if (n.equals(1)) {
    return false;
  }
  if (n.equals(2) || n.equals(3)) {
    return true;
  }
  if ((n.getLimb(0) & 1) === 0) {
    return false;
  }
  const nMinusOne = new sjcl_default.bn(n).sub(1).normalize();
  let r = new sjcl_default.bn(nMinusOne);
  let s = 0;
  while ((r.getLimb(0) & 1) === 0) {
    r = r.halveM();
    s++;
  }
  for (let i = 0;i < SEC_PARAM; i++) {
    const a = sjcl_default.bn.random(nMinusOne, SJCL_PARANOIA);
    let y = a.powermod(r, n);
    if (!y.equals(1) && !y.equals(nMinusOne)) {
      let j = 1;
      while (j < s && !y.equals(nMinusOne)) {
        y = y.mulmod(y, n);
        if (y.equals(1)) {
          return false;
        }
        j++;
      }
      if (!y.equals(nMinusOne)) {
        return false;
      }
    }
  }
  return true;
}
function generatePrime(bitLength, NUM_TRIES_PRIMALITY = 20) {
  const MAX_NUM_TRIES = NUM_TRIES_PRIMALITY * bitLength ** 4;
  const twoToN = new sjcl_default.bn(2);
  for (let i2 = 0;i2 < bitLength; i2++) {
    twoToN.doubleM();
  }
  twoToN.normalize();
  let prime;
  let i = 0;
  do {
    prime = sjcl_default.bn.random(twoToN, SJCL_PARANOIA);
    if ((prime.getLimb(0) & 1) == 0) {
      prime = prime.addM(1).normalize();
    }
    i++;
  } while (!millerRabinTest(prime, NUM_TRIES_PRIMALITY) && i < MAX_NUM_TRIES);
  if (i === MAX_NUM_TRIES) {
    throw new Error(`generatePrime reached MAX_NUM_TRIES=${MAX_NUM_TRIES}`);
  }
  return prime;
}
function generateSafePrime(bitLength, NUM_TRIES_PRIMALITY = 20) {
  const MAX_NUM_TRIES = bitLength ** 2;
  const ONE = new sjcl_default.bn(1);
  let prime;
  let i = 0;
  do {
    const q = generatePrime(bitLength - 1, NUM_TRIES_PRIMALITY);
    prime = q.doubleM().addM(ONE).normalize();
    i++;
  } while (!millerRabinTest(prime, NUM_TRIES_PRIMALITY) && i < MAX_NUM_TRIES);
  if (i === MAX_NUM_TRIES) {
    throw new Error(`generateSafePrime reached MAX_NUM_TRIES=${MAX_NUM_TRIES}`);
  }
  return prime;
}
var SJCL_PARANOIA = 6;
var init_prime = __esm(() => {
  init_sjcl();
});

// node_modules/@cloudflare/blindrsa-ts/lib/src/partially_blindrsa.js
class PartiallyBlindRSA {
  params;
  static NAME = "RSA-PSS";
  constructor(params) {
    this.params = params;
    switch (params.prepareType) {
      case PrepareType.Deterministic:
      case PrepareType.Randomized:
        return;
      default:
        assertNever("PrepareType", params.prepareType);
    }
  }
  toString() {
    const hash = this.params.hash.replace("-", "");
    const pssType = "PSS" + (this.params.saltLength === 0 ? "ZERO" : "");
    const prepare = PrepareType[this.params.prepareType];
    return `RSAPBSSA-${hash}-${pssType}-${prepare}`;
  }
  prepare(msg) {
    const msg_prefix_len = this.params.prepareType;
    const msg_prefix = crypto.getRandomValues(new Uint8Array(msg_prefix_len));
    return joinAll([msg_prefix, msg]);
  }
  async extractKeyParams(key, type) {
    if (key.type !== type || key.algorithm.name !== PartiallyBlindRSA.NAME) {
      throw new Error(`key is not ${PartiallyBlindRSA.NAME}`);
    }
    if (!key.extractable) {
      throw new Error("key is not extractable");
    }
    const { modulusLength: modulusLengthBits, hash: hashFn } = key.algorithm;
    const modulusLengthBytes = Math.ceil(modulusLengthBits >> 3);
    const hash = hashFn.name;
    if (hash.toLowerCase() !== this.params.hash.toLowerCase()) {
      throw new Error(`hash is not ${this.params.hash}`);
    }
    const jwkKey = await crypto.subtle.exportKey("jwk", key);
    return { jwkKey, modulusLengthBits, modulusLengthBytes, hash };
  }
  async blind(publicKey, msg, info) {
    const { jwkKey, modulusLengthBits: modulusLength, modulusLengthBytes: kLen, hash } = await this.extractKeyParams(publicKey, "public");
    if (!jwkKey.n || !jwkKey.e) {
      throw new Error("key has invalid parameters");
    }
    const n = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.n));
    const e = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.e));
    const pk = { e, n };
    const msg_prime = joinAll([
      new TextEncoder().encode("msg"),
      int_to_bytes(info.length, 4),
      info,
      msg
    ]);
    const opts = { sLen: this.params.saltLength, hash };
    const encoded_msg = await emsa_pss_encode(msg_prime, modulusLength - 1, opts);
    const m = os2ip(encoded_msg);
    const c = is_coprime(m, n);
    if (!c) {
      throw new Error("invalid input");
    }
    const r = random_integer_uniform(n, kLen);
    let inv;
    try {
      inv = i2osp(r.inverseMod(n), kLen);
    } catch (e2) {
      throw new Error(`blinding error: ${e2.toString()}`);
    }
    const pk_derived = await this.derivePublicKey(pk, info);
    const x = rsavp1(pk_derived, r);
    const z = m.mulmod(x, n);
    const blindedMsg = i2osp(z, kLen);
    return { blindedMsg, inv };
  }
  async blindSign(privateKey, blindMsg, info) {
    const { jwkKey, modulusLengthBytes: kLen } = await this.extractKeyParams(privateKey, "private");
    if (!jwkKey.n || !jwkKey.d || !jwkKey.p || !jwkKey.q) {
      throw new Error("key has invalid parameters");
    }
    const n = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.n));
    const d = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.d));
    const p = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.p));
    const q = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.q));
    const sk = { n, d, p, q };
    const m = os2ip(blindMsg);
    const { secretKey: sk_derived, publicKey: pk_derived } = await this.deriveKeyPair(sk, info);
    let s;
    if (this.params.supportsRSARAW) {
      const { privateKey: privateKey2 } = await PartiallyBlindRSA.bigKeyPairToCryptoKeyPair({ secretKey: sk_derived, publicKey: pk_derived }, {
        modulusLength: kLen * 8,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: this.params.hash
      }, true);
      s = os2ip(await rsaRawBlingSign(privateKey2, blindMsg));
    } else {
      s = rsasp1(sk_derived, m);
    }
    const mp = rsavp1(pk_derived, s);
    if (!m.equals(mp)) {
      throw new Error("signing failure");
    }
    return i2osp(s, kLen);
  }
  async finalize(publicKey, msg, info, blindSig, inv) {
    const { jwkKey, modulusLengthBytes: kLen } = await this.extractKeyParams(publicKey, "public");
    if (!jwkKey.e || !jwkKey.n) {
      throw new Error("key has invalid parameters");
    }
    const e = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.e));
    const n = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.n));
    const pk = { e, n };
    if (inv.length != kLen) {
      throw new Error("unexpected input size");
    }
    const rInv = os2ip(inv);
    if (blindSig.length != kLen) {
      throw new Error("unexpected input size");
    }
    const z = os2ip(blindSig);
    const s = z.mulmod(rInv, n);
    const sig = i2osp(s, kLen);
    const msg_prime = joinAll([
      new TextEncoder().encode("msg"),
      int_to_bytes(info.length, 4),
      info,
      msg
    ]);
    const pk_derived = await this.derivePublicKey(pk, info);
    const pk_derived_key = await crypto.subtle.importKey("jwk", {
      ...jwkKey,
      e: sjcl_default.codec.base64url.fromBits(pk_derived.e.toBits(0)),
      n: sjcl_default.codec.base64url.fromBits(pk_derived.n.toBits(0))
    }, { name: PartiallyBlindRSA.NAME, hash: this.params.hash }, false, ["verify"]);
    const algorithm = { name: PartiallyBlindRSA.NAME, saltLength: this.params.saltLength };
    const ok = await crypto.subtle.verify(algorithm, pk_derived_key, sig.slice().buffer, msg_prime);
    if (!ok) {
      throw new Error("invalid signature");
    }
    return sig;
  }
  static async generateKey(algorithm, generateSafePrimeSync = generateSafePrime) {
    prepare_sjcl_random_generator();
    let p;
    let q;
    do {
      const p_tmp = generateSafePrimeSync(algorithm.modulusLength >> 1);
      const q_tmp = generateSafePrimeSync(algorithm.modulusLength >> 1);
      p = typeof p_tmp === "bigint" ? new sjcl_default.bn(p_tmp.toString(16)) : p_tmp;
      q = typeof q_tmp === "bigint" ? new sjcl_default.bn(q_tmp.toString(16)) : q_tmp;
    } while (p.equals(q));
    const phi = p.sub(1).mul(q.sub(1));
    const e = new sjcl_default.bn("0x" + Array.from(algorithm.publicExponent).map((x) => x.toString(16).padStart(2, "0")).join(""));
    const d = inverseMod(e, phi);
    const n = p.mul(q);
    const sk = { n, p, q, d };
    const pk = { e, n };
    return PartiallyBlindRSA.bigKeyPairToCryptoKeyPair({
      secretKey: sk,
      publicKey: pk
    }, algorithm, true);
  }
  generateKey(algorithm, generateSafePrimeSync = generateSafePrime) {
    return PartiallyBlindRSA.generateKey({ ...algorithm, hash: this.params.hash }, generateSafePrimeSync);
  }
  async verify(publicKey, signature, message, info) {
    const { jwkKey } = await this.extractKeyParams(publicKey, "public");
    if (!jwkKey.e || !jwkKey.n) {
      throw new Error("key has invalid parameters");
    }
    const e = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.e));
    const n = sjcl_default.bn.fromBits(sjcl_default.codec.base64url.toBits(jwkKey.n));
    const pk = { e, n };
    const pk_derived = await this.derivePublicKey(pk, info);
    const pk_derived_key = await crypto.subtle.importKey("jwk", {
      ...jwkKey,
      e: sjcl_default.codec.base64url.fromBits(pk_derived.e.toBits(0)),
      n: sjcl_default.codec.base64url.fromBits(pk_derived.n.toBits(0))
    }, { name: PartiallyBlindRSA.NAME, hash: this.params.hash }, false, ["verify"]);
    const msg_prime = joinAll([
      new TextEncoder().encode("msg"),
      int_to_bytes(info.length, 4),
      info,
      message
    ]);
    return crypto.subtle.verify({ name: PartiallyBlindRSA.NAME, saltLength: this.params.saltLength }, pk_derived_key, signature.slice().buffer, msg_prime);
  }
  async derivePublicKey({ n }, info) {
    const hkdf_input = joinAll([new TextEncoder().encode("key"), info, new Uint8Array([0])]);
    const hkdf_salt = i2osp(n, n.bitLength() >> 3);
    const lambda_len = n.bitLength() >> 4;
    const hkdf_len = lambda_len + 16;
    const expanded_bytes = new Uint8Array(await crypto.subtle.deriveBits({
      name: "HKDF",
      hash: this.params.hash,
      info: new TextEncoder().encode("PBRSA"),
      salt: hkdf_salt.slice().buffer
    }, await crypto.subtle.importKey("raw", hkdf_input, "HKDF", false, ["deriveBits"]), hkdf_len * 8));
    expanded_bytes[0] &= 63;
    expanded_bytes[lambda_len - 1] |= 1;
    const e_prime = os2ip(expanded_bytes.slice(0, lambda_len));
    return { e: e_prime, n };
  }
  async deriveKeyPair(sk, info) {
    const phi = new sjcl_default.bn(sk.p).sub(1).mul(new sjcl_default.bn(sk.q).sub(1));
    const pk_derived = await this.derivePublicKey({ n: sk.n }, info);
    const d_prime = inverseMod(pk_derived.e, phi);
    const sk_derived = { ...sk, d: d_prime };
    return { secretKey: sk_derived, publicKey: pk_derived };
  }
  static async bigKeyPairToCryptoKeyPair({ secretKey, publicKey }, algorithm, extractable) {
    const n = secretKey.n;
    const e = publicKey.e;
    const p = secretKey.p;
    const q = secretKey.q;
    const d = secretKey.d;
    const dp = d.mod(p.sub(1));
    const dq = d.mod(q.sub(1));
    const qi = q.inverseMod(p);
    const sk = await crypto.subtle.importKey("jwk", {
      alg: "PS384",
      ext: extractable,
      key_ops: ["sign"],
      kty: "RSA",
      n: sjcl_default.codec.base64url.fromBits(n.toBits(0)),
      e: sjcl_default.codec.base64url.fromBits(e.toBits(0)),
      p: sjcl_default.codec.base64url.fromBits(p.toBits(0)),
      q: sjcl_default.codec.base64url.fromBits(q.toBits(0)),
      d: sjcl_default.codec.base64url.fromBits(d.toBits(0)),
      dp: sjcl_default.codec.base64url.fromBits(dp.toBits(0)),
      dq: sjcl_default.codec.base64url.fromBits(dq.toBits(0)),
      qi: sjcl_default.codec.base64url.fromBits(qi.toBits(0))
    }, { ...algorithm, name: PartiallyBlindRSA.NAME }, extractable, ["sign"]);
    const pk = await crypto.subtle.importKey("jwk", {
      alg: "PS384",
      ext: extractable,
      key_ops: ["verify"],
      kty: "RSA",
      n: sjcl_default.codec.base64url.fromBits(n.toBits(0)),
      e: sjcl_default.codec.base64url.fromBits(e.toBits(0))
    }, { ...algorithm, name: PartiallyBlindRSA.NAME }, extractable, ["verify"]);
    return { privateKey: sk, publicKey: pk };
  }
}
var init_partially_blindrsa = __esm(() => {
  init_sjcl();
  init_prime();
  init_util();
  init_blindrsa();
});

// node_modules/@cloudflare/blindrsa-ts/lib/src/index.js
var exports_src = {};
__export(exports_src, {
  getSuiteByName: () => getSuiteByName,
  RSAPBSSA: () => RSAPBSSA,
  RSABSSA: () => RSABSSA,
  PartiallyBlindRSA: () => PartiallyBlindRSA,
  Params: () => Params,
  BlindRSA: () => BlindRSA
});
function getSuiteByName(newT, name, params = { supportsRSARAW: false }) {
  for (const suiteParams of Object.values(Params)) {
    if (name.toLowerCase() === suiteParams.name.toLowerCase()) {
      return new newT({ ...suiteParams, ...params });
    }
  }
  throw new Error(`wrong suite name: ${name}`);
}
var Params, RSABSSA, RSAPBSSA;
var init_src = __esm(() => {
  init_blindrsa();
  init_partially_blindrsa();
  Params = {
    RSABSSA_SHA384_PSS_Randomized: {
      name: "RSABSSA-SHA384-PSS-Randomized",
      hash: "SHA-384",
      saltLength: 48,
      prepareType: PrepareType.Randomized
    },
    RSABSSA_SHA384_PSS_Deterministic: {
      name: "RSABSSA-SHA384-PSS-Deterministic",
      hash: "SHA-384",
      saltLength: 48,
      prepareType: PrepareType.Deterministic
    },
    RSABSSA_SHA384_PSSZERO_Randomized: {
      name: "RSABSSA-SHA384-PSSZERO-Randomized",
      hash: "SHA-384",
      saltLength: 0,
      prepareType: PrepareType.Randomized
    },
    RSABSSA_SHA384_PSSZERO_Deterministic: {
      name: "RSABSSA-SHA384-PSSZERO-Deterministic",
      hash: "SHA-384",
      saltLength: 0,
      prepareType: PrepareType.Deterministic
    },
    RSAPBSSA_SHA384_PSS_Randomized: {
      name: "RSAPBSSA-SHA384-PSS-Randomized",
      hash: "SHA-384",
      saltLength: 48,
      prepareType: PrepareType.Randomized
    },
    RSAPBSSA_SHA384_PSS_Deterministic: {
      name: "RSAPBSSA-SHA384-PSS-Deterministic",
      hash: "SHA-384",
      saltLength: 48,
      prepareType: PrepareType.Deterministic
    },
    RSAPBSSA_SHA384_PSSZERO_Randomized: {
      name: "RSAPBSSA-SHA384-PSSZERO-Randomized",
      hash: "SHA-384",
      saltLength: 0,
      prepareType: PrepareType.Randomized
    },
    RSAPBSSA_SHA384_PSSZERO_Deterministic: {
      name: "RSAPBSSA-SHA384-PSSZERO-Deterministic",
      hash: "SHA-384",
      saltLength: 0,
      prepareType: PrepareType.Deterministic
    }
  };
  RSABSSA = {
    SHA384: {
      generateKey: (algorithm) => BlindRSA.generateKey({ ...algorithm, hash: "SHA-384" }),
      PSS: {
        Randomized: (params = { supportsRSARAW: false }) => new BlindRSA({ ...Params.RSABSSA_SHA384_PSS_Randomized, ...params }),
        Deterministic: (params = { supportsRSARAW: false }) => new BlindRSA({ ...Params.RSABSSA_SHA384_PSS_Deterministic, ...params })
      },
      PSSZero: {
        Randomized: (params = { supportsRSARAW: false }) => new BlindRSA({ ...Params.RSABSSA_SHA384_PSSZERO_Randomized, ...params }),
        Deterministic: (params = { supportsRSARAW: false }) => new BlindRSA({ ...Params.RSABSSA_SHA384_PSSZERO_Deterministic, ...params })
      }
    }
  };
  RSAPBSSA = {
    SHA384: {
      generateKey: (algorithm) => PartiallyBlindRSA.generateKey({ ...algorithm, hash: "SHA-384" }),
      PSS: {
        Randomized: (params = { supportsRSARAW: false }) => new PartiallyBlindRSA({ ...Params.RSAPBSSA_SHA384_PSS_Randomized, ...params }),
        Deterministic: (params = { supportsRSARAW: false }) => new PartiallyBlindRSA({ ...Params.RSAPBSSA_SHA384_PSS_Deterministic, ...params })
      },
      PSSZero: {
        Randomized: (params = { supportsRSARAW: false }) => new PartiallyBlindRSA({ ...Params.RSAPBSSA_SHA384_PSSZERO_Randomized, ...params }),
        Deterministic: (params = { supportsRSARAW: false }) => new PartiallyBlindRSA({
          ...Params.RSAPBSSA_SHA384_PSSZERO_Deterministic,
          ...params
        })
      }
    }
  };
});

// packages/private/src/args.ts
class UsageError extends Error {
  name = "UsageError";
}
function parseArgs(argv, spec) {
  const values = new Set(spec.values ?? []);
  const known = new Set(spec.flags ?? []);
  const out = { options: new Map, flags: new Set, positionals: [] };
  for (let i = 0;i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      out.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (values.has(name)) {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || eq < 0 && value.startsWith("--"))
        throw new UsageError(`--${name} needs a value.`);
      if (out.options.has(name))
        throw new UsageError(`--${name} was given twice.`);
      out.options.set(name, value);
    } else if (known.has(name)) {
      if (eq >= 0)
        throw new UsageError(`--${name} does not take a value.`);
      out.flags.add(name);
    } else
      throw new UsageError(`Unknown option --${name}. Run with --help to see the options.`);
  }
  return out;
}
function intOption(name, raw, def, min, max) {
  if (raw === undefined)
    return def;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max)
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max}.`);
  return Number(raw);
}

// packages/private/src/tor.ts
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net2 from "node:net";
import path from "node:path";

// packages/private/src/onion.ts
import { createHash } from "node:crypto";
var BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(s) {
  const out = [];
  let bits = 0;
  let acc = 0;
  for (const ch of s) {
    acc = acc << 5 | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push(acc >> bits & 255);
      acc &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}
function parseOnionAddress(raw) {
  const host = raw.trim().toLowerCase().replace(/^http:\/\//, "").replace(/\/$/, "");
  if (!/^[a-z2-7]{56}\.onion$/.test(host))
    throw new Error("An onion address is 56 base32 characters followed by .onion, with no path or port.");
  const bytes = base32(host.slice(0, 56));
  const key = bytes.subarray(0, 32);
  const checksum = createHash("sha3-256").update(".onion checksum").update(key).update(Uint8Array.of(3)).digest().subarray(0, 2);
  if (bytes[34] !== 3 || !checksum.equals(bytes.subarray(32, 34)))
    throw new Error("That is not a valid version 3 onion address (bad checksum or version). Check it for a typo.");
  return host;
}

// packages/private/src/socks.ts
import net from "node:net";
import tls from "node:tls";

class SocksError extends Error {
  name = "SocksError";
}
var REPLIES = {
  1: "general proxy failure",
  2: "connection not allowed by the proxy",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
  240: "onion service descriptor not found",
  241: "onion service descriptor invalid",
  242: "onion service introduction failed",
  243: "onion service rendezvous failed",
  244: "onion service needs client authorization",
  245: "onion service client authorization is wrong",
  246: "onion service address is invalid",
  247: "onion service introduction timed out"
};

class Reader {
  socket;
  limit;
  chunks = [];
  length = 0;
  received = 0;
  connected = false;
  closed = false;
  failure = null;
  waiting = null;
  handlers;
  constructor(socket, limit, readyEvent = "connect") {
    this.socket = socket;
    this.limit = limit;
    this.handlers = [
      [readyEvent, () => this.wake(() => this.connected = true)],
      [
        "data",
        (d) => this.wake(() => {
          this.chunks.push(d);
          this.length += d.length;
          this.received += d.length;
          if (this.received > this.limit) {
            this.failure ??= new Error("The response is larger than allowed.");
            socket.destroy();
          }
        })
      ],
      ["end", () => this.wake(() => this.closed = true)],
      ["close", () => this.wake(() => this.closed = true)],
      ["error", (e) => this.wake(() => this.failure ??= e)]
    ];
    for (const [event, handler] of this.handlers)
      socket.on(event, handler);
  }
  detach() {
    for (const [event, handler] of this.handlers)
      this.socket.off(event, handler);
    if (this.length > 0)
      throw new SocksError("The proxy sent data before the connection was ready.");
  }
  wake(update) {
    update();
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }
  changed() {
    return new Promise((resolve) => this.waiting = resolve);
  }
  flatten() {
    if (this.chunks.length > 1)
      this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }
  consume(n) {
    const all = this.flatten();
    const out = all.subarray(0, n);
    this.chunks = n < all.length ? [all.subarray(n)] : [];
    this.length -= n;
    return out;
  }
  check(needMore) {
    if (this.failure)
      throw this.failure;
    if (needMore && this.closed)
      throw new Error("The connection closed before the message was complete.");
  }
  async ready() {
    while (!this.connected) {
      this.check(true);
      await this.changed();
    }
  }
  async take(n) {
    while (this.length < n) {
      this.check(true);
      await this.changed();
    }
    return this.consume(n);
  }
  async takeUntil(delimiter, max) {
    const d = Buffer.from(delimiter, "latin1");
    for (;; ) {
      const at = this.flatten().indexOf(d);
      if (at >= 0 && at + d.length <= max)
        return this.consume(at + d.length);
      if (at >= 0 || this.length > max)
        throw new Error("A header or line in the response is too long.");
      this.check(true);
      await this.changed();
    }
  }
  async takeSome(max) {
    while (this.length === 0) {
      this.check(false);
      if (this.closed)
        return Buffer.alloc(0);
      await this.changed();
    }
    return this.consume(Math.min(max, this.length));
  }
  async takeToEnd() {
    while (!this.closed) {
      this.check(false);
      await this.changed();
    }
    this.check(false);
    return this.consume(this.length);
  }
}
var write = (socket, data) => new Promise((resolve, reject) => socket.write(data, (e) => e ? reject(e) : resolve()));
async function tunnel(socket, reader, proxy, host, port) {
  const name = Buffer.from(host, "latin1");
  if (!name.length || name.length > 255 || /[^\x21-\x7e]/.test(host))
    throw new SocksError("The target name cannot be sent to a SOCKS5 proxy.");
  await reader.ready();
  const withAuth = proxy.username !== undefined;
  await write(socket, Uint8Array.from(withAuth ? [5, 2, 0, 2] : [5, 1, 0]));
  const choice = await reader.take(2);
  if (choice[0] !== 5)
    throw new SocksError("The proxy did not answer as a SOCKS5 proxy.");
  if (choice[1] === 2 && withAuth) {
    const user = Buffer.from(proxy.username, "utf8");
    const pass = Buffer.from(proxy.password ?? "", "utf8");
    await write(socket, Buffer.concat([Uint8Array.from([1, user.length]), user, Uint8Array.from([pass.length]), pass]));
    const verdict = await reader.take(2);
    if (verdict[1] !== 0)
      throw new SocksError("The proxy refused the credentials.");
  } else if (choice[1] !== 0) {
    throw new SocksError("The proxy accepts none of the offered authentication methods.");
  }
  await write(socket, Buffer.concat([Uint8Array.from([5, 1, 0, 3, name.length]), name, Uint8Array.from([port >> 8, port & 255])]));
  const reply = await reader.take(4);
  if (reply[0] !== 5)
    throw new SocksError("The proxy did not answer as a SOCKS5 proxy.");
  if (reply[1] !== 0)
    throw new SocksError(`The proxy could not connect: ${REPLIES[reply[1]] ?? `reply code ${reply[1]}`}.`);
  const bound = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await reader.take(1))[0] : -1;
  if (bound < 0)
    throw new SocksError("The proxy sent an address type that was not asked for.");
  await reader.take(bound + 2);
}
var HEAD_MAX = 16 * 1024;
var TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
function headerLine(name, value) {
  if (!TOKEN.test(name) || /[\r\n\0]/.test(value))
    throw new SocksError("A request header is not valid.");
  return `${name}: ${value}\r
`;
}
async function readChunked(reader, max) {
  const parts = [];
  let total = 0;
  for (;; ) {
    const chunk = await nextChunk(reader, max - total);
    if (chunk === null)
      return Buffer.concat(parts);
    total += chunk.length;
    parts.push(chunk);
  }
}
async function nextChunk(reader, room) {
  const line = (await reader.takeUntil(`\r
`, 1024)).toString("latin1");
  const m = /^([0-9a-fA-F]{1,8})(?:;[^\r\n]*)?\r\n$/.exec(line);
  if (!m)
    throw new Error("The response has a malformed chunk.");
  const size = parseInt(m[1], 16);
  if (size === 0) {
    for (;; )
      if ((await reader.takeUntil(`\r
`, 8192)).length === 2)
        return null;
  }
  if (size > room)
    throw new Error("The response is larger than allowed.");
  const data = await reader.take(size);
  if ((await reader.take(2)).toString("latin1") !== `\r
`)
    throw new Error("The response has a malformed chunk.");
  return data;
}
function payloadStream(reader, framing, max, release) {
  let total = 0;
  let left = "length" in framing ? framing.length : 0;
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      release();
    }
  };
  return new ReadableStream({
    async pull(ctl) {
      try {
        let piece;
        if ("chunked" in framing)
          piece = await nextChunk(reader, max - total);
        else if ("length" in framing) {
          piece = left > 0 ? await reader.takeSome(Math.min(left, 65536)) : null;
          if (piece && !piece.length)
            throw new Error("The connection closed before the message was complete.");
          if (piece)
            left -= piece.length;
        } else {
          piece = await reader.takeSome(65536);
          if (!piece.length)
            piece = null;
        }
        if (piece === null) {
          finish();
          ctl.close();
          return;
        }
        total += piece.length;
        if (total > max)
          throw new Error("The response is larger than allowed.");
        ctl.enqueue(new Uint8Array(piece));
      } catch (e) {
        finish();
        ctl.error(e);
      }
    },
    cancel() {
      finish();
    }
  }, { highWaterMark: 0 });
}
function createSocksFetch(proxy, opts) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new SocksError("Only http:// and https:// targets can be reached through the proxy.");
    const method = init.method ?? "GET";
    const body = init.body ?? new Uint8Array(0);
    let head = `${method} ${url.pathname}${url.search} HTTP/1.1\r
Host: ${url.host}\r
`;
    for (const [name, value] of Object.entries(init.headers ?? {}))
      head += headerLine(name, value);
    head += `Content-Length: ${body.length}\r
Connection: close\r
\r
`;
    const secure = url.protocol === "https:";
    const limit = opts.maxResponseBytes + 2 * HEAD_MAX;
    const raw = net.connect({ host: proxy.host, port: proxy.port });
    let socket = raw;
    let reader = new Reader(raw, limit);
    const abort = () => {
      raw.destroy();
      socket.destroy();
    };
    if (init.signal?.aborted)
      abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    let handedOff = false;
    const release = () => {
      init.signal?.removeEventListener("abort", abort);
      raw.destroy();
      socket.destroy();
    };
    try {
      try {
        raw.setNoDelay(true);
        await tunnel(raw, reader, proxy, url.hostname, Number(url.port || (secure ? 443 : 80)));
      } catch (e) {
        throw e instanceof SocksError ? e : new SocksError(`The proxy could not be used: ${e.message}`);
      }
      if (secure) {
        try {
          reader.detach();
          raw.on("error", () => {
            return;
          });
          socket = tls.connect({ ...opts.tls, socket: raw, servername: url.hostname, ALPNProtocols: ["http/1.1"], minVersion: opts.tls?.minVersion ?? "TLSv1.2" });
          reader = new Reader(socket, limit, "secureConnect");
          await reader.ready();
        } catch (e) {
          throw e instanceof SocksError ? e : new SocksError(`A secure connection to ${url.hostname} could not be made: ${e.message}`);
        }
      }
      init.onSent?.();
      await write(socket, Buffer.concat([Buffer.from(head, "latin1"), body]));
      let status = 0;
      let lines = [];
      do {
        const text = (await reader.takeUntil(`\r
\r
`, HEAD_MAX)).toString("latin1");
        lines = text.slice(0, -4).split(`\r
`);
        const m = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines[0]);
        if (!m)
          throw new Error("The response is not HTTP/1.x.");
        status = Number(m[1]);
      } while (status >= 100 && status < 200 && status !== 101);
      if (status < 200 || status > 599)
        throw new Error("The response has an unsupported status.");
      const headers = new Headers;
      const lengths = new Set;
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        const name = colon > 0 ? line.slice(0, colon) : "";
        if (!TOKEN.test(name))
          throw new Error("The response has a malformed header.");
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "content-length")
          lengths.add(value);
        headers.append(name, value);
      }
      const chunkedCoding = /(^|,)\s*chunked\s*$/i.test(headers.get("transfer-encoding") ?? "");
      if (init.stream && !(method === "HEAD" || status === 204 || status === 304)) {
        let framing = { toEnd: true };
        if (chunkedCoding)
          framing = { chunked: true };
        else if (lengths.size) {
          const [only] = [...lengths];
          if (lengths.size !== 1 || !/^\d{1,10}$/.test(only) || Number(only) > opts.maxResponseBytes)
            throw new Error("The response has an invalid Content-Length.");
          framing = { length: Number(only) };
        }
        headers.delete("transfer-encoding");
        headers.delete("content-length");
        handedOff = true;
        return new Response(payloadStream(reader, framing, opts.maxResponseBytes, release), { status, headers });
      }
      let payload;
      if (method === "HEAD" || status === 204 || status === 304)
        payload = Buffer.alloc(0);
      else if (chunkedCoding)
        payload = await readChunked(reader, opts.maxResponseBytes);
      else if (lengths.size) {
        const [only] = [...lengths];
        if (lengths.size !== 1 || !/^\d{1,10}$/.test(only) || Number(only) > opts.maxResponseBytes)
          throw new Error("The response has an invalid Content-Length.");
        payload = await reader.take(Number(only));
      } else
        payload = await reader.takeToEnd();
      headers.delete("transfer-encoding");
      headers.delete("content-length");
      return new Response(payload.length ? Uint8Array.from(payload) : null, { status, headers });
    } catch (e) {
      if (init.signal?.aborted)
        throw init.signal.reason;
      throw e;
    } finally {
      if (!handedOff)
        release();
    }
  };
}

// packages/private/src/tor.ts
var DEFAULT_ROUTER = "https://anyroute.tech";
var DEFAULT_SOCKS = [
  { host: "127.0.0.1", port: 9050, label: "Tor daemon" },
  { host: "127.0.0.1", port: 9150, label: "Tor Browser" }
];

class TorUnavailable extends Error {
  name = "TorUnavailable";
}
var LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i;
function parseHostPort(raw) {
  const m = /^(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/.exec(raw.trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535)
    throw new TorUnavailable(`"${raw}" is not host:port (for example 127.0.0.1:9050).`);
  return { host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]) };
}
function probeSocks(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = net2.connect({ host, port });
    const done = (ok) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => socket.write(Uint8Array.from([5, 1, 0])));
    socket.once("data", (d) => done(d.length >= 2 && d[0] === 5 && d[1] === 0));
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
  });
}
async function detectTor(o = {}) {
  if (o.explicit) {
    const { host, port } = parseHostPort(o.explicit);
    if (!LOOPBACK.test(host) && !o.allowRemote)
      throw new TorUnavailable(`${o.explicit} is not on this machine. The request reaches a SOCKS proxy unencrypted, so a proxy anywhere else can read your prompts and tokens. Use a Tor client on this machine, or pass --allow-remote-socks if you control the network path to it.`);
    if (!await probeSocks(host, port))
      throw new TorUnavailable(`Nothing that speaks SOCKS5 answers at ${o.explicit}. Start Tor there, or leave --socks out to look at 127.0.0.1:9050 and 127.0.0.1:9150.`);
    return { host, port, label: "the SOCKS proxy you gave" };
  }
  const candidates = o.candidates ?? DEFAULT_SOCKS;
  for (const c of candidates)
    if (await probeSocks(c.host, c.port))
      return { ...c };
  throw new TorUnavailable(`Tor is not running: nothing answers on ${candidates.map((c) => `${c.host}:${c.port}`).join(" or ")}. Nothing was sent, and nothing will be sent without Tor.
` + `  Start Tor and run this again:
` + `    macOS:  brew install tor && brew services start tor      (or open Tor Browser and leave it running)
` + `    Linux:  sudo apt install tor && sudo systemctl start tor
` + "  Or point at your own Tor client with --socks host:port.");
}
function torFetch(proxy, o = {}) {
  const inner = (auth) => createSocksFetch({ host: proxy.host, port: proxy.port, ...auth }, { maxResponseBytes: o.maxResponseBytes ?? 64 * 1024 * 1024, tls: o.tls });
  const shared = o.isolate === false ? inner({ username: "ar-" + randomBytes(9).toString("hex"), password: "x" }) : null;
  return (url, init) => (shared ?? inner({ username: "ar-" + randomBytes(9).toString("hex"), password: "x" }))(url, init);
}
function asClientFetch(f, timeoutMs = 90000) {
  return (input, init) => {
    const headers = {};
    new Headers(init?.headers).forEach((v, k) => headers[k] = v);
    const body = init?.body === undefined || init.body === null ? undefined : typeof init.body === "string" ? new TextEncoder().encode(init.body) : init.body;
    return f(String(input), { method: init?.method ?? "GET", headers, body, signal: AbortSignal.timeout(timeoutMs) });
  };
}
function readStatus(json) {
  const data = json?.data;
  if (!data || typeof data !== "object")
    throw new Error("The answer is not a router status.");
  const lane = data.lanes?.unlinkable;
  let onion = null;
  if (typeof data.onion?.address === "string") {
    try {
      onion = parseOnionAddress(data.onion.address);
    } catch {
      onion = null;
    }
  }
  return {
    onion,
    unlinkable: { available: lane?.available === true, via: Array.isArray(lane?.via) ? lane.via.filter((v) => typeof v === "string") : [], models: typeof lane?.models === "number" ? lane.models : null }
  };
}
async function getJson(f, url, timeoutMs) {
  const res = await f(url, { headers: { accept: "application/json", "user-agent": "anyroute-private" }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${url.replace(/^(https?:\/\/[^/]+).*/, "$1")} answered ${res.status}.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The answer is not JSON.");
  }
}
async function fetchRouterStatus(f, router) {
  return readStatus(await getJson(f, `${router.replace(/\/$/, "")}/api/v1/status`, 90000));
}
async function fetchOnionStatus(f, onion, timeoutMs = 120000) {
  return readStatus(await getJson(f, `http://${onion}/api/v1/status`, timeoutMs));
}
async function chooseOnion(o) {
  if (o.given)
    return { onion: parseOnionAddress(o.given), source: "option" };
  const saved = path.join(o.dir, "router.json");
  try {
    const status = await fetchRouterStatus(o.f, o.router);
    if (!status.onion)
      throw new Error("It does not publish an onion address.");
    await fs.mkdir(o.dir, { recursive: true, mode: 448 });
    await fs.writeFile(saved, JSON.stringify({ router: o.router, onion: status.onion, seen_at: new Date().toISOString() }, null, 2) + `
`, { mode: 384 });
    return { onion: status.onion, source: "router" };
  } catch (e) {
    const remembered = await fs.readFile(saved, "utf8").then((t) => JSON.parse(t), () => null);
    if (remembered?.router === o.router && typeof remembered.onion === "string") {
      try {
        return { onion: parseOnionAddress(remembered.onion), source: "saved", note: `Could not ask ${o.router} for its onion address over Tor (${e.message}); using the one saved on ${remembered.seen_at?.slice(0, 10) ?? "an earlier run"}.` };
      } catch {}
    }
    throw new Error(`Could not get ${o.router}'s onion address over Tor: ${e.message} Pass it with --onion <address> (it is in GET /api/v1/status as onion.address, and on the documentation page).`);
  }
}

// src/chain/rpc-redaction.ts
var configured = new Set;
var currentRedactor = (text) => text;
var redactRpcText = (text) => currentRedactor(text);
function redactRpcFields(value) {
  if (!configured.size || value instanceof Date)
    return value;
  if (typeof value === "string")
    return redactRpcText(value);
  if (Array.isArray(value))
    return value.map(redactRpcFields);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [redactRpcText(key), redactRpcFields(field)]));
  return value;
}

// src/lib/errors.ts
class ApiError extends Error {
  status;
  type;
  metadata;
  headers;
  body;
  constructor(status, message, type = "invalid_request", metadata, headers, body) {
    super(redactRpcText(message));
    this.status = status;
    this.type = type;
    this.metadata = metadata;
    this.headers = headers;
    this.body = body;
    this.metadata = redactRpcFields(metadata);
    this.headers = redactRpcFields(headers);
    this.body = redactRpcFields(body);
  }
  toJSON() {
    return redactRpcFields(this.body ?? {
      error: {
        code: this.status,
        message: this.message,
        type: this.type,
        ...this.metadata ? { metadata: this.metadata } : {}
      }
    });
  }
}
function fail(status, message, type = "invalid_request", metadata, headers) {
  throw new ApiError(status, message, type, metadata, headers);
}

// src/anthropic/convert.ts
var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var bad = (message) => fail(400, message, "invalid_request");
var isCustomTool = (t) => t.type === undefined || t.type === null || t.type === "custom";
var safeName = (s) => String(s ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
function textOf(blocks, where) {
  const parts = [];
  for (const [i, b] of blocks.entries()) {
    if (!isObj(b) || b.type !== "text" || typeof b.text !== "string")
      bad(`${where}.${i}: expected a text block.`);
    parts.push(b.text);
  }
  return parts.join(`

`);
}
function systemText(system) {
  if (system == null)
    return "";
  if (typeof system === "string")
    return system;
  if (Array.isArray(system))
    return textOf(system, "system");
  return bad("system: Input should be a string or a list of text blocks.");
}
function imagePart(b, where) {
  const s = b.source;
  if (!isObj(s))
    return bad(`${where}.source: Field required.`);
  if (s.type === "base64") {
    if (typeof s.media_type !== "string" || !/^image\/[\w.+-]+$/.test(s.media_type))
      bad(`${where}.source.media_type: Input should be an image type such as image/png.`);
    if (typeof s.data !== "string" || !s.data)
      bad(`${where}.source.data: Field required.`);
    return { type: "image_url", image_url: { url: `data:${s.media_type};base64,${s.data}` } };
  }
  if (s.type === "url") {
    if (typeof s.url !== "string" || !/^https?:\/\//i.test(s.url))
      bad(`${where}.source.url: Input should be an http(s) URL.`);
    return { type: "image_url", image_url: { url: s.url } };
  }
  return bad(`${where}.source.type: Input should be 'base64' or 'url'.`);
}
function documentPart(b, where) {
  const s = b.source;
  if (isObj(s) && s.type === "text" && typeof s.data === "string")
    return { type: "text", text: s.data };
  if (isObj(s) && s.type === "content" && Array.isArray(s.content) && s.content.every((x) => isObj(x) && x.type === "text"))
    return { type: "text", text: textOf(s.content, `${where}.source.content`) };
  return bad(`${where}: document blocks are supported only with a text source. Extract the text of a PDF before sending it.`);
}
var asContent = (parts) => parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join(`

`) : parts;
function convertMessages(system, messages) {
  if (!Array.isArray(messages) || messages.length === 0)
    bad("messages: Field required. Send at least one message.");
  const out = [];
  const sys = systemText(system);
  if (sys)
    out.push({ role: "system", content: sys });
  for (const [i, m] of messages.entries()) {
    const at = `messages.${i}`;
    if (!isObj(m) || m.role !== "user" && m.role !== "assistant" && m.role !== "system")
      bad(`${at}.role: Input should be 'user' or 'assistant'.`);
    const msg = m;
    const blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : Array.isArray(msg.content) ? msg.content : bad(`${at}.content: Input should be a string or a list of content blocks.`);
    if (msg.role === "system") {
      out.push({ role: "system", content: textOf(blocks, `${at}.content`) });
    } else if (msg.role === "user") {
      const parts = [];
      const tools = [];
      const fromTools = [];
      for (const [j, raw] of blocks.entries()) {
        const where = `${at}.content.${j}`;
        if (!isObj(raw))
          bad(`${where}: Input should be an object.`);
        const b = raw;
        switch (b.type) {
          case "text":
            if (typeof b.text !== "string")
              bad(`${where}.text: Field required.`);
            if (b.text.length)
              parts.push({ type: "text", text: b.text });
            break;
          case "image":
            parts.push(imagePart(b, where));
            break;
          case "document":
            parts.push(documentPart(b, where));
            break;
          case "tool_result": {
            if (typeof b.tool_use_id !== "string" || !b.tool_use_id)
              bad(`${where}.tool_use_id: Field required.`);
            const inner = typeof b.content === "string" ? [{ type: "text", text: b.content }] : Array.isArray(b.content) ? b.content : b.content == null ? [] : bad(`${where}.content: Input should be a string or a list of blocks.`);
            const texts = [];
            for (const [k, ib] of inner.entries()) {
              if (isObj(ib) && ib.type === "text" && typeof ib.text === "string")
                texts.push(ib.text);
              else if (isObj(ib) && ib.type === "image")
                fromTools.push(imagePart(ib, `${where}.content.${k}`));
              else if (isObj(ib) && ib.type === "tool_reference" && typeof ib.tool_name === "string")
                texts.push(`[tool available: ${ib.tool_name}]`);
              else
                bad(`${where}.content.${k}: a tool result may contain text and image blocks.`);
            }
            tools.push({ role: "tool", tool_call_id: b.tool_use_id, content: texts.join(`
`) });
            break;
          }
          case "thinking":
          case "redacted_thinking":
            break;
          default:
            bad(`${where}.type: '${safeName(b.type)}' blocks are not supported in a user message.`);
        }
      }
      out.push(...tools);
      const all = [...fromTools, ...parts];
      if (all.length)
        out.push({ role: "user", content: asContent(all) });
      else if (!tools.length)
        out.push({ role: "user", content: "" });
    } else {
      const texts = [];
      const calls = [];
      for (const [j, raw] of blocks.entries()) {
        const where = `${at}.content.${j}`;
        if (!isObj(raw))
          bad(`${where}: Input should be an object.`);
        const b = raw;
        switch (b.type) {
          case "text":
            if (typeof b.text !== "string")
              bad(`${where}.text: Field required.`);
            texts.push(b.text);
            break;
          case "tool_use":
            if (typeof b.id !== "string" || !b.id)
              bad(`${where}.id: Field required.`);
            if (typeof b.name !== "string" || !b.name)
              bad(`${where}.name: Field required.`);
            calls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
            break;
          case "thinking":
          case "redacted_thinking":
            break;
          default:
            bad(`${where}.type: '${safeName(b.type)}' blocks are not supported in an assistant message.`);
        }
      }
      const text = texts.join("");
      if (text || calls.length)
        out.push({ role: "assistant", content: text, ...calls.length ? { tool_calls: calls } : {} });
    }
  }
  return out;
}
function convertTools(tools, ignored) {
  if (tools == null)
    return [];
  if (!Array.isArray(tools))
    return bad("tools: Input should be a list.");
  const out = [];
  for (const [i, raw] of tools.entries()) {
    if (!isObj(raw))
      bad(`tools.${i}: Input should be an object.`);
    const t = raw;
    if (!isCustomTool(t)) {
      ignored.add(`tool:${safeName(t.name ?? t.type)}`);
      continue;
    }
    if (typeof t.name !== "string" || !t.name)
      bad(`tools.${i}.name: Field required.`);
    const schema = isObj(t.input_schema) ? { ...t.input_schema } : { type: "object", properties: {} };
    delete schema.$schema;
    out.push({ type: "function", function: { name: t.name, ...typeof t.description === "string" && t.description ? { description: t.description } : {}, parameters: schema } });
  }
  return out;
}
function convertToolChoice(choice, out) {
  if (choice == null)
    return;
  if (!isObj(choice))
    return bad("tool_choice: Input should be an object.");
  switch (choice.type) {
    case "auto":
      out.tool_choice = "auto";
      break;
    case "any":
      out.tool_choice = "required";
      break;
    case "none":
      out.tool_choice = "none";
      break;
    case "tool":
      if (typeof choice.name !== "string" || !choice.name)
        bad("tool_choice.name: Field required when type is 'tool'.");
      out.tool_choice = { type: "function", function: { name: choice.name } };
      break;
    default:
      bad("tool_choice.type: Input should be 'auto', 'any', 'tool' or 'none'.");
  }
  if (choice.disable_parallel_tool_use === true && out.tool_choice !== "none")
    out.parallel_tool_calls = false;
}
var optionalNumber = (body, key, min, max) => {
  const v = body[key];
  if (v == null)
    return;
  if (typeof v !== "number" || !Number.isFinite(v) || min !== undefined && v < min || max !== undefined && v > max)
    bad(`${key}: Input should be a number${min !== undefined ? ` from ${min}` : ""}${max !== undefined ? ` to ${max}` : ""}.`);
  return v;
};
function toChatRequest(body, opts = {}) {
  if (typeof body.model !== "string" || !body.model.trim())
    bad("model: Field required.");
  const ignored = new Set;
  const out = { messages: convertMessages(body.system, body.messages) };
  if (!opts.countOnly) {
    const max = body.max_tokens;
    if (max === undefined || max === null)
      bad("max_tokens: Field required.");
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1)
      bad("max_tokens: Input should be a positive integer.");
    out.max_tokens = max;
    const temperature = optionalNumber(body, "temperature", 0, 2);
    if (temperature !== undefined)
      out.temperature = temperature;
    const topP = optionalNumber(body, "top_p", 0, 1);
    if (topP !== undefined)
      out.top_p = topP;
    const topK = optionalNumber(body, "top_k", 0);
    if (topK !== undefined)
      out.top_k = topK;
    if (body.stop_sequences != null) {
      if (!Array.isArray(body.stop_sequences) || body.stop_sequences.some((s) => typeof s !== "string"))
        bad("stop_sequences: Input should be a list of strings.");
      const stops = body.stop_sequences.filter((s) => s.length);
      if (stops.length)
        out.stop = stops;
    }
    if (body.metadata != null) {
      if (!isObj(body.metadata))
        bad("metadata: Input should be an object.");
      const uid = body.metadata.user_id;
      if (typeof uid === "string" && uid)
        out.user = uid.slice(0, 256);
    }
    if (body.stream != null && typeof body.stream !== "boolean")
      bad("stream: Input should be true or false.");
    if (body.stream === true)
      out.stream = true;
  }
  const tools = convertTools(body.tools, ignored);
  if (tools.length) {
    out.tools = tools;
    convertToolChoice(body.tool_choice, out);
  } else if (body.tool_choice != null) {
    convertToolChoice(body.tool_choice, {});
  }
  if (body.mcp_servers != null && (!Array.isArray(body.mcp_servers) || body.mcp_servers.length))
    bad("mcp_servers: connecting a model to MCP servers is not supported here. Connect the client to AnyRoute's MCP server instead, or pass tools.");
  if (body.container != null)
    bad("container: the code-execution container is not supported.");
  const thinking = body.thinking;
  if (isObj(thinking) && thinking.type && thinking.type !== "disabled")
    ignored.add("thinking");
  if (body.provider != null) {
    if (!isObj(body.provider))
      bad('provider: Input should be an object such as {"lane":"attested"}.');
    out.provider = body.provider;
  }
  if (typeof body.service_tier === "string" && body.service_tier !== "auto")
    ignored.add("service_tier");
  return { body: out, ignored: [...ignored], stops: Array.isArray(out.stop) ? out.stop : [] };
}

// src/router/estimate.ts
function estimatePromptTokens(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    if (typeof m?.content === "string")
      chars += m.content.length;
    else if (Array.isArray(m?.content))
      for (const p of m.content) {
        if (p?.type === "text")
          chars += String(p.text ?? "").length;
        else if (p?.type === "image_url")
          images++;
        else
          chars += JSON.stringify(p ?? "").length;
      }
    chars += 16;
    if (m?.tool_calls)
      chars += JSON.stringify(m.tool_calls).length;
  }
  if (typeof body.prompt === "string")
    chars += body.prompt.length;
  if (body.tools)
    chars += JSON.stringify(body.tools).length;
  if (body.response_format)
    chars += JSON.stringify(body.response_format).length;
  return Math.ceil(chars / 3) + images * 1600 + 8;
}

// src/lib/money.ts
var PICO_PER_USD = 10n ** 12n;
var PICO_PER_USDG_UNIT = 10n ** 6n;
var DECIMAL = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
function usdToPico(value, round = "ceil") {
  if (typeof value === "bigint")
    return value * PICO_PER_USD;
  const text = typeof value === "number" ? numberToPlain(value) : value.trim();
  const m = DECIMAL.exec(text);
  if (!m)
    throw new Error(`Invalid USD amount: ${value}`);
  const [, neg, whole, frac = "", exp] = m;
  let digits = whole + frac;
  let scale = frac.length - Number(exp ?? 0);
  const shift = 12 - scale;
  let result;
  if (shift >= 0) {
    result = BigInt(digits) * 10n ** BigInt(shift);
  } else {
    const div = 10n ** BigInt(-shift);
    const n = BigInt(digits);
    const q = n / div;
    const r = n % div;
    result = r === 0n ? q : round === "ceil" ? neg ? q : q + 1n : neg ? q + 1n : q;
  }
  return neg ? -result : result;
}
function numberToPlain(n) {
  if (!Number.isFinite(n))
    throw new Error(`Invalid USD amount: ${n}`);
  const s = n.toString();
  return s;
}
function mulBps(p, bps, round = "ceil") {
  const n = p * BigInt(bps);
  const q = n / 10000n;
  return round === "ceil" && n % 10000n !== 0n && n > 0n ? q + 1n : q;
}

// packages/private/src/messages.ts
function countMessageTokens(body) {
  return estimatePromptTokens(toChatRequest(body, { countOnly: true }).body);
}
function messageBudget(fetchOverTor, onion) {
  let cached = null;
  let pending = null;
  const rows = async (signal) => {
    if (cached && cached.until > Date.now())
      return cached.rows;
    if (!pending) {
      pending = (async () => {
        const res = await fetchOverTor(`http://${onion}/api/v1/models?lane=unlinkable`, { headers: { accept: "application/json" }, signal });
        if (!res.ok)
          throw new Error(`Model prices could not be read (${res.status}). No tokens were leased.`);
        const json = await res.json();
        if (!Array.isArray(json.data))
          throw new Error("The model directory is invalid.");
        cached = { until: Date.now() + 60000, rows: json.data };
        return json.data;
      })().finally(() => {
        pending = null;
      });
    }
    return pending;
  };
  return async (body, signal) => {
    const conv = toChatRequest(body);
    const input = estimatePromptTokens(conv.body);
    const model = (await rows(signal)).find((row) => row.id === body.model);
    if (!model)
      throw new Error("Choose an attested model from GET /v1/models. No tokens were leased.");
    const price = (field) => {
      const raw = model.pricing?.[field];
      if (typeof raw !== "string" && typeof raw !== "number")
        throw new Error(`Model ${field} price is unavailable. No tokens were leased.`);
      const value = usdToPico(raw);
      if (value < 0n)
        throw new Error("Model prices must be nonnegative.");
      return value;
    };
    const outputPrice = price("completion");
    const reasoningPrice = model.pricing?.internal_reasoning == null ? outputPrice : price("internal_reasoning");
    const base = BigInt(input) * price("prompt") + BigInt(conv.body.max_tokens) * (reasoningPrice > outputPrice ? reasoningPrice : outputPrice) + price("request");
    const royalty = Number(model.royalty_bps ?? 0);
    if (!Number.isInteger(royalty) || royalty < 0 || royalty > 1e4)
      throw new Error("Invalid model royalty.");
    return base + mulBps(base, royalty);
  };
}

// packages/private/src/proxy.ts
import { createHash as createHash2, timingSafeEqual } from "node:crypto";
import http from "node:http";
var LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/i;
var LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
var CALLS = { "/chat/completions": "/api/v1/chat/completions", "/embeddings": "/api/v1/embeddings", "/messages": "/v1/messages" };
var PASSED = /^(content-type|cache-control|retry-after|request-id|x-should-retry|www-authenticate|x-payment-response|x-generation-id|x-receipt-id|inference-id|x-request-id|x-ratelimit-[a-z-]+|x-anyroute-[a-z-]+)$/;
var DEAD_TOKEN = new Set(["token_spent", "invalid_token", "unknown_token_key", "token_key_revoked", "token_epoch_expired"]);
var MAX_TOKEN_TRIES = 3;
var digest = (s) => createHash2("sha256").update(s).digest();

class HttpFailure extends Error {
  status;
  code;
  headers;
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
function send(res, status, body, headers = {}) {
  if (res.headersSent)
    return void res.destroy();
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}
var failure = (res, status, code, message, headers = {}) => send(res, status, { error: { message, type: code, code } }, headers);
async function readBody(req, max) {
  const parts = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > max)
      throw new HttpFailure(413, "request_too_large", `The request is larger than ${Math.floor(max / 1048576)} MiB.`);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
function write2(res, chunk) {
  if (res.destroyed)
    return Promise.resolve(false);
  if (res.write(chunk))
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const drained = () => (res.off("close", closed), resolve(true));
    const closed = () => (res.off("drain", drained), resolve(false));
    res.once("drain", drained);
    res.once("close", closed);
  });
}
async function readSmall(body, max = 262144) {
  if (!body)
    return Buffer.alloc(0);
  const reader = body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done)
        break;
      parts.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {
      return;
    });
  }
  return Buffer.concat(parts).subarray(0, max);
}
function errorType(body) {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    const t = parsed.anyroute?.type ?? parsed.error?.type;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}
function passedHeaders(from, extra = {}) {
  const out = { ...extra };
  from.forEach((value, name) => {
    if (PASSED.test(name.toLowerCase()))
      out[name.toLowerCase()] = value;
  });
  return out;
}
function idleGuard(ms) {
  const ac = new AbortController;
  let timer;
  const poke = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(new Error(`Nothing arrived from the router for ${Math.round(ms / 1000)} seconds.`)), ms);
  };
  poke();
  return { signal: ac.signal, poke, abort: (why) => ac.abort(why), stop: () => clearTimeout(timer) };
}
async function startProxy(o) {
  const log = o.log ?? (() => {
    return;
  });
  const maxConcurrent = o.maxConcurrent ?? 8;
  const idleMs = o.idleTimeoutMs ?? 600000;
  const maxBody = o.maxBodyBytes ?? 32 * 1048576;
  const localKey = o.localKey ? digest(o.localKey) : null;
  const estimateBudget = messageBudget(o.fetch, o.onion);
  let active = 0;
  let port = o.port;
  async function pipe(res, up, guard, extra = {}) {
    const reader = up.body?.getReader();
    res.writeHead(up.status, passedHeaders(up.headers, extra));
    res.flushHeaders();
    if (!reader)
      return void res.end();
    res.once("close", () => void reader.cancel().catch(() => {
      return;
    }));
    try {
      for (;; ) {
        const { done, value } = await reader.read();
        if (done)
          break;
        guard.poke();
        if (!await write2(res, value))
          return;
      }
      res.end();
    } catch {
      res.destroy();
    }
  }
  async function models(res, guard) {
    let up;
    try {
      up = await o.fetch(`http://${o.onion}/api/v1/models?lane=unlinkable`, { headers: { accept: "application/json" }, signal: guard.signal, stream: true });
    } catch (e) {
      throw new HttpFailure(502, "onion_unreachable", `The router's onion service could not be reached through Tor: ${e.message}. Nothing was sent anywhere else.`);
    }
    await pipe(res, up, guard);
  }
  async function call(req, res, upstreamPath, guard) {
    let raw = await readBody(req, maxBody);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error;
    } catch {
      throw new HttpFailure(400, "invalid_json", "The request body must be a JSON object. No token was used.");
    }
    if ("user" in parsed) {
      delete parsed.user;
      raw = Buffer.from(JSON.stringify(parsed));
    }
    const messages = upstreamPath === "/v1/messages";
    if (messages && "metadata" in parsed) {
      delete parsed.metadata;
      raw = Buffer.from(JSON.stringify(parsed));
    }
    let budget = null;
    if (messages) {
      try {
        budget = await estimateBudget(parsed, guard.signal);
      } catch (e) {
        throw new HttpFailure(e.status ?? 400, "messages_budget_unavailable", e.message);
      }
    }
    for (let attempt = 1;; attempt++) {
      const single = budget === null ? await o.store.lease() : null;
      const leases = budget === null ? single ? [single] : null : await o.store.leaseBudget(budget, o.maxTokensPerRequest ?? 16);
      if (!leases)
        throw new HttpFailure(402, "no_tokens", attempt > 1 ? "The router refused the tokens that were tried, and there are no more. Buy more with: anyroute-private buy --key <your API key> --count 20. Nothing was sent without a token." : "There are no blind tokens covering this request within the token cap. Buy more with: anyroute-private buy --key <your API key> --count 20. Nothing was sent, and nothing will be sent without a token.");
      let sent = false;
      let up;
      try {
        up = await o.fetch(`http://${o.onion}${upstreamPath}`, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            authorization: `PrivateToken ${leases.map((l) => `token=${l.token.token}`).join(", ")}`,
            "x-anyroute-lane": "unlinkable"
          },
          body: raw,
          signal: guard.signal,
          stream: true,
          onSent: () => sent = true
        });
      } catch (e) {
        if (!sent) {
          await o.store.settleMany(leases, "returned");
          throw new HttpFailure(502, "onion_unreachable", `The router's onion service could not be reached through Tor: ${e.message}. The token was not used, and nothing was sent anywhere else.`);
        }
        throw new HttpFailure(502, "connection_lost", `The connection through Tor failed after the request was sent: ${e.message}. The token may have been used; it will not be used again.`);
      }
      if (up.ok) {
        await o.store.settleMany(leases, "consumed");
        if (up.headers.get("x-anyroute-lane") !== "unlinkable")
          log(`warning: the router did not confirm lane "unlinkable" in its answer to ${upstreamPath}`);
        const left = (await o.store.summary()).usable;
        log(`${upstreamPath} -> ${up.status} (${left} tokens left)`);
        return pipe(res, up, guard, { "x-anyroute-private-tokens-left": String(left) });
      }
      const body = await readSmall(up.body);
      if (up.status === 401 && DEAD_TOKEN.has(errorType(body) ?? "")) {
        await o.store.settleMany(leases, "consumed");
        log(`${upstreamPath} -> ${up.status} the router refused a token as ${errorType(body)}; trying another`);
        if (attempt < MAX_TOKEN_TRIES)
          continue;
        throw new HttpFailure(502, "tokens_rejected", `The router refused ${MAX_TOKEN_TRIES} tokens in a row as spent or invalid. Check the tokens with: anyroute-private status`);
      }
      await o.store.settleMany(leases, "returned");
      log(`${upstreamPath} -> ${up.status} (token kept)`);
      res.writeHead(up.status, passedHeaders(up.headers, { "content-length": String(body.length) }));
      return void res.end(body);
    }
  }
  const server = http.createServer((req, res) => {
    (async () => {
      const guard = idleGuard(idleMs);
      let counted = false;
      res.once("close", () => {
        guard.stop();
        if (!res.writableEnded)
          guard.abort(new Error("The app closed the connection."));
        if (counted)
          active--;
      });
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const host = LOOPBACK_HOST.exec(req.headers.host ?? "");
        if (!host || host[2] !== String(port))
          throw new HttpFailure(403, "forbidden_host", "This proxy answers only requests addressed to 127.0.0.1 or localhost.");
        const origin = req.headers.origin;
        if (origin !== undefined && !LOOPBACK_ORIGIN.test(origin))
          throw new HttpFailure(403, "forbidden_origin", "This proxy does not answer requests from web pages.");
        if (localKey) {
          const given = /^Bearer[ \t]+(\S.*)$/i.exec(req.headers.authorization ?? "")?.[1] ?? (typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "");
          if (!timingSafeEqual(digest(given), localKey))
            throw new HttpFailure(401, "invalid_local_key", "This proxy was started with --local-key: send it as the API key (Authorization: Bearer).");
        }
        const route = url.pathname.replace(/^\/v1(?=\/|$)/, "").replace(/\/+$/, "") || "/";
        if (route === "/health" || route === "/")
          return send(res, 200, { ok: true, service: "anyroute-private", tokens_left: (await o.store.summary()).usable });
        if (route === "/messages/count_tokens") {
          if (req.method !== "POST")
            throw new HttpFailure(405, "method_not_allowed", "Use POST.", { allow: "POST" });
          try {
            return send(res, 200, { input_tokens: countMessageTokens(JSON.parse((await readBody(req, maxBody)).toString("utf8"))) });
          } catch (e) {
            if (e instanceof HttpFailure)
              throw e;
            throw new HttpFailure(400, "invalid_request", "Invalid Messages count request.");
          }
        }
        const upstream = CALLS[route];
        const isModels = route === "/models";
        if (!upstream && !isModels)
          throw new HttpFailure(404, "unsupported_endpoint", "This proxy serves POST /v1/chat/completions, POST /v1/embeddings, POST /v1/messages, POST /v1/messages/count_tokens and GET /v1/models.");
        if (isModels ? req.method !== "GET" : req.method !== "POST")
          throw new HttpFailure(405, "method_not_allowed", isModels ? "Use GET." : "Use POST.", { allow: isModels ? "GET" : "POST" });
        if (active >= maxConcurrent)
          throw new HttpFailure(429, "too_many_calls", `${maxConcurrent} calls are already in flight; try again in a moment.`, { "retry-after": "2" });
        active++;
        counted = true;
        if (isModels)
          await models(res, guard);
        else
          await call(req, res, upstream, guard);
      } catch (e) {
        if (e instanceof HttpFailure)
          failure(res, e.status, e.code, e.message, e.headers);
        else if (!res.headersSent)
          failure(res, 500, "internal_error", `The proxy failed: ${e.message}`);
        else
          res.destroy();
      }
    })();
  });
  server.headersTimeout = 30000;
  await new Promise((resolve, reject) => {
    server.once("error", (e) => reject(e.code === "EADDRINUSE" ? new Error(`Port ${o.port} is already in use. Pick another with --port.`) : e));
    server.listen(o.port, "127.0.0.1", () => resolve());
  });
  port = server.address().port;
  return {
    port,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    })
  };
}

// packages/client/src/bytes.ts
var enc = new TextEncoder;
var dec = new TextDecoder;
var utf8 = (s) => enc.encode(s);
function bytesToHex(b) {
  let out = "";
  for (let i = 0;i < b.length; i++)
    out += b[i].toString(16).padStart(2, "0");
  return out;
}
function hexToBytes(hex) {
  const clean = hex.replace(/^0x/i, "");
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean))
    throw new Error("invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0;i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function base64ToBytes(text) {
  const t = text.trim();
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(t))
    throw new Error("invalid base64");
  const std = t.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const padded = std + "=".repeat((4 - std.length % 4) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0;i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(b) {
  let bin = "";
  for (let i = 0;i < b.length; i += 32768)
    bin += String.fromCharCode(...b.subarray(i, i + 32768));
  return btoa(bin);
}
var bytesToBase64Url = (b) => bytesToBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
var randomBytes2 = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// packages/client/src/hash.ts
var subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s)
    throw new Error("WebCrypto (crypto.subtle) is not available in this runtime");
  return s;
};
var asBuffer = (b) => b;
async function sha256(data) {
  return new Uint8Array(await subtle().digest("SHA-256", asBuffer(typeof data === "string" ? utf8(data) : data)));
}
var MASK = (1n << 64n) - 1n;

// packages/client/src/blind.ts
var TOKEN_TYPE = 2;
var NK = 256;
var NONCE_LEN = 32;
var DIGEST_LEN = 32;
var KEY_ID_LEN = 32;
async function suite() {
  let mod;
  try {
    mod = await Promise.resolve().then(() => (init_src(), exports_src));
  } catch {
    throw new Error("Blind tokens need the optional dependency @cloudflare/blindrsa-ts (npm install @cloudflare/blindrsa-ts@0.4.6).");
  }
  return mod.RSABSSA.SHA384.PSS.Deterministic();
}
var u16 = (n) => Uint8Array.of(n >> 8 & 255, n & 255);
var cat = concatBytes;
function readTlv(buf, at) {
  if (at + 2 > buf.length)
    throw new Error("truncated DER");
  const tag = buf[at];
  let len = buf[at + 1];
  let p = at + 2;
  if (len & 128) {
    const n = len & 127;
    if (n < 1 || n > 3 || p + n > buf.length)
      throw new Error("unsupported DER length");
    len = 0;
    for (let i = 0;i < n; i++)
      len = len * 256 + buf[p + i];
    p += n;
  }
  if (p + len > buf.length)
    throw new Error("truncated DER");
  return { tag, body: buf.subarray(p, p + len), end: p + len };
}
var PSS_ALGORITHM_IDENTIFIER = hexToBytes("303d06092a864886f70d01010a3030a00d300b0609608648016503040202a11a301806092a864886f70d010108300b0609608648016503040202a203020130");
function parseIssuerSpki(spki) {
  const outer = readTlv(spki, 0);
  if (outer.tag !== 48 || outer.end !== spki.length)
    throw new Error("invalid SPKI");
  const body = outer.body;
  const alg = PSS_ALGORITHM_IDENTIFIER;
  if (body.length < alg.length || !alg.every((v, i) => body[i] === v))
    throw new Error("SPKI is not RSASSA-PSS with SHA-384, MGF1-SHA-384 and a 48-byte salt");
  const bits = readTlv(body, alg.length);
  if (bits.tag !== 3 || bits.end !== body.length || bits.body[0] !== 0)
    throw new Error("invalid SPKI bit string");
  const seq = readTlv(bits.body, 1);
  if (seq.tag !== 48 || seq.end !== bits.body.length)
    throw new Error("invalid RSAPublicKey");
  const nInt = readTlv(seq.body, 0);
  const eInt = readTlv(seq.body, nInt.end);
  if (nInt.tag !== 2 || eInt.tag !== 2 || eInt.end !== seq.body.length)
    throw new Error("invalid RSAPublicKey");
  const strip = (b) => b.length > 1 && b[0] === 0 ? b.subarray(1) : b;
  const n = strip(nInt.body);
  if (n.length !== NK)
    throw new Error("modulus must be 2048 bits");
  return { n, e: strip(eInt.body) };
}
var tokenKeyId = async (spki) => bytesToHex(await sha256(spki));
async function importIssuerPublicKey(spki) {
  const { n, e } = parseIssuerSpki(spki);
  return crypto.subtle.importKey("jwk", { kty: "RSA", n: bytesToBase64Url(n), e: bytesToBase64Url(e), alg: "PS384", ext: true }, { name: "RSA-PSS", hash: "SHA-384" }, true, ["verify"]);
}
function tokenInput(nonce, digest2, keyId) {
  if (nonce.length !== NONCE_LEN || digest2.length !== DIGEST_LEN || keyId.length !== KEY_ID_LEN)
    throw new Error("invalid token input");
  return cat(u16(TOKEN_TYPE), nonce, digest2, keyId);
}
async function fetchDirectory(baseUrl, fetchImpl = fetch) {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/v1/blind/keys`);
  if (!res.ok)
    throw new Error(`GET /api/v1/blind/keys failed with ${res.status}`);
  return (await res.json()).data;
}
function issuingKey(dir, denomination) {
  const k = dir.keys.find((x) => x.denomination === denomination && x.status === "issuing");
  if (!k)
    throw new Error(`no key is issuing ${denomination}-unit tokens right now`);
  return k;
}
async function blindTokens(key, challengeDigestHex, count) {
  const spki = base64ToBytes(key.token_key);
  if (await tokenKeyId(spki) !== key.token_key_id)
    throw new Error("issuer key does not match its token_key_id");
  const pk = await importIssuerPublicKey(spki);
  const s = await suite();
  const out = [];
  for (let i = 0;i < count; i++) {
    const input = tokenInput(randomBytes2(32), hexToBytes(challengeDigestHex), hexToBytes(key.token_key_id));
    const { blindedMsg, inv } = await s.blind(pk, input);
    out.push({ keyId: key.token_key_id, input, blindedMsg, inv });
  }
  return out;
}
async function finalizeTokens(key, pending, signatures) {
  if (signatures.length !== pending.length)
    throw new Error("signature count does not match the request");
  const pk = await importIssuerPublicKey(base64ToBytes(key.token_key));
  const s = await suite();
  const tokens = [];
  for (const [i, p] of pending.entries()) {
    const authenticator = await s.finalize(pk, p.input, base64ToBytes(signatures[i]), p.inv);
    tokens.push(bytesToBase64Url(cat(p.input, authenticator)));
  }
  return tokens;
}

// packages/private/src/purchase.ts
class PurchaseError extends Error {
  name = "PurchaseError";
}
var scrub = (text, apiKey) => text.split(apiKey).join("[key]").slice(0, 300);
async function purchase(o) {
  const log = o.log ?? (() => {
    return;
  });
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const base = o.baseUrl.replace(/\/$/, "");
  const dir = await fetchDirectory(base, o.fetch);
  let key;
  try {
    key = issuingKey(dir, o.denomination);
  } catch {
    const open = dir.keys.filter((k) => k.status === "issuing").map((k) => k.denomination);
    throw new PurchaseError(`The router is not issuing ${o.denomination}-unit tokens right now.${open.length ? ` It is issuing: ${[...new Set(open)].join(", ")}.` : ""}`);
  }
  const batch = Math.max(1, Math.min(dir.max_batch, 256));
  let done = 0;
  let cost = 0;
  while (done < o.count) {
    const n = Math.min(batch, o.count - done);
    const pending = await blindTokens(key, dir.challenge_digest, n);
    const request = {
      method: "POST",
      headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ token_key_id: key.token_key_id, blinded_msgs: pending.map((p) => bytesToBase64Url(p.blindedMsg)) })
    };
    let json;
    let status = 0;
    for (let attempt = 1;; attempt++) {
      try {
        const res = await o.fetch(`${base}/api/v1/blind/purchase`, request);
        status = res.status;
        json = await res.json().catch(() => {
          return;
        });
        if (res.status !== 502 && res.status !== 503 && res.status !== 504)
          break;
      } catch (e) {
        if (attempt >= (o.attempts ?? 3))
          throw new PurchaseError(`The connection failed while buying: ${e.message}. Batches that finished are saved. The last one may have been charged without its tokens reaching you; check the credits on your key before buying again.`);
      }
      if (attempt >= (o.attempts ?? 3))
        break;
      await sleep(2000 * attempt);
    }
    if (status !== 200 || !json?.data)
      throw new PurchaseError(`The router refused the purchase (${status}): ${scrub(json?.error?.message ?? "no reason given", o.apiKey)}`);
    const tokens = await finalizeTokens(key, pending, json.data.signatures);
    const now = new Date().toISOString();
    const stored = tokens.map((token) => ({ token, key_id: key.token_key_id, denomination: key.denomination, epoch: key.epoch, value_usd: key.value_usd, redeem_until: key.redeem_until, bought_at: now }));
    await o.store.add(stored);
    done += n;
    cost += Number(json.data.cost_usd) || 0;
    log(`Bought ${done} of ${o.count}.`);
  }
  return { count: done, costUsd: cost.toFixed(4), denomination: key.denomination, valueUsd: key.value_usd, redeemUntil: key.redeem_until };
}

// packages/private/src/selection.ts
function selectTokens(tokens, budget, cap) {
  const groups = new Map;
  for (const token of tokens) {
    const value = usdToPico(token.value_usd, "floor");
    if (value <= 0n)
      throw new Error("Token face values must be positive.");
    const group = groups.get(value) ?? [];
    group.push(token);
    groups.set(value, group);
  }
  let states = new Map([[0n, []]]);
  let best = null;
  for (const [value, group] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const next = new Map(states);
    for (const [sum, chosen] of states) {
      for (let n = 1;n <= Math.min(group.length, cap - chosen.length); n++) {
        const total = sum + value * BigInt(n);
        const picked = [...chosen, ...group.slice(0, n)];
        if (total >= budget) {
          if (!best || total < best.value || total === best.value && picked.length < best.tokens.length)
            best = { value: total, tokens: picked };
          break;
        }
        const old = next.get(total);
        if (!old || picked.length < old.length)
          next.set(total, picked);
      }
    }
    if (next.size > 200000)
      throw new Error("Too many distinct token values to select a set. Use tokens from fewer issuer epochs.");
    states = next;
  }
  return best?.tokens ?? null;
}

// packages/private/src/store.ts
import { randomBytes as randomBytes3, randomInt } from "node:crypto";
import fs2 from "node:fs/promises";
import os from "node:os";
import path2 from "node:path";

class StoreError extends Error {
  name = "StoreError";
}
var stateDir = (env = process.env) => env.ANYROUTE_HOME?.trim() || path2.join(os.homedir(), ".anyroute");
var EMPTY = () => ({ version: 1, tokens: [], unconfirmed: [] });
var posix = process.platform !== "win32";
var EXPIRY_MARGIN_MS = 60000;
function validToken(t) {
  const o = t;
  return !!o && typeof o.token === "string" && /^[A-Za-z0-9_-]{300,}$/.test(o.token) && typeof o.key_id === "string" && Number.isInteger(o.denomination) && Number.isInteger(o.epoch) && typeof o.value_usd === "string" && typeof o.redeem_until === "string" && !Number.isNaN(Date.parse(o.redeem_until)) && typeof o.bought_at === "string";
}

class TokenStore {
  dir;
  warn;
  file;
  lockFile;
  queue = Promise.resolve();
  constructor(dir, warn = () => {
    return;
  }) {
    this.dir = dir;
    this.warn = warn;
    this.file = path2.join(dir, "tokens.json");
    this.lockFile = path2.join(dir, "tokens.lock");
  }
  async load() {
    let text;
    try {
      text = await fs2.readFile(this.file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT")
        return EMPTY();
      throw new StoreError(`Cannot read ${this.file}: ${e.message}`);
    }
    if (posix) {
      const { mode } = await fs2.stat(this.file);
      if (mode & 63) {
        await fs2.chmod(this.file, 384);
        this.warn(`${this.file} was readable by other users; it is now mode 0600.`);
      }
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new StoreError(`${this.file} is not valid JSON. It was left as it is; move it aside to start a new one.`);
    }
    if (doc.version !== 1 || !Array.isArray(doc.tokens) || !Array.isArray(doc.unconfirmed) || !doc.tokens.every(validToken) || !doc.unconfirmed.every(validToken))
      throw new StoreError(`${this.file} is not a token file this version understands. It was left as it is.`);
    return doc;
  }
  async save(doc) {
    await fs2.mkdir(this.dir, { recursive: true, mode: 448 });
    const tmp = path2.join(this.dir, `.tokens.${process.pid}.${randomBytes3(6).toString("hex")}.tmp`);
    try {
      await fs2.writeFile(tmp, JSON.stringify(doc, null, 2) + `
`, { mode: 384 });
      if (posix)
        await fs2.chmod(tmp, 384);
      await fs2.rename(tmp, this.file);
    } catch (e) {
      await fs2.rm(tmp, { force: true });
      throw new StoreError(`Cannot write ${this.file}: ${e.message}`);
    }
  }
  locked(fn) {
    const run = async () => {
      await fs2.mkdir(this.dir, { recursive: true, mode: 448 });
      const release = await this.acquire();
      try {
        const { doc, result } = fn(await this.load());
        if (doc)
          await this.save(doc);
        return result;
      } finally {
        await release();
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {
      return;
    });
    return next;
  }
  async acquire() {
    const deadline = Date.now() + 1e4;
    for (;; ) {
      try {
        const handle = await fs2.open(this.lockFile, "wx", 384);
        await handle.close();
        return () => fs2.rm(this.lockFile, { force: true });
      } catch (e) {
        if (e.code !== "EEXIST")
          throw new StoreError(`Cannot lock ${this.file}: ${e.message}`);
      }
      const age = await fs2.stat(this.lockFile).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > 15000)
        await fs2.rm(this.lockFile, { force: true });
      else if (Date.now() > deadline)
        throw new StoreError(`${this.file} is in use by another anyroute-private process.`);
      else
        await new Promise((r) => setTimeout(r, 15 + Math.random() * 30));
    }
  }
  add(tokens, now = new Date) {
    return this.locked((doc) => ({
      doc: { ...doc, tokens: [...doc.tokens.filter((t) => Date.parse(t.redeem_until) > now.getTime()), ...tokens] },
      result: undefined
    }));
  }
  lease(now = new Date) {
    return this.locked((doc) => {
      const usable = doc.tokens.filter((t) => Date.parse(t.redeem_until) > now.getTime() + EXPIRY_MARGIN_MS);
      if (!usable.length)
        return { result: null };
      const soonest = Math.min(...usable.map((t) => Date.parse(t.redeem_until)));
      const pool = usable.filter((t) => Date.parse(t.redeem_until) === soonest);
      const picked = pool[randomInt(pool.length)];
      return {
        doc: { ...doc, tokens: doc.tokens.filter((t) => t !== picked), unconfirmed: [...doc.unconfirmed, { ...picked, sent_at: now.toISOString() }] },
        result: { token: picked }
      };
    });
  }
  leaseBudget(budget, cap = 16, now = new Date) {
    return this.locked((doc) => {
      const usable = doc.tokens.filter((t) => Date.parse(t.redeem_until) > now.getTime() + EXPIRY_MARGIN_MS);
      const picked = selectTokens(usable, budget, cap);
      if (!picked)
        return { result: null };
      const ids = new Set(picked.map((t) => t.token));
      if (ids.size !== picked.length)
        throw new StoreError("The token store contains duplicate credentials.");
      return {
        doc: { ...doc, tokens: doc.tokens.filter((t) => !ids.has(t.token)), unconfirmed: [...doc.unconfirmed, ...picked.map((t) => ({ ...t, sent_at: now.toISOString() }))] },
        result: picked.map((token) => ({ token }))
      };
    });
  }
  settleMany(leases, outcome) {
    return this.locked((doc) => {
      const ids = new Set(leases.map((l) => l.token.token));
      const held = doc.unconfirmed.filter((t) => ids.has(t.token));
      return {
        doc: { ...doc, unconfirmed: doc.unconfirmed.filter((t) => !ids.has(t.token)), tokens: outcome === "returned" ? [...held.map(({ sent_at: _, ...t }) => t), ...doc.tokens] : doc.tokens },
        result: undefined
      };
    });
  }
  settle(lease, outcome) {
    return this.locked((doc) => {
      const held = doc.unconfirmed.find((t) => t.token === lease.token.token);
      if (!held)
        return { result: undefined };
      const { sent_at: _sent, ...token } = held;
      return {
        doc: { ...doc, unconfirmed: doc.unconfirmed.filter((t) => t !== held), tokens: outcome === "returned" ? [token, ...doc.tokens] : doc.tokens },
        result: undefined
      };
    });
  }
  async summary(now = new Date) {
    const doc = await this.load();
    const live = doc.tokens.filter((t) => Date.parse(t.redeem_until) > now.getTime() + EXPIRY_MARGIN_MS);
    const byDenomination = {};
    for (const t of live)
      byDenomination[t.denomination] = (byDenomination[t.denomination] ?? 0) + 1;
    const next = live.length ? new Date(Math.min(...live.map((t) => Date.parse(t.redeem_until)))).toISOString() : null;
    const micro = live.reduce((sum, t) => sum + Math.round(Number(t.value_usd) * 1e6), 0);
    return { usable: live.length, expired: doc.tokens.length - live.length, unconfirmed: doc.unconfirmed.length, byDenomination, nextExpiry: next, valueUsd: (micro / 1e6).toFixed(4) };
  }
}

// packages/private/src/version.ts
var VERSION = "0.1.0";

// packages/private/src/cli.ts
var USAGE = `anyroute-private ${VERSION}: make any OpenAI-compatible app private in one command.

A local proxy that sends every call to AnyRoute over Tor, on the unlinkable lane, paid with blind tokens.
The router still reads each prompt. What it does not learn is who sent it and who paid.

Usage
  anyroute-private buy --key <API key> --count <n> [--denomination 10000]
  anyroute-private start [--port 8788]
  anyroute-private status [--json]

Commands
  buy      Buy blind tokens with an API key that has credits, over Tor. Saved to ~/.anyroute/tokens.json (mode 0600).
           Each call spends its token payment; remainders are forfeited. Tokens expire at the end of the router's redemption window (one to two weeks).
  start    Serve an OpenAI-compatible API on 127.0.0.1. Refuses to start unless Tor is reachable. Never uses the clearnet.
  status   Show whether Tor and the onion service answer, whether the lane is available, and how many tokens are left.

Options
  --socks <host:port>     Your Tor client's SOCKS5 port. Default: 127.0.0.1:9050 (Tor daemon), then 127.0.0.1:9150 (Tor Browser).
  --onion <address>       The router's onion address. Default: asked from the router over Tor (and saved).
  --router <url>          The router's public name, used only to ask for its onion address. Default: ${DEFAULT_ROUTER}
  --allow-remote-socks    Allow a SOCKS port that is not on this machine (the request reaches it unencrypted).
  buy:    --key <API key> (or ANYROUTE_API_KEY), --count <1-1000>, --denomination <1000|10000|100000> (default 10000),
          --clearnet to buy without Tor (the router then sees your network address; the tokens stay unlinkable)
  start:  --port <n> (default 8788), --local-key <secret> (require it as the app's API key), --shared-circuit (reuse one Tor
          circuit instead of one per call), --max-concurrent <n> (default 8), --max-tokens-per-request <n> (default 16), --timeout <seconds> (default 600), --quiet
  status: --json

Environment  ANYROUTE_API_KEY, ANYROUTE_HOME (default ~/.anyroute), ANYROUTE_SOCKS, ANYROUTE_ONION, ANYROUTE_ROUTER
`;
var COMMON = { values: ["socks", "onion", "router"], flags: ["allow-remote-socks", "help", "version"] };
var SPECS = {
  buy: { values: [...COMMON.values, "key", "count", "denomination"], flags: [...COMMON.flags, "clearnet"] },
  start: { values: [...COMMON.values, "port", "local-key", "max-concurrent", "max-tokens-per-request", "timeout"], flags: [...COMMON.flags, "shared-circuit", "quiet"] },
  status: { values: [...COMMON.values], flags: [...COMMON.flags, "json"] }
};
function usd(value) {
  const s = Number(value).toFixed(6).replace(/0+$/, "");
  return "$" + (s.endsWith(".") ? s + "00" : /\.\d$/.test(s) ? s + "0" : s);
}
function howToUse(port, localKey = false) {
  const base = `http://127.0.0.1:${port}/v1`;
  return [
    "Point an app at it:",
    "  OpenAI SDKs and most tools:",
    `    export OPENAI_BASE_URL=${base}`,
    `    export OPENAI_API_KEY=${localKey ? "<your --local-key>" : "anyroute-private"}   # ${localKey ? "the proxy checks it and never forwards it" : "any non-empty value; the proxy discards it"}`,
    `  Cursor: Settings > Models > Override OpenAI Base URL: ${base} (API key: any value).`,
    "    Cursor may send requests from its own servers, which cannot reach an address on this machine and would see your",
    "    prompts. Check that your version calls the API from your computer before relying on it.",
    "  Claude Code and the Anthropic SDKs:",
    `    export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`,
    `    export ANTHROPIC_API_KEY=${localKey ? "<your --local-key>" : "anyroute-private"}`,
    "    unset ANTHROPIC_AUTH_TOKEN",
    "    export ANTHROPIC_MODEL='<attested model id from /v1/models>'",
    "    export ANTHROPIC_DEFAULT_HAIKU_MODEL='<attested model id from /v1/models>'",
    `  Models on this lane: curl ${base}/models`
  ].join(`
`);
}
function laneText(s) {
  return s.unlinkable.available ? `available over ${s.unlinkable.via.join(" and ") || "an unnamed path"}${s.unlinkable.models != null ? `, ${s.unlinkable.models} models` : ""}` : "not available";
}
async function runCli(argv, io, hooks = {}) {
  try {
    const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
    if (argv.includes("--version") || argv.includes("-v") || command === "version")
      return io.out(VERSION + `
`), 0;
    if (argv.length === 0 || command === "help" || argv.includes("--help") || argv.includes("-h"))
      return io.out(USAGE), 0;
    if (command === undefined)
      throw new UsageError("Say what to do: buy, start or status. Run with --help for the options.");
    const spec = SPECS[command];
    if (!spec)
      throw new UsageError(`Unknown command "${command}". Commands: buy, start, status.`);
    const args = parseArgs(argv.slice(1), spec);
    if (args.positionals.length)
      throw new UsageError(`Unexpected argument "${args.positionals[0]}".`);
    const env = io.env;
    const dir = stateDir(env);
    const explicitSocks = args.options.get("socks") ?? env.ANYROUTE_SOCKS;
    const run = {
      args,
      io,
      hooks,
      dir,
      store: new TokenStore(dir, (m) => io.err(`warning: ${m}
`)),
      router: (args.options.get("router") ?? env.ANYROUTE_ROUTER ?? DEFAULT_ROUTER).replace(/\/$/, ""),
      givenOnion: args.options.get("onion") ?? env.ANYROUTE_ONION,
      tor: () => detectTor({ explicit: explicitSocks, allowRemote: args.flags.has("allow-remote-socks"), candidates: hooks.torCandidates })
    };
    if (command === "buy")
      return await buy(run, env);
    if (command === "start")
      return await start(run);
    return await status(run);
  } catch (e) {
    if (e instanceof UsageError)
      io.err(`${e.message}
`);
    else if (e instanceof TorUnavailable || e instanceof PurchaseError || e instanceof StoreError)
      io.err(`${e.message}
`);
    else
      io.err(`${e.message}
`);
    return e instanceof UsageError ? 2 : 1;
  }
}
async function buy(r, env) {
  const { args, io } = r;
  const apiKey = (args.options.get("key") ?? env.ANYROUTE_API_KEY ?? "").trim();
  if (!/^sk-ar-v1-[0-9a-f]{64}$/.test(apiKey))
    throw new UsageError("Give the API key to pay with: --key sk-ar-v1-… (or set ANYROUTE_API_KEY). It needs credits.");
  const count = intOption("count", args.options.get("count"), 0, 1, 1000);
  if (!count)
    throw new UsageError("Say how many tokens to buy: --count 20");
  const denomination = intOption("denomination", args.options.get("denomination"), 1e4, 1000, 1e5);
  if (![1000, 1e4, 1e5].includes(denomination))
    throw new UsageError("--denomination must be 1000, 10000 or 100000.");
  let baseUrl;
  let fetchImpl;
  if (args.flags.has("clearnet")) {
    io.err(`Buying without Tor: the router will see your network address with this purchase. The tokens you get stay unlinkable to it.
`);
    baseUrl = r.router;
    const direct = io.directFetch;
    if (!direct)
      throw new UsageError("--clearnet is not available in this environment.");
    fetchImpl = direct;
  } else {
    const proxy = await r.tor();
    const f = torFetch(proxy);
    io.err(`Tor found at ${proxy.host}:${proxy.port} (${proxy.label}).
`);
    const choice = await chooseOnion({ given: r.givenOnion, router: r.router, f, dir: r.dir });
    if (choice.note)
      io.err(`warning: ${choice.note}
`);
    baseUrl = `http://${choice.onion}`;
    fetchImpl = asClientFetch(f, 180000);
  }
  io.err(`Buying ${count} token${count === 1 ? "" : "s"} of ${denomination} units. The first call over Tor can take a minute.
`);
  const bought = await purchase({ fetch: fetchImpl, baseUrl, apiKey, denomination, count, store: r.store, log: (l) => io.err(l + `
`) });
  const left = await r.store.summary();
  io.out(`Bought ${bought.count} tokens of ${bought.denomination} units (${usd(bought.valueUsd)} each, ${usd(bought.costUsd)} in total).
`);
  io.out(`Saved in ${r.store.file} (mode 0600). Usable tokens: ${left.usable}.
`);
  io.out(`These tokens can be spent until ${bought.redeemUntil.slice(0, 16).replace("T", " ")} UTC; after that they are worth nothing, so buy what you will use soon.
`);
  io.out(`A call forfeits the rest of its token payment; Messages calls can use several tokens. Next: anyroute-private start
`);
  return 0;
}
async function status(r) {
  const { args, io } = r;
  const summary = await r.store.summary();
  const report = {
    tokens: { usable: summary.usable, expired: summary.expired, unconfirmed: summary.unconfirmed, by_denomination: summary.byDenomination, next_expiry: summary.nextExpiry, value_usd: summary.valueUsd }
  };
  let ok = summary.usable > 0;
  let proxy = null;
  let lane = null;
  try {
    proxy = await r.tor();
    report.tor = { reachable: true, socks: `${proxy.host}:${proxy.port}`, kind: proxy.label };
  } catch (e) {
    if (!(e instanceof TorUnavailable))
      throw e;
    ok = false;
    report.tor = { reachable: false, detail: e.message.split(`
`)[0] };
  }
  if (proxy) {
    const f = torFetch(proxy);
    let onion = null;
    try {
      const choice = await chooseOnion({ given: r.givenOnion, router: r.router, f, dir: r.dir });
      onion = choice.onion;
      if (choice.note)
        io.err(`warning: ${choice.note}
`);
      const started = Date.now();
      lane = await fetchOnionStatus(f, onion);
      report.onion = { address: onion, reachable: true, seconds: Math.round((Date.now() - started) / 100) / 10 };
      report.unlinkable_lane = { available: lane.unlinkable.available, via: lane.unlinkable.via, models: lane.unlinkable.models };
      if (!lane.unlinkable.available || !lane.unlinkable.via.includes("onion"))
        ok = false;
    } catch (e) {
      ok = false;
      report.onion = { address: onion, reachable: false, detail: e.message };
    }
  }
  report.ready = ok;
  if (args.flags.has("json")) {
    io.out(JSON.stringify(report, null, 2) + `
`);
    return ok ? 0 : 1;
  }
  const line = (label, text) => io.out(`${label.padEnd(18)}${text}
`);
  const t = report.tor;
  line("Tor:", t.reachable ? `reachable at ${t.socks} (${t.kind})` : `NOT reachable. ${t.detail}`);
  if (proxy) {
    const o = report.onion;
    line("Onion service:", o.reachable ? `${o.address} answers (${o.seconds} s)` : `${o.address ?? "address unknown"}: NOT reachable. ${o.detail}`);
    if (lane)
      line("Unlinkable lane:", laneText(lane));
  }
  const byDenomination = Object.entries(summary.byDenomination).map(([d, n]) => `${n} x ${d} units`).join(", ");
  line("Blind tokens:", `${summary.usable} usable${summary.usable ? ` (${byDenomination}; ${usd(summary.valueUsd)} of face value)` : ""}${summary.expired ? `, ${summary.expired} expired` : ""}${summary.unconfirmed ? `, ${summary.unconfirmed} sent without an answer (they may have been spent; they are not used again)` : ""}`);
  if (summary.usable === 0)
    io.out(`  Buy some with: anyroute-private buy --key <your API key> --count 20
`);
  if (summary.nextExpiry)
    io.out(`  The soonest expiry is ${summary.nextExpiry.slice(0, 16).replace("T", " ")} UTC.
`);
  return ok ? 0 : 1;
}
async function start(r) {
  const { args, io, hooks } = r;
  const port = intOption("port", args.options.get("port"), 8788, 0, 65535);
  const maxConcurrent = intOption("max-concurrent", args.options.get("max-concurrent"), 8, 1, 64);
  const timeout = intOption("timeout", args.options.get("timeout"), 600, 10, 86400);
  const localKey = args.options.get("local-key");
  if (localKey !== undefined && localKey.length < 8)
    throw new UsageError("--local-key must be at least 8 characters.");
  const shared = args.flags.has("shared-circuit");
  const proxy = await r.tor();
  io.err(`Tor found at ${proxy.host}:${proxy.port} (${proxy.label}). Reaching the router's onion service; the first connection can take a minute.
`);
  const bootstrap = torFetch(proxy);
  const choice = await chooseOnion({ given: r.givenOnion, router: r.router, f: bootstrap, dir: r.dir });
  if (choice.note)
    io.err(`warning: ${choice.note}
`);
  let lane;
  try {
    lane = await fetchOnionStatus(bootstrap, choice.onion);
  } catch (e) {
    io.err(`Cannot start: the onion service ${choice.onion} did not answer through Tor: ${e.message}
Nothing was sent anywhere else. Try again in a minute.
`);
    return 1;
  }
  if (!lane.unlinkable.available || !lane.unlinkable.via.includes("onion")) {
    io.err(`Cannot start: the router does not serve the unlinkable lane over Tor right now (${laneText(lane)}). Without it a call could not be made private, so none will be made.
`);
    return 1;
  }
  const summary = await r.store.summary();
  const running = await startProxy({
    port,
    onion: choice.onion,
    fetch: torFetch(proxy, { isolate: !shared }),
    store: r.store,
    localKey,
    maxConcurrent,
    maxTokensPerRequest: intOption("max-tokens-per-request", args.options.get("max-tokens-per-request"), 16, 1, 64),
    idleTimeoutMs: timeout * 1000,
    log: args.flags.has("quiet") ? undefined : (l) => io.err(l + `
`)
  });
  io.out(`anyroute-private is serving on http://127.0.0.1:${running.port} (this machine only)
`);
  io.out(`  Tor:              ${proxy.host}:${proxy.port} (${proxy.label}); ${shared ? "one circuit shared by all calls" : "each call on its own circuit"}
`);
  io.out(`  Router:           ${choice.onion}
`);
  io.out(`  Unlinkable lane:  ${laneText(lane)}
`);
  io.out(`  Blind tokens:     ${summary.usable} usable${summary.usable === 0 ? "   (none: buy some with: anyroute-private buy --key <your API key> --count 20)" : ""}

`);
  io.out(howToUse(running.port, localKey !== undefined) + `

`);
  io.out(`The router reads each prompt to answer it, and the model provider receives it. What stays hidden is who sent it (Tor) and who paid (blind tokens).
`);
  io.out(`Press Ctrl-C to stop.
`);
  hooks.onStarted?.(running.port);
  await new Promise((resolve) => {
    if (hooks.stop) {
      if (hooks.stop.aborted)
        resolve();
      else
        hooks.stop.addEventListener("abort", () => resolve(), { once: true });
    } else {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    }
  });
  await running.close();
  io.err(`Stopped.
`);
  return 0;
}

// packages/private/src/main.ts
var directFetch = globalThis.fetch;
globalThis.fetch = () => Promise.reject(new Error("anyroute-private never uses the clearnet: this call was refused."));
var code = await runCli(process.argv.slice(2), {
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
  env: process.env,
  directFetch
});
process.exitCode = code;
setTimeout(() => process.exit(code), 250).unref();
