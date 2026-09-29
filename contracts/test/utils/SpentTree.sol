// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICredits} from "../../src/interfaces/ICredits.sol";

/// @notice Test helper for the Credits spent tree: leaves spentLeaf(keyHash, spent) in the order given
/// (callers sort them for a well-formed tree), nodes keccak256(left || right), the odd last node of a
/// level promoted, and root = leafCount == 0 ? 0 : keccak256(abi.encode(treeRoot, leafCount)).
library SpentTree {
    function leaf(bytes32 keyHash, uint256 spent) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(keyHash, spent))));
    }

    function node(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(left, right));
    }

    function commitment(bytes32 treeRoot_, uint256 leafCount) internal pure returns (bytes32) {
        return leafCount == 0 ? bytes32(0) : keccak256(abi.encode(treeRoot_, leafCount));
    }

    function leaves(bytes32[] memory keys, uint256[] memory spents)
        internal
        pure
        returns (bytes32[] memory ls)
    {
        require(keys.length == spents.length, "SpentTree: length");
        ls = new bytes32[](keys.length);
        for (uint256 i; i < keys.length; ++i) {
            ls[i] = leaf(keys[i], spents[i]);
        }
    }

    /// @notice Sorts keys ascending, carrying spents along (insertion sort; test sizes are small).
    function sort(bytes32[] memory keys, uint256[] memory spents) internal pure {
        for (uint256 i = 1; i < keys.length; ++i) {
            bytes32 k = keys[i];
            uint256 s = spents[i];
            uint256 j = i;
            while (j > 0 && keys[j - 1] > k) {
                keys[j] = keys[j - 1];
                spents[j] = spents[j - 1];
                --j;
            }
            keys[j] = k;
            spents[j] = s;
        }
    }

    function treeRoot(bytes32[] memory ls) internal pure returns (bytes32) {
        if (ls.length == 0) return bytes32(0);
        bytes32[] memory level = _copy(ls);
        uint256 n = level.length;
        while (n > 1) {
            uint256 m = (n + 1) / 2;
            for (uint256 i; i < m; ++i) {
                uint256 l = 2 * i;
                level[i] = l + 1 < n ? node(level[l], level[l + 1]) : level[l];
            }
            n = m;
        }
        return level[0];
    }

    function root(bytes32[] memory ls) internal pure returns (bytes32) {
        return commitment(treeRoot(ls), ls.length);
    }

    function root(bytes32[] memory keys, uint256[] memory spents) internal pure returns (bytes32) {
        return root(leaves(keys, spents));
    }

    function proof(bytes32[] memory ls, uint256 index) internal pure returns (bytes32[] memory p) {
        require(index < ls.length, "SpentTree: index");
        bytes32[] memory level = _copy(ls);
        uint256 n = level.length;
        bytes32[] memory buf = new bytes32[](256);
        uint256 len;
        uint256 idx = index;
        while (n > 1) {
            uint256 sib = idx ^ 1;
            if (sib < n) buf[len++] = level[sib];
            uint256 m = (n + 1) / 2;
            for (uint256 i; i < m; ++i) {
                uint256 l = 2 * i;
                level[i] = l + 1 < n ? node(level[l], level[l + 1]) : level[l];
            }
            n = m;
            idx /= 2;
        }
        p = new bytes32[](len);
        for (uint256 i; i < len; ++i) {
            p[i] = buf[i];
        }
    }

    /// @notice Neighbour argument for Credits.finalizeWithdrawalAbsent: the leaf at `index` with its proof.
    function neighbour(bytes32[] memory keys, uint256[] memory spents, uint256 index)
        internal
        pure
        returns (ICredits.SpentLeafProof memory nb)
    {
        nb.keyHash = keys[index];
        nb.cumulativeSpent = spents[index];
        nb.proof = proof(leaves(keys, spents), index);
    }

    /// @notice The argument standing for a sentinel (ignored by the contract).
    function sentinel() internal pure returns (ICredits.SpentLeafProof memory nb) {
        nb.proof = new bytes32[](0);
    }

    /// @notice Gap of a key absent from sorted `keys`: the number of keys below it. Reverts if present.
    function gapOf(bytes32[] memory keys, bytes32 keyHash) internal pure returns (uint256 gap) {
        for (uint256 i; i < keys.length; ++i) {
            require(keys[i] != keyHash, "SpentTree: present");
            if (keys[i] < keyHash) gap = i + 1;
        }
    }

    function _copy(bytes32[] memory a) private pure returns (bytes32[] memory b) {
        b = new bytes32[](a.length);
        for (uint256 i; i < a.length; ++i) {
            b[i] = a[i];
        }
    }
}
