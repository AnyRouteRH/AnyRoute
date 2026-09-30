package anyroute

import (
	"encoding/binary"
	"math/bits"
)

// Keccak-256 as Ethereum uses it (the original Keccak padding, not the later SHA3-256 padding). The receipt anchor
// leaves and Merkle roots are built with it. It lives here so the SDK needs nothing outside the standard library.

var keccakRC = [24]uint64{
	0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
	0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
	0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
	0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
	0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
	0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
}

// Rotation offsets indexed by x + 5*y.
var keccakRot = [25]int{
	0, 1, 62, 28, 27,
	36, 44, 6, 55, 20,
	3, 10, 43, 25, 39,
	41, 45, 15, 21, 8,
	18, 2, 61, 56, 14,
}

func keccakF1600(a *[25]uint64) {
	var c [5]uint64
	var b [25]uint64
	for round := 0; round < 24; round++ {
		for x := 0; x < 5; x++ {
			c[x] = a[x] ^ a[x+5] ^ a[x+10] ^ a[x+15] ^ a[x+20]
		}
		for x := 0; x < 5; x++ {
			d := c[(x+4)%5] ^ bits.RotateLeft64(c[(x+1)%5], 1)
			for y := 0; y < 25; y += 5 {
				a[y+x] ^= d
			}
		}
		for x := 0; x < 5; x++ {
			for y := 0; y < 5; y++ {
				b[y+5*((2*x+3*y)%5)] = bits.RotateLeft64(a[x+5*y], keccakRot[x+5*y])
			}
		}
		for y := 0; y < 25; y += 5 {
			for x := 0; x < 5; x++ {
				a[y+x] = b[y+x] ^ (^b[y+(x+1)%5] & b[y+(x+2)%5])
			}
		}
		a[0] ^= keccakRC[round]
	}
}

// Keccak256 returns the legacy Keccak-256 digest of the concatenation of parts.
func Keccak256(parts ...[]byte) []byte {
	const rate = 136
	var state [25]uint64
	var block [rate]byte
	fill := 0
	absorb := func() {
		for i := 0; i < rate/8; i++ {
			state[i] ^= binary.LittleEndian.Uint64(block[i*8:])
		}
		keccakF1600(&state)
		fill = 0
	}
	for _, p := range parts {
		for len(p) > 0 {
			n := copy(block[fill:], p)
			fill += n
			p = p[n:]
			if fill == rate {
				absorb()
			}
		}
	}
	for i := fill; i < rate; i++ {
		block[i] = 0
	}
	block[fill] ^= 0x01
	block[rate-1] ^= 0x80
	absorb()
	out := make([]byte, 32)
	for i := 0; i < 4; i++ {
		binary.LittleEndian.PutUint64(out[i*8:], state[i])
	}
	return out
}
