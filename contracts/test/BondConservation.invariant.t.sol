// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProviderBond} from "../src/ProviderBond.sol";
import {HostBond} from "../src/seal/HostBond.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

// Both bond modules expose the same sanction ABI; uint8 is the encoded enum type.
interface BondActions {
    function bond(bytes32, uint256) external;
    function bondOf(bytes32) external view returns (uint256);
    function pendingSlashes(bytes32) external view returns (uint256);
    function proposeSlash(bytes32, uint8, uint256, bytes32, bool) external returns (uint256);
    function disputeSlash(uint256, bytes32) external;
    function approveSlash(uint256, bytes32) external;
    function cancelSlash(uint256) external;
    function executeSlash(uint256) external;
    function revokeSlashApprovals() external;
}
contract BondConservationHandler is Test {
    BondActions public module;
    MockUSDG public token;
    bool public host;
    address public governor;
    address public slasher;
    address public pool;
    address[3] public operators;
    uint256 public deposited;
    uint256 public exited;
    uint256 public slashed;
    uint256 public proposed;
    uint256 public disputed;
    uint256 public resolved;
    struct Proposal { uint256 id; uint256 who; bytes32 dispute; bool pending; }
    Proposal[] public proposals;
    constructor(address module_, MockUSDG token_, bool host_, address governor_, address slasher_, address pool_) {
        module = BondActions(module_); token = token_; host = host_; governor = governor_; slasher = slasher_; pool = pool_;
        for (uint256 i; i < 3; i++) {
            operators[i] = address(uint160(0x1000 + i));
            vm.prank(operators[i]); token.approve(module_, type(uint256).max);
            deposit(i, 0);
        }
    }
    function identifier(uint256 who) public pure returns (bytes32) { return bytes32(1 + who % 3); }
    function deposit(uint256 who, uint256 amount) public {
        who %= 3; amount = 10_000e6 + amount % 100_000e6;
        token.mint(operators[who], amount);
        vm.prank(operators[who]); module.bond(identifier(who), amount);
        deposited += amount;
    }
    function requestExit(uint256 who) external {
        who %= 3; uint256 balance = module.bondOf(identifier(who)); if (balance == 0 || module.pendingSlashes(identifier(who)) != 0) return;
        vm.prank(operators[who]);
        if (host) HostBond(address(module)).requestUnbond(identifier(who), balance);
        else ProviderBond(address(module)).requestWithdraw(identifier(who), balance);
    }
    function exit(uint256 who) external {
        who %= 3; bytes32 id = identifier(who);
        if (module.pendingSlashes(id) != 0) return;
        (uint256 amount, uint64 at) = host ? HostBond(address(module)).unbondRequest(id) : ProviderBond(address(module)).withdrawRequest(id);
        if (amount == 0 || block.timestamp < at || module.bondOf(id) == 0) return;
        uint256 beforeBalance = token.balanceOf(operators[who]);
        vm.prank(operators[who]);
        if (host) HostBond(address(module)).unbond(id, operators[who]);
        else ProviderBond(address(module)).withdraw(id, operators[who]);
        exited += token.balanceOf(operators[who]) - beforeBalance;
    }
    function propose(uint256 who, uint256 amount) external {
        who %= 3; uint256 balance = module.bondOf(identifier(who)); if (balance == 0) return;
        amount = 1 + amount % balance;
        vm.prank(slasher);
        uint256 id = module.proposeSlash(identifier(who), 0, amount, keccak256(abi.encode(who, proposed)), false);
        proposals.push(Proposal(id, who, bytes32(0), true)); proposed++;
    }
    function dispute(uint256 selection) external {
        if (proposals.length == 0) return;
        Proposal storage p = proposals[selection % proposals.length];
        if (!p.pending || p.dispute != bytes32(0)) return;
        p.dispute = keccak256(abi.encode(p.id, "dispute"));
        vm.prank(operators[p.who]); module.disputeSlash(p.id, p.dispute); disputed++;
    }
    function resolve(uint256 selection, bool cancel) external {
        if (proposals.length == 0) return;
        Proposal storage p = proposals[selection % proposals.length]; if (!p.pending) return;
        if (cancel) { vm.prank(governor); module.cancelSlash(p.id); }
        else {
            // Review the exact dispute, then execute after its fixed review window.
            vm.warp(block.timestamp + 72 hours);
            vm.prank(governor); module.approveSlash(p.id, p.dispute);
            uint256 beforeBalance = token.balanceOf(pool);
            vm.prank(slasher); module.executeSlash(p.id);
            slashed += token.balanceOf(pool) - beforeBalance;
        }
        p.pending = false; resolved++;
    }
    function revoke() external { vm.prank(governor); module.revokeSlashApprovals(); }
    function advance(uint256 seconds_) external { vm.warp(block.timestamp + 1 + seconds_ % 20 days); }
    function assertConservation() external view {
        uint256 liabilities; uint256 outstanding;
        for (uint256 i; i < 3; i++) { liabilities += module.bondOf(identifier(i)); outstanding += module.pendingSlashes(identifier(i)); }
        assertEq(token.balanceOf(address(module)), liabilities);
        assertEq(liabilities, deposited - exited - slashed);
        assertEq(token.balanceOf(pool), slashed);
        assertEq(outstanding, proposed - resolved);
        uint256 exitedBalances;
        for (uint256 i; i < 3; i++) exitedBalances += token.balanceOf(operators[i]);
        assertEq(exitedBalances, exited);
        assertEq(token.totalSupply(), liabilities + exitedBalances + slashed);
    }
}
abstract contract BondConservationBase is Test {
    BondConservationHandler internal handler;
    function initialize(bool host) internal {
        vm.warp(1_800_000_000);
        address governor = makeAddr("governor"); address slasher = makeAddr("slasher"); address pool = makeAddr("refund-pool");
        MockUSDG token = new MockUSDG();
        address module = host ? address(new HostBond(token, governor, slasher, pool)) : address(new ProviderBond(token, governor, slasher, pool));
        handler = new BondConservationHandler(module, token, host, governor, slasher, pool);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = handler.deposit.selector; selectors[1] = handler.requestExit.selector; selectors[2] = handler.exit.selector;
        selectors[3] = handler.propose.selector; selectors[4] = handler.dispute.selector; selectors[5] = handler.resolve.selector;
        selectors[6] = handler.revoke.selector; selectors[7] = handler.advance.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }
    function invariant_bondsAndSanctionsConserveAllFunds() external view { handler.assertConservation(); }
    function test_lifecycleExercisesExitDisputeAndSanction() external {
        handler.requestExit(0); handler.propose(0, 1e6); handler.dispute(0); handler.resolve(0, false);
        handler.advance(19 days); handler.exit(0); handler.assertConservation();
        assertGt(handler.exited(), 0); assertGt(handler.slashed(), 0); assertEq(handler.disputed(), 1);
    }
}
contract ProviderBondConservationTest is BondConservationBase { function setUp() external { initialize(false); } }
contract HostBondConservationTest is BondConservationBase { function setUp() external { initialize(true); } }
