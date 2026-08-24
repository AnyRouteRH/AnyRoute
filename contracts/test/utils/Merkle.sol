// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Test helper building merkle roots / proofs compatible with OpenZeppelin MerkleProof
/// (commutative keccak256 of sorted pairs). Leaves are used as given (hash them yourself). An odd
/// node at the end of a level is promoted unchanged to the next level.
library Merkle {
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @notice Credits leaf: keccak256(bytes.concat(keccak256(abi.encode(keyHash, cumulativeSpent)))).
    function creditsLeaf(bytes32 keyHash, uint256 cumulativeSpent) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(keyHash, cumulativeSpent))));
    }

    /// @notice Receipt leaf: keccak256(bytes.concat(keccak256(data))).
    function doubleHash(bytes memory data) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(data)));
    }

    function getRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        require(leaves.length > 0, "Merkle: no leaves");
        bytes32[] memory level = _copy(leaves);
        uint256 n = level.length;
        while (n > 1) {
            uint256 m = (n + 1) / 2;
            for (uint256 i = 0; i < m; ++i) {
                uint256 l = 2 * i;
                level[i] = l + 1 < n ? hashPair(level[l], level[l + 1]) : level[l];
            }
            n = m;
        }
        return level[0];
    }

    function getProof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory proof) {
        require(index < leaves.length, "Merkle: index");
        bytes32[] memory level = _copy(leaves);
        uint256 n = level.length;
        bytes32[] memory buf = new bytes32[](256);
        uint256 len;
        uint256 idx = index;
        while (n > 1) {
            uint256 sib = idx ^ 1;
            if (sib < n) buf[len++] = level[sib];
            uint256 m = (n + 1) / 2;
            for (uint256 i = 0; i < m; ++i) {
                uint256 l = 2 * i;
                level[i] = l + 1 < n ? hashPair(level[l], level[l + 1]) : level[l];
            }
            n = m;
            idx /= 2;
        }
        proof = new bytes32[](len);
        for (uint256 i = 0; i < len; ++i) {
            proof[i] = buf[i];
        }
    }

    function _copy(bytes32[] memory a) private pure returns (bytes32[] memory b) {
        b = new bytes32[](a.length);
        for (uint256 i = 0; i < a.length; ++i) {
            b[i] = a[i];
        }
    }
}
