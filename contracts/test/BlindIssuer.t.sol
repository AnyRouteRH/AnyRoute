// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BlindIssuer} from "../src/BlindIssuer.sol";
import {IBlindIssuer} from "../src/interfaces/IBlindIssuer.sol";

contract BlindIssuerTest is Test {
    BlindIssuer internal bi;
    address internal owner = makeAddr("owner");
    address internal issuer = makeAddr("issuer");
    address internal rando = makeAddr("rando");

    uint64 internal constant EPOCH = 2960;
    uint64 internal constant T0 = 1_790_000_000;
    bytes32 internal constant ID_1K =
        bytes32(hex"1111111111111111111111111111111111111111111111111111111111111111");
    bytes32 internal constant ID_10K =
        bytes32(hex"2222222222222222222222222222222222222222222222222222222222222222");
    bytes32 internal constant ID_100K =
        bytes32(hex"3333333333333333333333333333333333333333333333333333333333333333");
    // keccak256(abi.encode(2960, [1000, 10000, 100000], [ID_1K, ID_10K, ID_100K])), as the router computes it
    // (test/blind-crypto.test.ts asserts the same value from TypeScript).
    bytes32 internal constant ROUTER_COMMITMENT =
        bytes32(hex"3404ddb4c7387d86b25729fe273e10e8b8e1424395772ff9ecd4794262f82e19");

    function setUp() public {
        vm.warp(T0);
        bi = new BlindIssuer(owner, issuer);
    }

    function _denoms() internal pure returns (uint32[] memory d) {
        d = new uint32[](3);
        d[0] = 1000;
        d[1] = 10_000;
        d[2] = 100_000;
    }

    function _ids() internal pure returns (bytes32[] memory k) {
        k = new bytes32[](3);
        k[0] = ID_1K;
        k[1] = ID_10K;
        k[2] = ID_100K;
    }

    function _commit(uint64 epoch) internal {
        vm.prank(issuer);
        bi.commitEpoch(epoch, _denoms(), _ids());
    }

    // --- constructor ---------------------------------------------------------------------------

    function test_constructor() public view {
        assertEq(bi.owner(), owner);
        assertEq(bi.issuer(), issuer);
        assertEq(bi.MAX_DENOMINATIONS(), 8);
    }

    function test_constructor_emitsIssuerSet() public {
        vm.expectEmit(true, true, true, true);
        emit IBlindIssuer.IssuerSet(issuer);
        new BlindIssuer(owner, issuer);
    }

    function test_constructor_revertsZeroIssuer() public {
        vm.expectRevert(BlindIssuer.ZeroAddress.selector);
        new BlindIssuer(owner, address(0));
    }

    function test_constructor_revertsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new BlindIssuer(address(0), issuer);
    }

    // --- commitEpoch ---------------------------------------------------------------------------

    function test_commitEpoch_storesEmitsAndMatchesTheRouterCommitment() public {
        vm.expectEmit(true, true, true, true, address(bi));
        emit IBlindIssuer.EpochCommitted(EPOCH, ROUTER_COMMITMENT, _denoms(), _ids());
        _commit(EPOCH);

        assertEq(bi.commitmentOf(EPOCH), ROUTER_COMMITMENT);
        assertEq(bi.committedAt(EPOCH), T0);
        assertEq(bi.keyIdOf(EPOCH, 1000), ID_1K);
        assertEq(bi.keyIdOf(EPOCH, 10_000), ID_10K);
        assertEq(bi.keyIdOf(EPOCH, 100_000), ID_100K);
        assertEq(bi.keyIdOf(EPOCH, 5), bytes32(0));
        assertEq(bi.revokedAt(EPOCH), 0);
        assertTrue(bi.verifyCommitment(EPOCH, _denoms(), _ids()));
    }

    function test_commitEpoch_keyInfo() public {
        _commit(EPOCH);
        (bool found, uint64 epoch, bool revoked) = bi.keyInfo(ID_10K);
        assertTrue(found);
        assertEq(epoch, EPOCH);
        assertFalse(revoked);
        (found, epoch, revoked) = bi.keyInfo(keccak256("unknown"));
        assertFalse(found);
        assertEq(epoch, 0);
        assertFalse(revoked);
    }

    function test_commitEpoch_onlyIssuer() public {
        uint32[] memory d = _denoms();
        bytes32[] memory k = _ids();
        vm.prank(rando);
        vm.expectRevert(IBlindIssuer.NotIssuer.selector);
        bi.commitEpoch(EPOCH, d, k);
        vm.prank(owner); // the owner replaces the issuer; it does not commit for it
        vm.expectRevert(IBlindIssuer.NotIssuer.selector);
        bi.commitEpoch(EPOCH, d, k);
    }

    function test_commitEpoch_onlyOnce() public {
        _commit(EPOCH);
        bytes32[] memory k = new bytes32[](1);
        k[0] = keccak256("another key");
        uint32[] memory d = new uint32[](1);
        d[0] = 1000;
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.EpochAlreadyCommitted.selector);
        bi.commitEpoch(EPOCH, d, k);
    }

    function test_commitEpoch_epochsAreIndependent() public {
        _commit(EPOCH);
        bytes32[] memory k = new bytes32[](3);
        k[0] = keccak256("a");
        k[1] = keccak256("b");
        k[2] = keccak256("c");
        vm.prank(issuer);
        bi.commitEpoch(EPOCH + 1, _denoms(), k);
        assertTrue(bi.commitmentOf(EPOCH + 1) != bi.commitmentOf(EPOCH));
        assertFalse(bi.verifyCommitment(EPOCH + 1, _denoms(), _ids())); // the wrong keys do not verify
    }

    function test_commitEpoch_revertsOnMalformedInput() public {
        uint32[] memory d = _denoms();
        bytes32[] memory k = _ids();

        // empty
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.InvalidKeys.selector);
        bi.commitEpoch(EPOCH, new uint32[](0), new bytes32[](0));

        // length mismatch
        bytes32[] memory two = new bytes32[](2);
        two[0] = ID_1K;
        two[1] = ID_10K;
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.InvalidKeys.selector);
        bi.commitEpoch(EPOCH, d, two);

        // too many
        uint32[] memory nine = new uint32[](9);
        bytes32[] memory nineIds = new bytes32[](9);
        for (uint256 i; i < 9; ++i) {
            nine[i] = uint32(1000 * (i + 1));
            nineIds[i] = keccak256(abi.encode(i));
        }
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.InvalidKeys.selector);
        bi.commitEpoch(EPOCH, nine, nineIds);

        // not ascending
        uint32[] memory unsorted = _denoms();
        (unsorted[0], unsorted[1]) = (unsorted[1], unsorted[0]);
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.InvalidKeys.selector);
        bi.commitEpoch(EPOCH, unsorted, k);

        // duplicate denomination
        uint32[] memory dup = _denoms();
        dup[1] = dup[0];
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.InvalidKeys.selector);
        bi.commitEpoch(EPOCH, dup, k);

        // zero denomination
        uint32[] memory zero = _denoms();
        zero[0] = 0;
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.InvalidKeys.selector);
        bi.commitEpoch(EPOCH, zero, k);

        // zero key id
        bytes32[] memory zeroId = _ids();
        zeroId[2] = bytes32(0);
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.InvalidKeys.selector);
        bi.commitEpoch(EPOCH, d, zeroId);

        // nothing was stored by any failed attempt
        assertEq(bi.commitmentOf(EPOCH), bytes32(0));
        assertEq(bi.keyIdOf(EPOCH, 1000), bytes32(0));
        (bool found,,) = bi.keyInfo(ID_1K);
        assertFalse(found);
    }

    function test_commitEpoch_aKeyIdBelongsToOneEpoch() public {
        _commit(EPOCH);
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.KeyIdReused.selector);
        bi.commitEpoch(EPOCH + 1, _denoms(), _ids());

        // the same id twice inside one epoch is also a reuse
        bytes32[] memory twice = new bytes32[](2);
        twice[0] = keccak256("x");
        twice[1] = keccak256("x");
        uint32[] memory d = new uint32[](2);
        d[0] = 1000;
        d[1] = 10_000;
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.KeyIdReused.selector);
        bi.commitEpoch(EPOCH + 2, d, twice);
        assertEq(bi.commitmentOf(EPOCH + 2), bytes32(0));
    }

    // --- recordIssuance ------------------------------------------------------------------------

    function test_recordIssuance_accumulatesCountsOnly() public {
        _commit(EPOCH);
        vm.expectEmit(true, true, true, true, address(bi));
        emit IBlindIssuer.TokensIssued(EPOCH, 10_000, 32);
        vm.prank(issuer);
        bi.recordIssuance(EPOCH, 10_000, 32);
        vm.prank(issuer);
        bi.recordIssuance(EPOCH, 10_000, 8);
        vm.prank(issuer);
        bi.recordIssuance(EPOCH, 1000, 1);
        assertEq(bi.issuedCount(EPOCH, 10_000), 40);
        assertEq(bi.issuedCount(EPOCH, 1000), 1);
        assertEq(bi.issuedCount(EPOCH, 100_000), 0);
    }

    function test_recordIssuance_reverts() public {
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.UnknownEpoch.selector);
        bi.recordIssuance(EPOCH, 1000, 1);

        _commit(EPOCH);
        vm.prank(rando);
        vm.expectRevert(IBlindIssuer.NotIssuer.selector);
        bi.recordIssuance(EPOCH, 1000, 1);
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.UnknownDenomination.selector);
        bi.recordIssuance(EPOCH, 5000, 1);
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.ZeroCount.selector);
        bi.recordIssuance(EPOCH, 1000, 0);

        vm.prank(issuer);
        bi.revokeEpoch(EPOCH, "compromised");
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.EpochIsRevoked.selector);
        bi.recordIssuance(EPOCH, 1000, 1);
    }

    // --- revokeEpoch ---------------------------------------------------------------------------

    function test_revokeEpoch_byIssuerAndByOwner() public {
        _commit(EPOCH);
        bytes32[] memory k = new bytes32[](3);
        k[0] = keccak256("a");
        k[1] = keccak256("b");
        k[2] = keccak256("c");
        vm.prank(issuer);
        bi.commitEpoch(EPOCH + 1, _denoms(), k);

        vm.warp(T0 + 100);
        vm.expectEmit(true, true, true, true, address(bi));
        emit IBlindIssuer.EpochRevoked(EPOCH, T0 + 100, "key compromise");
        vm.prank(issuer);
        bi.revokeEpoch(EPOCH, "key compromise");
        assertEq(bi.revokedAt(EPOCH), T0 + 100);
        (,, bool revoked) = bi.keyInfo(ID_1K);
        assertTrue(revoked);
        (,, revoked) = bi.keyInfo(k[0]);
        assertFalse(revoked); // other epochs are untouched

        vm.warp(T0 + 200);
        vm.prank(owner);
        bi.revokeEpoch(EPOCH + 1, "owner revoked");
        assertEq(bi.revokedAt(EPOCH + 1), T0 + 200);
        // The commitment stays: a revoked epoch is still auditable.
        assertEq(bi.commitmentOf(EPOCH), ROUTER_COMMITMENT);
        assertTrue(bi.verifyCommitment(EPOCH, _denoms(), _ids()));
    }

    function test_revokeEpoch_reverts() public {
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.UnknownEpoch.selector);
        bi.revokeEpoch(EPOCH, "x");

        _commit(EPOCH);
        vm.prank(rando);
        vm.expectRevert(IBlindIssuer.NotIssuerOrOwner.selector);
        bi.revokeEpoch(EPOCH, "x");

        vm.prank(issuer);
        bi.revokeEpoch(EPOCH, "x");
        vm.prank(owner);
        vm.expectRevert(IBlindIssuer.AlreadyRevoked.selector);
        bi.revokeEpoch(EPOCH, "again");
    }

    function test_revokedEpochCannotBeCommittedAgain() public {
        _commit(EPOCH);
        vm.prank(issuer);
        bi.revokeEpoch(EPOCH, "x");
        vm.prank(issuer);
        vm.expectRevert(IBlindIssuer.EpochAlreadyCommitted.selector);
        bi.commitEpoch(EPOCH, _denoms(), _ids());
    }

    // --- issuer role ---------------------------------------------------------------------------

    function test_setIssuer() public {
        address next = makeAddr("next issuer");
        vm.expectEmit(true, true, true, true, address(bi));
        emit IBlindIssuer.IssuerSet(next);
        vm.prank(owner);
        bi.setIssuer(next);
        assertEq(bi.issuer(), next);

        vm.prank(issuer); // the old issuer lost its role
        vm.expectRevert(IBlindIssuer.NotIssuer.selector);
        bi.commitEpoch(EPOCH, _denoms(), _ids());
        vm.prank(next);
        bi.commitEpoch(EPOCH, _denoms(), _ids());
    }

    function test_setIssuer_reverts() public {
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        bi.setIssuer(rando);
        vm.prank(issuer); // the issuer cannot pick its successor
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, issuer));
        bi.setIssuer(rando);
        vm.prank(owner);
        vm.expectRevert(BlindIssuer.ZeroAddress.selector);
        bi.setIssuer(address(0));
    }

    function test_ownershipIsTwoStep() public {
        address next = makeAddr("next owner");
        vm.prank(owner);
        bi.transferOwnership(next);
        assertEq(bi.owner(), owner);
        vm.prank(next);
        bi.acceptOwnership();
        assertEq(bi.owner(), next);
    }

    // --- verifyCommitment ----------------------------------------------------------------------

    function test_verifyCommitment_falseWhenNothingCommittedOrPartsDiffer() public {
        assertFalse(bi.verifyCommitment(EPOCH, _denoms(), _ids())); // uncommitted
        _commit(EPOCH);
        bytes32[] memory k = _ids();
        k[1] = keccak256("substituted key");
        assertFalse(bi.verifyCommitment(EPOCH, _denoms(), k)); // a substituted key changes the commitment
        uint32[] memory d = _denoms();
        d[2] = 200_000;
        assertFalse(bi.verifyCommitment(EPOCH, d, _ids()));
        assertFalse(bi.verifyCommitment(EPOCH + 1, _denoms(), _ids()));
    }

    function testFuzz_commitment_isKeccakOfTheAbiEncoding(uint64 epoch, bytes32 a, bytes32 b) public {
        vm.assume(a != bytes32(0) && b != bytes32(0) && a != b);
        uint32[] memory d = new uint32[](2);
        d[0] = 1000;
        d[1] = 10_000;
        bytes32[] memory k = new bytes32[](2);
        k[0] = a;
        k[1] = b;
        vm.prank(issuer);
        bi.commitEpoch(epoch, d, k);
        assertEq(bi.commitmentOf(epoch), keccak256(abi.encode(epoch, d, k)));
        assertTrue(bi.verifyCommitment(epoch, d, k));
        assertEq(bi.keyIdOf(epoch, 1000), a);
        assertEq(bi.keyIdOf(epoch, 10_000), b);
    }

    function testFuzz_issuanceCountsAdd(uint32 x, uint32 y) public {
        x = uint32(bound(x, 1, type(uint32).max));
        y = uint32(bound(y, 1, type(uint32).max));
        _commit(EPOCH);
        vm.startPrank(issuer);
        bi.recordIssuance(EPOCH, 1000, x);
        bi.recordIssuance(EPOCH, 1000, y);
        vm.stopPrank();
        assertEq(bi.issuedCount(EPOCH, 1000), uint64(x) + uint64(y));
    }
}
