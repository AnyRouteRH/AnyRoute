// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SkillRegistry} from "../../src/seal/SkillRegistry.sol";

contract SkillRegistryTest is Test {
    SkillRegistry internal reg;
    address internal owner = makeAddr("owner");
    address internal publisher = makeAddr("publisher");
    address internal guardian = makeAddr("guardian");
    address internal author = makeAddr("author");
    address internal rando = makeAddr("rando");

    bytes32 internal constant PDF = keccak256("pdf-extract canonical tar");
    bytes32 internal constant BEACON = keccak256("env-beacon canonical tar");
    string internal constant URI = "https://router.example/api/v1/skills/sk_0123456789abcdef01234567";

    event SkillPublished(bytes32 indexed skillHash, address indexed author, uint256 priceUSDG, uint8 trustLevel, string uri);
    event TrustLevelUpdated(bytes32 indexed skillHash, uint8 previous, uint8 trustLevel);
    event SkillRevoked(bytes32 indexed skillHash, address indexed by, string reason);

    function setUp() public {
        vm.warp(1_790_000_000);
        reg = new SkillRegistry(owner, publisher, guardian);
    }

    function _publish(bytes32 h, uint8 level) internal {
        vm.prank(publisher);
        reg.publish(h, author, 2_500_000, level, URI);
    }

    function test_constructorRejectsZeroRoles() public {
        vm.expectRevert(SkillRegistry.ZeroAddress.selector);
        new SkillRegistry(owner, address(0), guardian);
        vm.expectRevert(SkillRegistry.ZeroAddress.selector);
        new SkillRegistry(owner, publisher, address(0));
    }

    function test_publishRecordsTheSkillAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit SkillPublished(PDF, author, 2_500_000, 1, URI);
        _publish(PDF, reg.TRUSTED());
        SkillRegistry.Skill memory s = reg.skillOf(PDF);
        assertEq(s.author, author);
        assertEq(s.priceUSDG, 2_500_000);
        assertEq(s.trustLevel, 1);
        assertEq(s.publishedAt, 1_790_000_000);
        assertEq(s.revokedAt, 0);
        assertEq(s.uri, URI);
        assertEq(reg.skillCount(), 1);
        assertTrue(reg.isTrusted(PDF));
        assertTrue(reg.isInstallable(PDF));
    }

    function test_onlyThePublisherPublishes() public {
        vm.prank(rando);
        vm.expectRevert(SkillRegistry.NotPublisher.selector);
        reg.publish(PDF, author, 0, 1, URI);
        vm.prank(guardian);
        vm.expectRevert(SkillRegistry.NotPublisher.selector);
        reg.publish(PDF, author, 0, 1, URI);
    }

    function test_publishValidatesItsInputs() public {
        vm.startPrank(publisher);
        vm.expectRevert(SkillRegistry.ZeroHash.selector);
        reg.publish(bytes32(0), author, 0, 1, URI);
        vm.expectRevert(SkillRegistry.ZeroAddress.selector);
        reg.publish(PDF, address(0), 0, 1, URI);
        vm.expectRevert(SkillRegistry.InvalidTrustLevel.selector);
        reg.publish(PDF, author, 0, 0, URI);
        vm.expectRevert(SkillRegistry.InvalidTrustLevel.selector);
        reg.publish(PDF, author, 0, 4, URI);
        vm.expectRevert(SkillRegistry.InvalidUri.selector);
        reg.publish(PDF, author, 0, 1, "");
        vm.expectRevert(SkillRegistry.InvalidUri.selector);
        reg.publish(PDF, author, 0, 1, string(new bytes(513)));
        vm.expectRevert(SkillRegistry.PriceTooHigh.selector);
        reg.publish(PDF, author, uint256(type(uint96).max) + 1, 1, URI);
        vm.stopPrank();
    }

    function test_aHashIsPublishedOnce() public {
        _publish(PDF, 1);
        vm.prank(publisher);
        vm.expectRevert(SkillRegistry.AlreadyPublished.selector);
        reg.publish(PDF, author, 0, 2, URI);
    }

    function test_dangerousAndCautionLevels() public {
        _publish(BEACON, reg.DANGEROUS());
        assertFalse(reg.isTrusted(BEACON));
        assertFalse(reg.isInstallable(BEACON));
        _publish(PDF, reg.CAUTION());
        assertFalse(reg.isTrusted(PDF));
        assertTrue(reg.isInstallable(PDF));
        assertFalse(reg.isTrusted(keccak256("never published")));
        assertFalse(reg.isInstallable(keccak256("never published")));
    }

    function test_revokeByPublisherOrGuardianIsPermanent() public {
        _publish(PDF, 1);
        vm.prank(rando);
        vm.expectRevert(SkillRegistry.NotPublisherOrGuardian.selector);
        reg.revoke(PDF, "exfiltrates env");

        vm.prank(guardian);
        vm.expectRevert(SkillRegistry.EmptyReason.selector);
        reg.revoke(PDF, "");

        vm.expectEmit(true, true, false, true);
        emit SkillRevoked(PDF, guardian, "advisory SK-2026-001");
        vm.prank(guardian);
        reg.revoke(PDF, "advisory SK-2026-001");
        assertFalse(reg.isTrusted(PDF));
        assertFalse(reg.isInstallable(PDF));
        assertEq(reg.skillOf(PDF).revokedAt, 1_790_000_000);

        vm.prank(publisher);
        vm.expectRevert(SkillRegistry.AlreadyRevoked.selector);
        reg.revoke(PDF, "again");
        vm.prank(publisher);
        vm.expectRevert(SkillRegistry.AlreadyPublished.selector);
        reg.publish(PDF, author, 0, 1, URI);
        vm.prank(publisher);
        vm.expectRevert(SkillRegistry.AlreadyRevoked.selector);
        reg.setTrustLevel(PDF, 1);
    }

    function test_revokeUnknownSkillReverts() public {
        vm.prank(publisher);
        vm.expectRevert(SkillRegistry.UnknownSkill.selector);
        reg.revoke(PDF, "unknown");
    }

    function test_setTrustLevelAfterRescan() public {
        _publish(PDF, 1);
        vm.expectEmit(true, false, false, true);
        emit TrustLevelUpdated(PDF, 1, 3);
        vm.prank(publisher);
        reg.setTrustLevel(PDF, 3);
        assertFalse(reg.isInstallable(PDF));
        vm.prank(guardian);
        vm.expectRevert(SkillRegistry.NotPublisher.selector);
        reg.setTrustLevel(PDF, 1);
        vm.prank(publisher);
        vm.expectRevert(SkillRegistry.InvalidTrustLevel.selector);
        reg.setTrustLevel(PDF, 9);
        vm.prank(publisher);
        vm.expectRevert(SkillRegistry.UnknownSkill.selector);
        reg.setTrustLevel(BEACON, 1);
    }

    function test_ownerSetsRolesWithTwoStepOwnership() public {
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        reg.setPublisher(rando);
        vm.startPrank(owner);
        vm.expectRevert(SkillRegistry.ZeroAddress.selector);
        reg.setPublisher(address(0));
        reg.setPublisher(rando);
        reg.setGuardian(rando);
        vm.stopPrank();
        assertEq(reg.publisher(), rando);
        assertEq(reg.guardian(), rando);

        address timelock = makeAddr("timelock");
        vm.prank(owner);
        reg.transferOwnership(timelock);
        assertEq(reg.owner(), owner);
        vm.prank(timelock);
        reg.acceptOwnership();
        assertEq(reg.owner(), timelock);
    }

    function testFuzz_publishThenStatus(bytes32 h, uint8 level, uint96 price) public {
        vm.assume(h != bytes32(0));
        level = uint8(bound(level, 1, 3));
        vm.prank(publisher);
        reg.publish(h, author, price, level, URI);
        assertEq(reg.isTrusted(h), level == 1);
        assertEq(reg.isInstallable(h), level != 3);
        assertEq(reg.skillOf(h).priceUSDG, price);
    }
}
