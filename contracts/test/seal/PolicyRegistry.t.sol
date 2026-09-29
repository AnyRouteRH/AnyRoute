// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PolicyRegistry} from "../../src/seal/PolicyRegistry.sol";

contract PolicyRegistryTest is Test {
    uint64 internal constant T0 = 1_750_000_000;

    PolicyRegistry internal reg;
    address internal owner = makeAddr("owner");
    address internal publisher = makeAddr("publisher");
    address internal guardian = makeAddr("guardian");
    address internal rando = makeAddr("rando");

    bytes32 internal constant POLICY = keccak256("attestation_policy.v1.json");
    bytes32 internal constant RIM = keccak256("gpu-rim-allowlist");
    uint16 internal ACCEPTED;
    uint32 internal DRIVER;

    event PolicyPublished(
        uint32 indexed version,
        bytes32 policyHash,
        uint16 acceptedTcbStatuses,
        uint32 advisoryGrace,
        bytes32 gpuRimAllowlistHash,
        uint32 minDriver
    );
    event PolicyDeprecated(uint32 indexed version, uint64 acceptedUntil, string reason);

    function setUp() public {
        vm.warp(T0);
        reg = new PolicyRegistry(owner, publisher, guardian);
        ACCEPTED = reg.TCB_UP_TO_DATE() | reg.TCB_SW_HARDENING_NEEDED() | reg.TCB_OUT_OF_DATE();
        DRIVER = reg.packDriver(595, 71, 5);
    }

    function _publish() internal returns (uint32) {
        vm.prank(publisher);
        return reg.publish(POLICY, ACCEPTED, 14 days, RIM, DRIVER);
    }

    function test_constructorAndRoles() public {
        assertEq(reg.owner(), owner);
        assertEq(reg.publisher(), publisher);
        assertEq(reg.guardian(), guardian);
        assertEq(reg.latestVersion(), 0);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        new PolicyRegistry(owner, address(0), guardian);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        new PolicyRegistry(owner, publisher, address(0));
    }

    function test_setRolesOnlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        reg.setPublisher(rando);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        reg.setGuardian(rando);
        vm.startPrank(owner);
        reg.setPublisher(rando);
        reg.setGuardian(rando);
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        reg.setPublisher(address(0));
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        reg.setGuardian(address(0));
        vm.stopPrank();
        assertEq(reg.publisher(), rando);
        assertEq(reg.guardian(), rando);
    }

    function test_packDriver() public view {
        assertEq(DRIVER, (uint32(595) << 16) | (71 << 8) | 5);
        assertGt(reg.packDriver(595, 71, 5), reg.packDriver(595, 58, 99));
        assertGt(reg.packDriver(596, 0, 0), reg.packDriver(595, 255, 255));
    }

    function test_publishAssignsSequentialVersionsAndEmits() public {
        vm.expectEmit(address(reg));
        emit PolicyPublished(1, POLICY, ACCEPTED, 14 days, RIM, DRIVER);
        assertEq(_publish(), 1);
        assertEq(_publish(), 2);
        assertEq(reg.latestVersion(), 2);

        PolicyRegistry.Policy memory p = reg.policyOf(1);
        assertEq(p.policyHash, POLICY);
        assertEq(p.acceptedTcbStatuses, ACCEPTED);
        assertEq(p.advisoryGrace, 14 days);
        assertEq(p.gpuRimAllowlistHash, RIM);
        assertEq(p.minDriver, DRIVER);
        assertEq(p.publishedAt, T0);
        assertEq(p.deprecatedAt, 0);
        assertEq(p.acceptedUntil, 0);
    }

    function test_publishOnlyPublisher() public {
        address[3] memory callers = [rando, guardian, owner];
        for (uint256 i; i < 3; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(PolicyRegistry.NotPublisher.selector);
            reg.publish(POLICY, ACCEPTED, 0, RIM, DRIVER);
        }
    }

    function test_publishRejectsInvalid() public {
        vm.startPrank(publisher);
        vm.expectRevert(PolicyRegistry.InvalidPolicy.selector);
        reg.publish(0, ACCEPTED, 0, RIM, DRIVER);
        vm.expectRevert(PolicyRegistry.InvalidPolicy.selector);
        reg.publish(POLICY, ACCEPTED, 0, 0, DRIVER);
        vm.expectRevert(PolicyRegistry.InvalidPolicy.selector);
        reg.publish(POLICY, ACCEPTED, 0, RIM, 0);
        vm.expectRevert(PolicyRegistry.InvalidPolicy.selector);
        reg.publish(POLICY, 0, 0, RIM, DRIVER);
        vm.expectRevert(PolicyRegistry.InvalidPolicy.selector);
        reg.publish(POLICY, uint16(1 << 7), 0, RIM, DRIVER);
        uint32 maxGrace = reg.MAX_ADVISORY_GRACE();
        vm.expectRevert(PolicyRegistry.GraceTooLong.selector);
        reg.publish(POLICY, ACCEPTED, maxGrace + 1, RIM, DRIVER);
        reg.publish(POLICY, ACCEPTED, maxGrace, RIM, DRIVER);
        vm.stopPrank();
    }

    function test_revokedTcbNeverAccepted() public {
        uint16 revoked = reg.TCB_REVOKED();
        vm.prank(publisher);
        vm.expectRevert(PolicyRegistry.RevokedTcbAccepted.selector);
        reg.publish(POLICY, ACCEPTED | revoked, 0, RIM, DRIVER);
    }

    function testFuzz_revokedBitAlwaysRejected(uint16 mask) public {
        mask |= reg.TCB_REVOKED();
        vm.prank(publisher);
        vm.expectRevert(PolicyRegistry.RevokedTcbAccepted.selector);
        reg.publish(POLICY, mask, 0, RIM, DRIVER);
    }

    function test_acceptsTcb() public {
        uint32 v = _publish();
        assertTrue(reg.acceptsTcb(v, reg.TCB_UP_TO_DATE()));
        assertTrue(reg.acceptsTcb(v, reg.TCB_UP_TO_DATE() | reg.TCB_OUT_OF_DATE()));
        assertFalse(reg.acceptsTcb(v, reg.TCB_CONFIGURATION_NEEDED()));
        assertFalse(reg.acceptsTcb(v, reg.TCB_REVOKED()));
        assertFalse(reg.acceptsTcb(v, 0));
        assertFalse(reg.acceptsTcb(99, reg.TCB_UP_TO_DATE()));
    }

    function test_isAcceptedLifecycle() public {
        uint32 v = _publish();
        assertFalse(reg.isAccepted(v, T0 - 1));
        assertTrue(reg.isAccepted(v, T0));
        assertTrue(reg.isAccepted(v, T0 + 365 days));
        assertFalse(reg.isAccepted(0, T0));
        assertFalse(reg.isAccepted(2, T0));

        vm.warp(T0 + 10 days);
        vm.expectEmit(address(reg));
        emit PolicyDeprecated(v, T0 + 10 days + 7 days, "INTEL-SA-00001");
        vm.prank(guardian);
        reg.deprecate(v, 7 days, "INTEL-SA-00001");

        assertTrue(reg.isAccepted(v, T0 + 10 days));
        assertTrue(reg.isAccepted(v, T0 + 17 days - 1));
        assertFalse(reg.isAccepted(v, T0 + 17 days));
        PolicyRegistry.Policy memory p = reg.policyOf(v);
        assertEq(p.deprecatedAt, T0 + 10 days);
        assertEq(p.acceptedUntil, T0 + 17 days);
    }

    function test_deprecateAccessAndValidation() public {
        vm.prank(publisher);
        vm.expectRevert(PolicyRegistry.UnknownVersion.selector);
        reg.deprecate(1, 0, "x");

        uint32 v = _publish();
        address[2] memory callers = [rando, owner];
        for (uint256 i; i < 2; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(PolicyRegistry.NotPublisherOrGuardian.selector);
            reg.deprecate(v, 0, "x");
        }
        uint32 maxGrace = reg.MAX_DEPRECATION_GRACE();
        vm.startPrank(publisher);
        vm.expectRevert(PolicyRegistry.EmptyReason.selector);
        reg.deprecate(v, 0, "");
        vm.expectRevert(PolicyRegistry.GraceTooLong.selector);
        reg.deprecate(v, maxGrace + 1, "x");
        reg.deprecate(v, 0, "x");
        assertFalse(reg.isAccepted(v, T0));
        vm.expectRevert(PolicyRegistry.AlreadyDeprecated.selector);
        reg.deprecate(v, maxGrace, "extend");
        vm.stopPrank();
    }

    function testFuzz_isAcceptedAfterDeprecation(uint32 grace, uint64 at) public {
        grace = uint32(bound(grace, 0, reg.MAX_DEPRECATION_GRACE()));
        uint32 v = _publish();
        vm.warp(T0 + 1 days);
        vm.prank(publisher);
        reg.deprecate(v, grace, "rotate");
        uint64 until = T0 + 1 days + grace;
        assertEq(reg.isAccepted(v, at), at >= T0 && at < until);
    }
}
