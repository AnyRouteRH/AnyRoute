// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Credits} from "../src/Credits.sol";
import {ICredits} from "../src/interfaces/ICredits.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {Merkle} from "./utils/Merkle.sol";
import {SpentTree} from "./utils/SpentTree.sol";

contract MockERC1271Wallet is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes memory sig) external view returns (bytes4) {
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
        return
            (err == ECDSA.RecoverError.NoError && rec == signer)
                ? IERC1271.isValidSignature.selector
                : bytes4(0);
    }
}

abstract contract CreditsBase is Test {
    uint256 internal constant CHAIN_ID = 4663;
    bytes32 internal constant TYPEHASH = keccak256(
        "WithdrawRequest(bytes32 keyHash,uint256 amount,address to,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    MockUSDG internal usdg;
    Credits internal credits;

    address internal owner = makeAddr("owner");
    address internal settlement = makeAddr("settlement");
    address internal creditor = makeAddr("creditor");
    address internal recipient = makeAddr("recipient");
    address internal relayer = makeAddr("relayer");
    address internal alice;
    uint256 internal alicePk;

    uint256 internal keyPk = 0xA11CE5EC2E7;
    address internal keyAddr;
    bytes32 internal keyHash;

    function setUp() public virtual {
        vm.chainId(CHAIN_ID);
        vm.warp(1_750_000_000);
        (alice, alicePk) = makeAddrAndKey("alice");
        usdg = new MockUSDG();
        credits = new Credits(IERC20(address(usdg)), owner, settlement);
        keyAddr = vm.addr(keyPk);
        keyHash = keccak256(abi.encodePacked(keyAddr));

        usdg.mint(alice, 10_000_000e6);
        usdg.mint(creditor, 10_000_000e6);
        vm.prank(alice);
        usdg.approve(address(credits), type(uint256).max);
        vm.prank(creditor);
        usdg.approve(address(credits), type(uint256).max);
        vm.prank(owner);
        credits.setCreditor(creditor, true);
    }

    // --- helpers -------------------------------------------------------------------------------

    function _domainSeparator(uint256 chainId, address verifying) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Anyroute Credits"),
                keccak256("1"),
                chainId,
                verifying
            )
        );
    }

    function _digest(bytes32 kh, uint256 amount, address to, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(TYPEHASH, kh, amount, to, nonce, deadline));
        return keccak256(
            abi.encodePacked("\x19\x01", _domainSeparator(block.chainid, address(credits)), structHash)
        );
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signRequest(uint256 pk, uint256 amount, address to, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        address ka = vm.addr(pk);
        bytes32 kh = keccak256(abi.encodePacked(ka));
        return _sign(pk, _digest(kh, amount, to, credits.nonces(kh), deadline));
    }

    function _request(uint256 amount) internal {
        bytes memory sig = _signRequest(keyPk, amount, recipient, block.timestamp);
        credits.requestWithdrawal(keyAddr, amount, recipient, block.timestamp, sig);
    }

    function _deposit(bytes32 kh, uint256 amount) internal {
        vm.prank(alice);
        credits.deposit(kh, amount);
    }

    // Existing accounting tests explicitly model the independent reviewer as well as settlement.
    function _approveRoot(bytes32 root, uint64 asOf, uint256 total) internal {
        (VmSafe.CallerMode mode, address sender, address origin) = vm.readCallers();
        vm.stopPrank();
        uint256 epoch = credits.latestEpoch() + 1;
        vm.prank(credits.owner());
        credits.approveSpentRoot(epoch, root, asOf, total);
        if (mode == VmSafe.CallerMode.RecurrentPrank) vm.startPrank(sender, origin);
        else if (mode == VmSafe.CallerMode.Prank) vm.prank(sender, origin);
    }

    function _approveSweep(address to, uint256 amount) internal {
        (VmSafe.CallerMode mode, address sender, address origin) = vm.readCallers();
        vm.stopPrank();
        uint256 swept = credits.totalSwept();
        vm.prank(credits.owner());
        credits.approveSweep(swept, to, amount);
        if (mode == VmSafe.CallerMode.RecurrentPrank) vm.startPrank(sender, origin);
        else if (mode == VmSafe.CallerMode.Prank) vm.prank(sender, origin);
    }

    /// Posts a single-leaf root for (kh, spent); the leaf is at index 0 of 1 and its proof is empty.
    function _postSingle(bytes32 kh, uint256 spent, uint256 totalSpent) internal {
        _postRoot(SpentTree.commitment(Merkle.creditsLeaf(kh, spent), 1), totalSpent);
    }

    function _postRoot(bytes32 root, uint256 totalSpent) internal {
        vm.prank(settlement);
        _approveRoot(root, uint64(block.timestamp), totalSpent);
        credits.postSpentRoot(root, uint64(block.timestamp), totalSpent);
    }

    /// Posts the root of the tree of (keys[i], spents[i]) in the order given.
    function _postTree(bytes32[] memory keys, uint256[] memory spents, uint256 totalSpent) internal {
        _postRoot(SpentTree.root(keys, spents), totalSpent);
    }

    function _empty() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](0);
    }

    function _finalizeAbsent(bytes32 kh, bytes32[] memory keys, uint256[] memory spents) internal {
        uint256 gap = SpentTree.gapOf(keys, kh);
        credits.finalizeWithdrawalAbsent(
            kh, keys.length, gap, _below(keys, spents, gap), _above(keys, spents, gap)
        );
    }

    function _below(bytes32[] memory keys, uint256[] memory spents, uint256 gap)
        internal
        pure
        returns (ICredits.SpentLeafProof memory)
    {
        return gap == 0 ? SpentTree.sentinel() : SpentTree.neighbour(keys, spents, gap - 1);
    }

    function _above(bytes32[] memory keys, uint256[] memory spents, uint256 gap)
        internal
        pure
        returns (ICredits.SpentLeafProof memory)
    {
        return gap == keys.length ? SpentTree.sentinel() : SpentTree.neighbour(keys, spents, gap);
    }

    function _permitSig(uint256 pk, address ownerAddr, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, ownerAddr, spender, value, usdg.nonces(ownerAddr), deadline)
        );
        (v, r, s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash)));
    }
}

contract CreditsTest is CreditsBase {
    // =============================================================================================
    // Constructor / config / views
    // =============================================================================================

    function test_constructor_setsState() public view {
        assertEq(credits.usdg(), address(usdg));
        assertEq(credits.settlement(), settlement);
        assertEq(credits.owner(), owner);
        assertEq(credits.latestEpoch(), 0);
        assertEq(credits.totalSwept(), 0);
        assertEq(credits.ESCAPE_DELAY(), 7 days);
        assertEq(credits.WITHDRAW_REQUEST_TYPEHASH(), TYPEHASH);
    }

    function test_constructor_emitsSettlementSet() public {
        vm.expectEmit(true, true, true, true);
        emit ICredits.SettlementSet(settlement);
        new Credits(IERC20(address(usdg)), owner, settlement);
    }

    function test_constructor_revertsOnZeroUsdg() public {
        vm.expectRevert(Credits.ZeroAddress.selector);
        new Credits(IERC20(address(0)), owner, settlement);
    }

    function test_constructor_revertsOnZeroSettlement() public {
        vm.expectRevert(Credits.ZeroAddress.selector);
        new Credits(IERC20(address(usdg)), owner, address(0));
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new Credits(IERC20(address(usdg)), address(0), settlement);
    }

    function test_domainSeparator_matchesManual() public view {
        assertEq(credits.DOMAIN_SEPARATOR(), _domainSeparator(CHAIN_ID, address(credits)));
        (, string memory name, string memory version, uint256 chainId, address verifying,,) =
            credits.eip712Domain();
        assertEq(name, "Anyroute Credits");
        assertEq(version, "1");
        assertEq(chainId, CHAIN_ID);
        assertEq(verifying, address(credits));
    }

    function testFuzz_withdrawDigest_matchesManual(
        bytes32 kh,
        uint256 amount,
        address to,
        uint256 nonce,
        uint256 dl
    ) public view {
        assertEq(credits.withdrawDigest(kh, amount, to, nonce, dl), _digest(kh, amount, to, nonce, dl));
    }

    function testFuzz_keyHashOf(address a) public view {
        assertEq(credits.keyHashOf(a), keccak256(abi.encodePacked(a)));
    }

    function testFuzz_spentLeaf_matchesHelper(bytes32 kh, uint256 spent) public view {
        assertEq(credits.spentLeaf(kh, spent), Merkle.creditsLeaf(kh, spent));
        assertEq(credits.spentLeaf(kh, spent), keccak256(bytes.concat(keccak256(abi.encode(kh, spent)))));
    }

    /// Pinned vector shared with test/unit.test.ts (the TypeScript SpentTree): keys 1, 2, 3 spending 10, 20, 30.
    function test_spentTree_pinnedVector() public view {
        bytes32[] memory keys = new bytes32[](3);
        uint256[] memory spents = new uint256[](3);
        (keys[0], keys[1], keys[2]) = (bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        (spents[0], spents[1], spents[2]) = (10, 20, 30);
        // pinned by their leading 8 bytes (computed independently with viem)
        bytes32 treeRoot = SpentTree.treeRoot(SpentTree.leaves(keys, spents));
        bytes32 root = credits.spentCommitment(treeRoot, 3);
        assertEq(bytes8(treeRoot), bytes8(0xab31475d858a5d6f));
        assertEq(bytes8(root), bytes8(0x0d848344e8b11cf4));
        assertEq(SpentTree.root(keys, spents), root);
        assertEq(credits.spentCommitment(treeRoot, 0), bytes32(0));
        bytes32[] memory leaves = SpentTree.leaves(keys, spents);
        for (uint256 i; i < 3; ++i) {
            assertTrue(
                credits.verifySpentInclusion(root, keys[i], spents[i], i, 3, SpentTree.proof(leaves, i))
            );
        }
        // the odd last leaf is promoted past the first level, so its path has a single sibling
        assertEq(SpentTree.proof(leaves, 2).length, 1);
    }

    function test_availableFor() public {
        _deposit(keyHash, 100e6);
        assertEq(credits.availableFor(keyHash, 0), 100e6);
        assertEq(credits.availableFor(keyHash, 40e6), 60e6);
        assertEq(credits.availableFor(keyHash, 100e6), 0);
        assertEq(credits.availableFor(keyHash, 1000e6), 0);
        assertEq(credits.availableFor(bytes32(uint256(1)), 0), 0);
    }

    // =============================================================================================
    // Deposit
    // =============================================================================================

    function test_deposit_creditsKeyAndPullsFunds() public {
        uint256 balBefore = usdg.balanceOf(alice);
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.Deposited(keyHash, alice, 250e6);
        _deposit(keyHash, 250e6);
        assertEq(credits.deposited(keyHash), 250e6);
        assertEq(usdg.balanceOf(address(credits)), 250e6);
        assertEq(usdg.balanceOf(alice), balBefore - 250e6);
    }

    function test_deposit_revertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(ICredits.InvalidAmount.selector);
        credits.deposit(keyHash, 0);
    }

    function test_deposit_revertsWithoutAllowance() public {
        address bob = makeAddr("bob");
        usdg.mint(bob, 10e6);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(credits), 0, 10e6
            )
        );
        credits.deposit(keyHash, 10e6);
    }

    function testFuzz_deposit_accumulates(uint96 a, uint96 b, bytes32 kh) public {
        a = uint96(bound(a, 1, 5_000_000e6));
        b = uint96(bound(b, 1, 5_000_000e6));
        _deposit(kh, a);
        _deposit(kh, b);
        assertEq(credits.deposited(kh), uint256(a) + b);
        assertEq(usdg.balanceOf(address(credits)), uint256(a) + b);
    }

    function test_depositWithPermit_works() public {
        vm.prank(alice);
        usdg.approve(address(credits), 0);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(alicePk, alice, address(credits), 77e6, dl);
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.Deposited(keyHash, alice, 77e6);
        vm.prank(alice);
        credits.depositWithPermit(keyHash, 77e6, dl, v, r, s);
        assertEq(credits.deposited(keyHash), 77e6);
        assertEq(usdg.allowance(alice, address(credits)), 0);
    }

    function test_depositWithPermit_frontRunPermitStillDeposits() public {
        vm.prank(alice);
        usdg.approve(address(credits), 0);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(alicePk, alice, address(credits), 77e6, dl);
        // attacker front-runs the permit
        vm.prank(relayer);
        usdg.permit(alice, address(credits), 77e6, dl, v, r, s);
        vm.prank(alice);
        credits.depositWithPermit(keyHash, 77e6, dl, v, r, s);
        assertEq(credits.deposited(keyHash), 77e6);
    }

    function test_depositWithPermit_invalidPermitWithoutAllowanceReverts() public {
        vm.prank(alice);
        usdg.approve(address(credits), 0);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(credits), 0, 5e6)
        );
        credits.depositWithPermit(keyHash, 5e6, block.timestamp, 27, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function test_depositWithPermit_invalidPermitWithAllowanceStillDeposits() public {
        vm.prank(alice);
        credits.depositWithPermit(keyHash, 5e6, block.timestamp, 27, bytes32(uint256(1)), bytes32(uint256(2)));
        assertEq(credits.deposited(keyHash), 5e6);
    }

    function test_depositWithPermit_revertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(ICredits.InvalidAmount.selector);
        credits.depositWithPermit(keyHash, 0, block.timestamp, 0, 0, 0);
    }

    // =============================================================================================
    // Credit
    // =============================================================================================

    function test_credit_works() public {
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.Credited(keyHash, creditor, 12e6);
        vm.prank(creditor);
        credits.credit(keyHash, 12e6);
        assertEq(credits.deposited(keyHash), 12e6);
        assertEq(usdg.balanceOf(address(credits)), 12e6);
    }

    function test_credit_revertsNotCreditor() public {
        vm.prank(alice);
        vm.expectRevert(ICredits.NotCreditor.selector);
        credits.credit(keyHash, 1e6);
    }

    function test_credit_revertsOnZero() public {
        vm.prank(creditor);
        vm.expectRevert(ICredits.InvalidAmount.selector);
        credits.credit(keyHash, 0);
    }

    function test_setCreditor_revokes() public {
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.CreditorSet(creditor, false);
        vm.prank(owner);
        credits.setCreditor(creditor, false);
        assertFalse(credits.isCreditor(creditor));
        vm.prank(creditor);
        vm.expectRevert(ICredits.NotCreditor.selector);
        credits.credit(keyHash, 1e6);
    }

    function test_setCreditor_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        credits.setCreditor(alice, true);
    }

    function test_setCreditor_revertsZero() public {
        vm.prank(owner);
        vm.expectRevert(Credits.ZeroAddress.selector);
        credits.setCreditor(address(0), true);
    }

    // =============================================================================================
    // postSpentRoot
    // =============================================================================================

    function test_postSpentRoot_firstIsEpochOne() public {
        bytes32 root = keccak256("r1");
        _approveRoot(root, uint64(block.timestamp), 5e6);
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.SpentRootPosted(1, root, uint64(block.timestamp), 5e6);
        vm.prank(settlement);
        credits.postSpentRoot(root, uint64(block.timestamp), 5e6);
        assertEq(credits.latestEpoch(), 1);
        (bytes32 r, uint64 asOf, uint256 total) = credits.spentRoot(1);
        assertEq(r, root);
        assertEq(asOf, block.timestamp);
        assertEq(total, 5e6);
    }

    function test_postSpentRoot_sequentialEpochs() public {
        vm.startPrank(settlement);
        _approveRoot(keccak256("a"), uint64(block.timestamp - 100), 1);
        credits.postSpentRoot(keccak256("a"), uint64(block.timestamp - 100), 1);
        _approveRoot(keccak256("b"), uint64(block.timestamp - 50), 1);
        credits.postSpentRoot(keccak256("b"), uint64(block.timestamp - 50), 1);
        _approveRoot(keccak256("c"), uint64(block.timestamp), 9);
        credits.postSpentRoot(keccak256("c"), uint64(block.timestamp), 9);
        vm.stopPrank();
        assertEq(credits.latestEpoch(), 3);
        (bytes32 r2,,) = credits.spentRoot(2);
        assertEq(r2, keccak256("b"));
    }

    function test_postSpentRoot_revertsNotSettlement() public {
        vm.prank(owner);
        vm.expectRevert(ICredits.NotSettlement.selector);
        credits.postSpentRoot(keccak256("r"), uint64(block.timestamp), 0);
    }

    function test_postSpentRoot_revertsZeroAsOfFirst() public {
        vm.prank(settlement);
        vm.expectRevert(ICredits.StaleRoot.selector);
        credits.postSpentRoot(keccak256("r"), 0, 0);
    }

    function test_postSpentRoot_revertsStaleEqual() public {
        vm.startPrank(settlement);
        _approveRoot(keccak256("r"), uint64(block.timestamp), 0);
        credits.postSpentRoot(keccak256("r"), uint64(block.timestamp), 0);
        vm.expectRevert(ICredits.StaleRoot.selector);
        credits.postSpentRoot(keccak256("r2"), uint64(block.timestamp), 0);
        vm.stopPrank();
    }

    function test_postSpentRoot_revertsStaleLower() public {
        vm.startPrank(settlement);
        _approveRoot(keccak256("r"), uint64(block.timestamp), 0);
        credits.postSpentRoot(keccak256("r"), uint64(block.timestamp), 0);
        vm.expectRevert(ICredits.StaleRoot.selector);
        credits.postSpentRoot(keccak256("r2"), uint64(block.timestamp - 1), 0);
        vm.stopPrank();
    }

    function test_postSpentRoot_revertsFuture() public {
        vm.prank(settlement);
        vm.expectRevert(Credits.RootInFuture.selector);
        credits.postSpentRoot(keccak256("r"), uint64(block.timestamp + 1), 0);
    }

    function test_postSpentRoot_revertsSpentDecreased() public {
        vm.startPrank(settlement);
        _approveRoot(keccak256("r"), uint64(block.timestamp - 1), 10);
        credits.postSpentRoot(keccak256("r"), uint64(block.timestamp - 1), 10);
        vm.expectRevert(Credits.SpentDecreased.selector);
        credits.postSpentRoot(keccak256("r2"), uint64(block.timestamp), 9);
        // equal is fine
        _approveRoot(keccak256("r2"), uint64(block.timestamp), 10);
        credits.postSpentRoot(keccak256("r2"), uint64(block.timestamp), 10);
        vm.stopPrank();
    }

    function testFuzz_postSpentRoot_sequence(uint64[5] memory gaps, uint96[5] memory adds) public {
        uint64 t = uint64(block.timestamp);
        uint256 total;
        for (uint256 i; i < 5; ++i) {
            t += uint64(bound(gaps[i], 1, 30 days));
            total += adds[i];
            vm.warp(t);
            vm.prank(settlement);
            _approveRoot(bytes32(i + 1), t, total);
            credits.postSpentRoot(bytes32(i + 1), t, total);
        }
        assertEq(credits.latestEpoch(), 5);
        (bytes32 r, uint64 asOf, uint256 tot) = credits.spentRoot(5);
        assertEq(r, bytes32(uint256(5)));
        assertEq(asOf, t);
        assertEq(tot, total);
    }

    function test_spentRoot_unknownEpochIsZero() public view {
        (bytes32 r, uint64 asOf, uint256 tot) = credits.spentRoot(42);
        assertEq(r, bytes32(0));
        assertEq(asOf, 0);
        assertEq(tot, 0);
    }

    // =============================================================================================
    // requestWithdrawal
    // =============================================================================================

    function test_request_storesPendingAndIncrementsNonce() public {
        _deposit(keyHash, 100e6);
        bytes memory sig = _signRequest(keyPk, 40e6, recipient, block.timestamp + 1);
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.WithdrawalRequested(keyHash, recipient, 40e6, uint64(block.timestamp));
        vm.prank(relayer); // anyone can relay
        credits.requestWithdrawal(keyAddr, 40e6, recipient, block.timestamp + 1, sig);
        (uint256 amt, address to, uint64 at) = credits.pendingWithdrawal(keyHash);
        assertEq(amt, 40e6);
        assertEq(to, recipient);
        assertEq(at, block.timestamp);
        assertEq(credits.nonces(keyHash), 1);
    }

    function test_request_deadlineEqualNowOk() public {
        _request(1e6);
        (uint256 amt,,) = credits.pendingWithdrawal(keyHash);
        assertEq(amt, 1e6);
    }

    function test_request_allowedWithoutDeposit() public {
        _request(1e6); // bounded at finalization, not at request
        (uint256 amt,,) = credits.pendingWithdrawal(keyHash);
        assertEq(amt, 1e6);
    }

    function test_request_revertsZeroAmount() public {
        bytes memory sig = _signRequest(keyPk, 0, recipient, block.timestamp);
        vm.expectRevert(ICredits.InvalidAmount.selector);
        credits.requestWithdrawal(keyAddr, 0, recipient, block.timestamp, sig);
    }

    function test_request_revertsZeroTo() public {
        bytes memory sig = _signRequest(keyPk, 1e6, address(0), block.timestamp);
        vm.expectRevert(Credits.ZeroAddress.selector);
        credits.requestWithdrawal(keyAddr, 1e6, address(0), block.timestamp, sig);
    }

    function test_request_revertsExpired() public {
        uint256 dl = block.timestamp - 1;
        bytes memory sig = _signRequest(keyPk, 1e6, recipient, dl);
        vm.expectRevert(ICredits.Expired.selector);
        credits.requestWithdrawal(keyAddr, 1e6, recipient, dl, sig);
    }

    function test_request_revertsWrongSigner() public {
        bytes memory sig = _sign(0xBAD, _digest(keyHash, 1e6, recipient, 0, block.timestamp));
        vm.expectRevert(ICredits.BadSignature.selector);
        credits.requestWithdrawal(keyAddr, 1e6, recipient, block.timestamp, sig);
    }

    function test_request_revertsTamperedAmount() public {
        bytes memory sig = _signRequest(keyPk, 1e6, recipient, block.timestamp);
        vm.expectRevert(ICredits.BadSignature.selector);
        credits.requestWithdrawal(keyAddr, 2e6, recipient, block.timestamp, sig);
    }

    function test_request_revertsTamperedTo() public {
        bytes memory sig = _signRequest(keyPk, 1e6, recipient, block.timestamp);
        vm.expectRevert(ICredits.BadSignature.selector);
        credits.requestWithdrawal(keyAddr, 1e6, relayer, block.timestamp, sig);
    }

    function test_request_revertsTamperedDeadline() public {
        bytes memory sig = _signRequest(keyPk, 1e6, recipient, block.timestamp);
        vm.expectRevert(ICredits.BadSignature.selector);
        credits.requestWithdrawal(keyAddr, 1e6, recipient, block.timestamp + 1, sig);
    }

    function test_request_revertsWrongNonce() public {
        bytes memory sig = _sign(keyPk, _digest(keyHash, 1e6, recipient, 1, block.timestamp));
        vm.expectRevert(ICredits.BadSignature.selector);
        credits.requestWithdrawal(keyAddr, 1e6, recipient, block.timestamp, sig);
    }

    function test_request_revertsWrongChain() public {
        bytes32 structHash = keccak256(abi.encode(TYPEHASH, keyHash, 1e6, recipient, 0, block.timestamp));
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", _domainSeparator(1, address(credits)), structHash));
        bytes memory sig = _sign(keyPk, digest);
        vm.expectRevert(ICredits.BadSignature.selector);
        credits.requestWithdrawal(keyAddr, 1e6, recipient, block.timestamp, sig);
    }

    function test_request_revertsMalformedSignature() public {
        vm.expectRevert(ICredits.BadSignature.selector);
        credits.requestWithdrawal(keyAddr, 1e6, recipient, block.timestamp, hex"1234");
    }

    function test_request_revertsZeroKeyAddress() public {
        bytes memory sig = _signRequest(keyPk, 1e6, recipient, block.timestamp);
        vm.expectRevert(ICredits.BadSignature.selector);
        credits.requestWithdrawal(address(0), 1e6, recipient, block.timestamp, sig);
    }

    function test_request_revertsWhenPending() public {
        _request(1e6);
        bytes memory sig = _signRequest(keyPk, 2e6, recipient, block.timestamp);
        vm.expectRevert(ICredits.WithdrawalPending.selector);
        credits.requestWithdrawal(keyAddr, 2e6, recipient, block.timestamp, sig);
    }

    function test_request_signatureReplayFailsAfterFinalize() public {
        _deposit(keyHash, 10e6);
        bytes memory sig = _signRequest(keyPk, 1e6, recipient, block.timestamp);
        credits.requestWithdrawal(keyAddr, 1e6, recipient, block.timestamp, sig);
        _postSingle(keyHash, 0, 0);
        credits.finalizeWithdrawal(keyHash, 0, 0, 1, _empty());
        vm.expectRevert(ICredits.BadSignature.selector);
        credits.requestWithdrawal(keyAddr, 1e6, recipient, block.timestamp, sig);
    }

    function test_request_erc1271Wallet() public {
        uint256 ownerPk = 0x5AFE;
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(ownerPk));
        bytes32 kh = keccak256(abi.encodePacked(address(wallet)));
        bytes memory sig = _sign(ownerPk, _digest(kh, 3e6, recipient, 0, block.timestamp));
        credits.requestWithdrawal(address(wallet), 3e6, recipient, block.timestamp, sig);
        (uint256 amt,,) = credits.pendingWithdrawal(kh);
        assertEq(amt, 3e6);
        assertEq(credits.nonces(kh), 1);
    }

    function test_request_erc1271WalletBadSig() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(0x5AFE));
        bytes32 kh = keccak256(abi.encodePacked(address(wallet)));
        bytes memory sig = _sign(0xBAD, _digest(kh, 3e6, recipient, 0, block.timestamp));
        vm.expectRevert(ICredits.BadSignature.selector);
        credits.requestWithdrawal(address(wallet), 3e6, recipient, block.timestamp, sig);
    }

    function testFuzz_request_anyKey(uint256 pk, uint256 amount, address to) public {
        pk = bound(pk, 1, 115792089237316195423570985008687907852837564279074904382605163141518161494336);
        amount = bound(amount, 1, type(uint128).max);
        vm.assume(to != address(0));
        address ka = vm.addr(pk);
        bytes32 kh = keccak256(abi.encodePacked(ka));
        bytes memory sig = _signRequest(pk, amount, to, block.timestamp);
        credits.requestWithdrawal(ka, amount, to, block.timestamp, sig);
        (uint256 amt, address t,) = credits.pendingWithdrawal(kh);
        assertEq(amt, amount);
        assertEq(t, to);
    }

    // =============================================================================================
    // cancelWithdrawal
    // =============================================================================================

    function _signCancel(uint256 pk, uint256 deadline) internal view returns (bytes memory) {
        return _signRequest(pk, 0, address(0), deadline);
    }

    function test_cancel_clearsPending() public {
        _request(5e6);
        bytes memory sig = _signCancel(keyPk, block.timestamp);
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.WithdrawalCancelled(keyHash);
        vm.prank(relayer);
        credits.cancelWithdrawal(keyAddr, block.timestamp, sig);
        (uint256 amt, address to, uint64 at) = credits.pendingWithdrawal(keyHash);
        assertEq(amt, 0);
        assertEq(to, address(0));
        assertEq(at, 0);
        assertEq(credits.nonces(keyHash), 2);
    }

    function test_cancel_revertsNoPending() public {
        bytes memory sig = _signCancel(keyPk, block.timestamp);
        vm.expectRevert(ICredits.NoPendingWithdrawal.selector);
        credits.cancelWithdrawal(keyAddr, block.timestamp, sig);
    }

    function test_cancel_revertsExpired() public {
        _request(5e6);
        bytes memory sig = _signCancel(keyPk, block.timestamp - 1);
        vm.expectRevert(ICredits.Expired.selector);
        credits.cancelWithdrawal(keyAddr, block.timestamp - 1, sig);
    }

    function test_cancel_revertsWrongSigner() public {
        _request(5e6);
        bytes memory sig = _sign(0xBAD, _digest(keyHash, 0, address(0), 1, block.timestamp));
        vm.expectRevert(ICredits.BadSignature.selector);
        credits.cancelWithdrawal(keyAddr, block.timestamp, sig);
    }

    function test_cancel_rejectsRequestSignature() public {
        // a signature over a non-zero request can't be used to cancel
        bytes memory reqSig = _signRequest(keyPk, 5e6, recipient, block.timestamp);
        credits.requestWithdrawal(keyAddr, 5e6, recipient, block.timestamp, reqSig);
        bytes memory otherReq = _signRequest(keyPk, 5e6, recipient, block.timestamp);
        vm.expectRevert(ICredits.BadSignature.selector);
        credits.cancelWithdrawal(keyAddr, block.timestamp, otherReq);
    }

    function test_cancel_thenRequestAgain_andOldCancelNotReplayable() public {
        _request(5e6);
        bytes memory cancelSig = _signCancel(keyPk, block.timestamp);
        credits.cancelWithdrawal(keyAddr, block.timestamp, cancelSig);
        _request(6e6);
        vm.expectRevert(ICredits.BadSignature.selector);
        credits.cancelWithdrawal(keyAddr, block.timestamp, cancelSig);
        (uint256 amt,,) = credits.pendingWithdrawal(keyHash);
        assertEq(amt, 6e6);
    }

    function test_cancel_erc1271Wallet() public {
        uint256 ownerPk = 0x5AFE;
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(ownerPk));
        bytes32 kh = keccak256(abi.encodePacked(address(wallet)));
        credits.requestWithdrawal(
            address(wallet),
            3e6,
            recipient,
            block.timestamp,
            _sign(ownerPk, _digest(kh, 3e6, recipient, 0, block.timestamp))
        );
        credits.cancelWithdrawal(
            address(wallet), block.timestamp, _sign(ownerPk, _digest(kh, 0, address(0), 1, block.timestamp))
        );
        (uint256 amt,,) = credits.pendingWithdrawal(kh);
        assertEq(amt, 0);
    }

    // =============================================================================================
    // finalizeWithdrawal
    // =============================================================================================

    function test_finalize_revertsNoPending() public {
        vm.expectRevert(ICredits.NoPendingWithdrawal.selector);
        credits.finalizeWithdrawal(keyHash, 0, 0, 1, _empty());
    }

    function test_finalize_revertsRootTooOld_noRoot() public {
        _deposit(keyHash, 100e6);
        _request(10e6);
        vm.expectRevert(ICredits.RootTooOld.selector);
        credits.finalizeWithdrawal(keyHash, 0, 0, 1, _empty());
    }

    function test_finalize_revertsRootTooOld_olderRoot() public {
        _deposit(keyHash, 100e6);
        _postSingle(keyHash, 0, 0);
        vm.warp(block.timestamp + 1);
        _request(10e6);
        vm.expectRevert(ICredits.RootTooOld.selector);
        credits.finalizeWithdrawal(keyHash, 0, 0, 1, _empty());
    }

    function test_finalize_rootAtRequestTimestampOk() public {
        _deposit(keyHash, 100e6);
        _request(10e6);
        _postSingle(keyHash, 0, 0);
        credits.finalizeWithdrawal(keyHash, 0, 0, 1, _empty());
        assertEq(usdg.balanceOf(recipient), 10e6);
    }

    function test_finalize_paysRequested() public {
        _deposit(keyHash, 100e6);
        _request(50e6);
        vm.warp(block.timestamp + 1 hours);
        _postSingle(keyHash, 30e6, 30e6);

        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.Withdrawn(keyHash, recipient, 50e6);
        vm.prank(relayer); // anyone may finalize; funds go to `to`
        credits.finalizeWithdrawal(keyHash, 30e6, 0, 1, _empty());

        assertEq(usdg.balanceOf(recipient), 50e6);
        assertEq(usdg.balanceOf(relayer), 0);
        assertEq(credits.withdrawn(keyHash), 50e6);
        assertEq(usdg.balanceOf(address(credits)), 50e6);
        (uint256 amt,,) = credits.pendingWithdrawal(keyHash);
        assertEq(amt, 0);
    }

    function test_finalize_capsAtAvailable() public {
        _deposit(keyHash, 100e6);
        _request(100e6);
        vm.warp(block.timestamp + 1 hours);
        _postSingle(keyHash, 30e6, 30e6);
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.Withdrawn(keyHash, recipient, 70e6);
        credits.finalizeWithdrawal(keyHash, 30e6, 0, 1, _empty());
        assertEq(usdg.balanceOf(recipient), 70e6);
        assertEq(credits.withdrawn(keyHash), 70e6);
    }

    function test_finalize_paysZeroWhenFullySpent_stillClears() public {
        _deposit(keyHash, 100e6);
        _request(10e6);
        _postSingle(keyHash, 100e6, 100e6);
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.Withdrawn(keyHash, recipient, 0);
        credits.finalizeWithdrawal(keyHash, 100e6, 0, 1, _empty());
        assertEq(usdg.balanceOf(recipient), 0);
        assertEq(credits.withdrawn(keyHash), 0);
        (uint256 amt,,) = credits.pendingWithdrawal(keyHash);
        assertEq(amt, 0);
    }

    function test_finalize_floorsAtZeroWhenOverspent() public {
        _deposit(keyHash, 100e6);
        _request(10e6);
        _postSingle(keyHash, 150e6, 150e6);
        credits.finalizeWithdrawal(keyHash, 150e6, 0, 1, _empty());
        assertEq(usdg.balanceOf(recipient), 0);
    }

    function test_finalize_accountsForPreviousWithdrawals() public {
        _deposit(keyHash, 100e6);
        _request(60e6);
        _postSingle(keyHash, 10e6, 10e6);
        credits.finalizeWithdrawal(keyHash, 10e6, 0, 1, _empty());
        assertEq(usdg.balanceOf(recipient), 60e6);

        vm.warp(block.timestamp + 1);
        _request(60e6);
        vm.warp(block.timestamp + 1);
        _postSingle(keyHash, 20e6, 20e6);
        credits.finalizeWithdrawal(keyHash, 20e6, 0, 1, _empty());
        // 100 - 20 - 60 = 20
        assertEq(usdg.balanceOf(recipient), 80e6);
        assertEq(credits.withdrawn(keyHash), 80e6);
        assertEq(credits.availableFor(keyHash, 20e6), 0);
    }

    function test_finalize_depositAfterRootCounts() public {
        _deposit(keyHash, 10e6);
        _request(30e6);
        _postSingle(keyHash, 5e6, 5e6);
        _deposit(keyHash, 20e6); // on-chain deposits are always current
        credits.finalizeWithdrawal(keyHash, 5e6, 0, 1, _empty());
        assertEq(usdg.balanceOf(recipient), 25e6);
    }

    function test_finalize_multiKeyTree() public {
        uint256 n = 7;
        bytes32[] memory khs = new bytes32[](n);
        uint256[] memory spents = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 pk = 0x1000 + i;
            khs[i] = keccak256(abi.encodePacked(vm.addr(pk)));
            spents[i] = (i + 1) * 3e6;
            _deposit(khs[i], 100e6);
            bytes memory sig = _signRequest(pk, 200e6, recipient, block.timestamp);
            credits.requestWithdrawal(vm.addr(pk), 200e6, recipient, block.timestamp, sig);
        }
        SpentTree.sort(khs, spents);
        bytes32[] memory leaves = SpentTree.leaves(khs, spents);
        vm.warp(block.timestamp + 1 hours);
        _postTree(khs, spents, 84e6);
        uint256 expected;
        for (uint256 i; i < n; ++i) {
            credits.finalizeWithdrawal(khs[i], spents[i], i, n, SpentTree.proof(leaves, i));
            expected += 100e6 - spents[i];
        }
        assertEq(usdg.balanceOf(recipient), expected);
        assertEq(usdg.balanceOf(address(credits)), 84e6);
    }

    function test_finalize_revertsInvalidProof_wrongSpent() public {
        _deposit(keyHash, 100e6);
        _request(10e6);
        _postSingle(keyHash, 30e6, 30e6);
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 29e6, 0, 1, _empty());
    }

    function test_finalize_revertsInvalidProof_otherKeysLeaf() public {
        bytes32[] memory keys = new bytes32[](2);
        uint256[] memory spents = new uint256[](2);
        (keys[0], spents[0]) = (keyHash, 90e6);
        (keys[1], spents[1]) = (keccak256("other"), 0);
        SpentTree.sort(keys, spents);
        uint256 mine = keys[0] == keyHash ? 0 : 1;
        bytes32[] memory leaves = SpentTree.leaves(keys, spents);
        _deposit(keyHash, 100e6);
        _request(10e6);
        _postTree(keys, spents, 90e6);
        // try using other key's leaf/proof for our key
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 0, 1 - mine, 2, SpentTree.proof(leaves, 1 - mine));
        // our leaf proven at the other key's position
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 90e6, 1 - mine, 2, SpentTree.proof(leaves, mine));
        // the correct proof works
        credits.finalizeWithdrawal(keyHash, 90e6, mine, 2, SpentTree.proof(leaves, mine));
        assertEq(usdg.balanceOf(recipient), 10e6);
    }

    function test_finalize_revertsInvalidProof_innerNodeAsLeaf() public {
        bytes32[] memory keys = new bytes32[](4);
        uint256[] memory spents = new uint256[](4);
        for (uint256 i; i < 4; ++i) {
            (keys[i], spents[i]) = (bytes32(i), i);
        }
        bytes32[] memory leaves = SpentTree.leaves(keys, spents);
        _deposit(keyHash, 100e6);
        _request(10e6);
        _postTree(keys, spents, 6);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = SpentTree.node(leaves[2], leaves[3]);
        // a one-level path only fits a tree of two leaves, which the root does not commit to
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 0, 0, 2, proof);
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 0, 0, 4, proof);
    }

    function test_finalize_revertsInvalidProof_wrongShape() public {
        bytes32[] memory keys = new bytes32[](3);
        uint256[] memory spents = new uint256[](3);
        (keys[0], keys[1], keys[2]) = (bytes32(uint256(1)), keyHash, bytes32(type(uint256).max));
        (spents[0], spents[1], spents[2]) = (5, 7e6, 9);
        bytes32[] memory leaves = SpentTree.leaves(keys, spents);
        bytes32[] memory proof = SpentTree.proof(leaves, 1);
        _deposit(keyHash, 100e6);
        _request(100e6);
        _postTree(keys, spents, 7e6 + 14);
        // wrong leaf count, wrong index, out-of-range index, truncated and padded paths
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 7e6, 1, 2, proof);
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 7e6, 1, 4, proof);
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 7e6, 0, 3, proof);
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 7e6, 3, 3, proof);
        bytes32[] memory shortProof = new bytes32[](1);
        shortProof[0] = proof[0];
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 7e6, 1, 3, shortProof);
        bytes32[] memory longProof = new bytes32[](3);
        (longProof[0], longProof[1]) = (proof[0], proof[1]);
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 7e6, 1, 3, longProof);
        credits.finalizeWithdrawal(keyHash, 7e6, 1, 3, proof);
        assertEq(usdg.balanceOf(recipient), 93e6);
    }

    function test_finalize_usesLatestRootOnly() public {
        _deposit(keyHash, 100e6);
        _request(100e6);
        _postSingle(keyHash, 10e6, 10e6);
        vm.warp(block.timestamp + 1);
        _postSingle(keyHash, 40e6, 40e6);
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 10e6, 0, 1, _empty());
        credits.finalizeWithdrawal(keyHash, 40e6, 0, 1, _empty());
        assertEq(usdg.balanceOf(recipient), 60e6);
    }

    function test_finalize_escapeHatch() public {
        _deposit(keyHash, 100e6);
        _postSingle(keyHash, 20e6, 20e6);
        vm.warp(block.timestamp + 1 hours);
        _request(100e6);
        uint256 requestedAt = block.timestamp;

        vm.warp(requestedAt + 7 days - 1);
        vm.expectRevert(ICredits.RootTooOld.selector);
        credits.finalizeWithdrawal(keyHash, 20e6, 0, 1, _empty());

        vm.warp(requestedAt + 7 days);
        credits.finalizeWithdrawal(keyHash, 20e6, 0, 1, _empty());
        assertEq(usdg.balanceOf(recipient), 80e6);
    }

    function test_finalize_escapeHatchStillNeedsValidProof() public {
        _deposit(keyHash, 100e6);
        _request(100e6);
        vm.warp(block.timestamp + 7 days);
        // no root ever posted: the genesis root is the empty tree, which has no leaves to include
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 0, 0, 1, _empty());
    }

    function test_finalize_escapeHatch_genesisIsEmptyTree() public {
        _deposit(keyHash, 100e6);
        _request(100e6);
        ICredits.SpentLeafProof memory s = SpentTree.sentinel();
        // settlement never posted: after the escape delay the key is provably absent from the empty tree
        vm.warp(block.timestamp + 7 days - 1);
        vm.expectRevert(ICredits.RootTooOld.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 0, 0, s, s);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(ICredits.NotBracketed.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 0, 1, s, s);
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 1, 1, s, s);
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.AbsenceProven(keyHash, 0);
        credits.finalizeWithdrawalAbsent(keyHash, 0, 0, s, s);
        assertEq(usdg.balanceOf(recipient), 100e6);
        assertEq(credits.withdrawn(keyHash), 100e6);
    }

    function testFuzz_finalize(uint256 dep, uint256 spent, uint256 req) public {
        dep = bound(dep, 1, 5_000_000e6);
        spent = bound(spent, 0, 10_000_000e6);
        req = bound(req, 1, 10_000_000e6);
        _deposit(keyHash, dep);
        _request(req);
        _postSingle(keyHash, spent, spent);
        credits.finalizeWithdrawal(keyHash, spent, 0, 1, _empty());
        uint256 avail = dep > spent ? dep - spent : 0;
        uint256 expected = req < avail ? req : avail;
        assertEq(usdg.balanceOf(recipient), expected);
        assertEq(credits.withdrawn(keyHash), expected);
        assertEq(usdg.balanceOf(address(credits)), dep - expected);
    }

    // =============================================================================================
    // finalizeWithdrawalAbsent: non-inclusion proofs
    // =============================================================================================

    /// Four other keys around keyHash (two below, two above), sorted, with some spend. keyHash is gap 2.
    function _others() internal view returns (bytes32[] memory keys, uint256[] memory spents) {
        uint256 k = uint256(keyHash);
        keys = new bytes32[](4);
        spents = new uint256[](4);
        (keys[0], keys[1], keys[2], keys[3]) =
        (bytes32(k - 7), bytes32(k - 1), bytes32(k + 1), bytes32(k + 9));
        (spents[0], spents[1], spents[2], spents[3]) = (1e6, 2e6, 3e6, 4e6);
    }

    /// The same four keys plus keyHash itself (index 2) with `spent`.
    function _othersWithKey(uint256 spent)
        internal
        view
        returns (bytes32[] memory keys, uint256[] memory spents)
    {
        (bytes32[] memory o, uint256[] memory os) = _others();
        keys = new bytes32[](5);
        spents = new uint256[](5);
        (keys[0], keys[1], keys[2], keys[3], keys[4]) = (o[0], o[1], keyHash, o[2], o[3]);
        (spents[0], spents[1], spents[2], spents[3], spents[4]) = (os[0], os[1], spent, os[2], os[3]);
    }

    function test_absent_paysDepositMinusWithdrawn() public {
        (bytes32[] memory keys, uint256[] memory spents) = _others();
        _deposit(keyHash, 100e6);
        _request(100e6);
        _postTree(keys, spents, 10e6);
        ICredits.SpentLeafProof memory below = SpentTree.neighbour(keys, spents, 1);
        ICredits.SpentLeafProof memory above = SpentTree.neighbour(keys, spents, 2);
        assertTrue(credits.verifySpentAbsence(SpentTree.root(keys, spents), keyHash, 4, 2, below, above));
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.AbsenceProven(keyHash, 1);
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.Withdrawn(keyHash, recipient, 100e6);
        vm.prank(relayer); // permissionless; funds go to the requested `to`
        credits.finalizeWithdrawalAbsent(keyHash, 4, 2, below, above);
        assertEq(usdg.balanceOf(recipient), 100e6);
        assertEq(usdg.balanceOf(relayer), 0);
        assertEq(credits.withdrawn(keyHash), 100e6);
        (uint256 amt,,) = credits.pendingWithdrawal(keyHash);
        assertEq(amt, 0);
        vm.expectRevert(ICredits.NoPendingWithdrawal.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 4, 2, below, above);
    }

    function test_absent_capsAtRequestAndCountsPriorWithdrawals() public {
        (bytes32[] memory keys, uint256[] memory spents) = _others();
        _deposit(keyHash, 100e6);
        _request(30e6);
        _postSingle(keyHash, 0, 0);
        credits.finalizeWithdrawal(keyHash, 0, 0, 1, _empty());
        // later roots omit the key: spend 0, but the 30 already withdrawn still counts
        vm.warp(block.timestamp + 1 hours);
        _request(50e6);
        _postTree(keys, spents, 10e6);
        _finalizeAbsent(keyHash, keys, spents);
        assertEq(usdg.balanceOf(recipient), 80e6);
        vm.warp(block.timestamp + 1 hours);
        _request(100e6);
        _postTree(keys, spents, 10e6);
        _finalizeAbsent(keyHash, keys, spents);
        assertEq(usdg.balanceOf(recipient), 100e6);
        vm.warp(block.timestamp + 1 hours);
        _request(1e6);
        _postTree(keys, spents, 10e6);
        _finalizeAbsent(keyHash, keys, spents);
        assertEq(usdg.balanceOf(recipient), 100e6);
        assertEq(credits.withdrawn(keyHash), 100e6);
    }

    function test_absent_sentinels() public {
        uint256 k = uint256(keyHash);
        bytes32[] memory keys = new bytes32[](3);
        uint256[] memory spents = new uint256[](3);
        ICredits.SpentLeafProof memory junk;
        junk.keyHash = keyHash; // a sentinel's argument is ignored, whatever it holds
        junk.cumulativeSpent = 1;
        junk.proof = new bytes32[](2);
        _deposit(keyHash, 100e6);

        // every key is above keyHash: it sits between the low sentinel and leaf 0 (gap 0)
        (keys[0], keys[1], keys[2]) = (bytes32(k + 1), bytes32(k + 2), bytes32(k + 3));
        _request(10e6);
        _postTree(keys, spents, 0);
        vm.expectRevert(ICredits.NotBracketed.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 3, 3, SpentTree.neighbour(keys, spents, 2), junk);
        credits.finalizeWithdrawalAbsent(keyHash, 3, 0, junk, SpentTree.neighbour(keys, spents, 0));
        assertEq(usdg.balanceOf(recipient), 10e6);

        // every key is below keyHash: it sits between leaf 2 and the high sentinel (gap = leafCount)
        (keys[0], keys[1], keys[2]) = (bytes32(k - 3), bytes32(k - 2), bytes32(k - 1));
        vm.warp(block.timestamp + 1);
        _request(10e6);
        _postTree(keys, spents, 0);
        vm.expectRevert(ICredits.NotBracketed.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 3, 0, junk, SpentTree.neighbour(keys, spents, 0));
        // the high sentinel cannot be moved down: claiming two leaves does not match the commitment
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 2, 2, SpentTree.neighbour(keys, spents, 1), junk);
        credits.finalizeWithdrawalAbsent(keyHash, 3, 3, SpentTree.neighbour(keys, spents, 2), junk);
        assertEq(usdg.balanceOf(recipient), 20e6);

        // a one-leaf tree, and the extreme key hashes as leaves
        bytes32[] memory one = new bytes32[](1);
        uint256[] memory oneSpent = new uint256[](1);
        one[0] = bytes32(type(uint256).max);
        vm.warp(block.timestamp + 1);
        _request(10e6);
        _postTree(one, oneSpent, 0);
        credits.finalizeWithdrawalAbsent(keyHash, 1, 0, junk, SpentTree.neighbour(one, oneSpent, 0));
        one[0] = bytes32(0);
        vm.warp(block.timestamp + 1);
        _request(10e6);
        _postTree(one, oneSpent, 0);
        credits.finalizeWithdrawalAbsent(keyHash, 1, 1, SpentTree.neighbour(one, oneSpent, 0), junk);
        assertEq(usdg.balanceOf(recipient), 40e6);
    }

    function test_absent_revertsWhenNeighboursDoNotBracket() public {
        (bytes32[] memory keys, uint256[] memory spents) = _others();
        _deposit(keyHash, 100e6);
        _request(100e6);
        _postTree(keys, spents, 10e6);
        ICredits.SpentLeafProof[] memory nb = new ICredits.SpentLeafProof[](4);
        for (uint256 i; i < 4; ++i) {
            nb[i] = SpentTree.neighbour(keys, spents, i);
        }
        // adjacent leaves that are both below, or both above, the key
        vm.expectRevert(ICredits.NotBracketed.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 4, 1, nb[0], nb[1]);
        vm.expectRevert(ICredits.NotBracketed.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 4, 3, nb[2], nb[3]);
        // swapped neighbours, sentinel gaps on the wrong side, and a gap past the high sentinel
        vm.expectRevert(ICredits.NotBracketed.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 4, 2, nb[2], nb[1]);
        vm.expectRevert(ICredits.NotBracketed.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 4, 0, nb[0], nb[0]);
        vm.expectRevert(ICredits.NotBracketed.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 4, 4, nb[3], nb[3]);
        vm.expectRevert(ICredits.NotBracketed.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 4, 5, nb[3], nb[3]);
        // bracketing keys that are not adjacent in the tree
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 4, 2, nb[0], nb[2]);
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 4, 2, nb[1], nb[3]);
        // a neighbour with an edited spend or a stale path, or the wrong leaf count
        ICredits.SpentLeafProof memory edited = SpentTree.neighbour(keys, spents, 1);
        edited.cumulativeSpent += 1;
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 4, 2, edited, nb[2]);
        edited = SpentTree.neighbour(keys, spents, 1);
        edited.proof = nb[2].proof;
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 4, 2, edited, nb[2]);
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 5, 2, nb[1], nb[2]);
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 0, 0, nb[1], nb[2]);
        // the adjacent bracketing pair works
        credits.finalizeWithdrawalAbsent(keyHash, 4, 2, nb[1], nb[2]);
        assertEq(usdg.balanceOf(recipient), 100e6);
    }

    function test_absent_impossibleForIncludedKey() public {
        (bytes32[] memory keys, uint256[] memory spents) = _othersWithKey(40e6);
        _deposit(keyHash, 100e6);
        _request(100e6);
        _postTree(keys, spents, 50e6);
        // no gap of a sorted tree brackets a key it contains
        for (uint256 gap; gap <= keys.length; ++gap) {
            vm.expectRevert(ICredits.NotBracketed.selector);
            credits.finalizeWithdrawalAbsent(
                keyHash, 5, gap, _below(keys, spents, gap), _above(keys, spents, gap)
            );
        }
        // and the neighbours of the key's own leaf cannot be passed off as adjacent
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawalAbsent(
            keyHash, 5, 2, SpentTree.neighbour(keys, spents, 1), SpentTree.neighbour(keys, spents, 3)
        );
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawalAbsent(
            keyHash, 5, 3, SpentTree.neighbour(keys, spents, 1), SpentTree.neighbour(keys, spents, 3)
        );
        // nor can the key hide behind a moved high sentinel
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawalAbsent(
            keyHash, 2, 2, SpentTree.neighbour(keys, spents, 1), SpentTree.sentinel()
        );
        credits.finalizeWithdrawal(keyHash, 40e6, 2, 5, SpentTree.proof(SpentTree.leaves(keys, spents), 2));
        assertEq(usdg.balanceOf(recipient), 60e6);
    }

    function test_absent_timingFollowsTheWithdrawalDelay() public {
        (bytes32[] memory keys, uint256[] memory spents) = _others();
        _deposit(keyHash, 100e6);
        _postTree(keys, spents, 10e6);
        vm.warp(block.timestamp + 1 hours);
        _request(100e6);
        uint256 requestedAt = block.timestamp;
        vm.expectRevert(ICredits.RootTooOld.selector);
        _finalizeAbsent(keyHash, keys, spents);
        vm.warp(requestedAt + 7 days - 1);
        vm.expectRevert(ICredits.RootTooOld.selector);
        _finalizeAbsent(keyHash, keys, spents);
        vm.warp(requestedAt + 7 days);
        _finalizeAbsent(keyHash, keys, spents);
        assertEq(usdg.balanceOf(recipient), 100e6);
    }

    function test_absent_nextRootAccountsForAbsenceWithdrawal_noDoubleSpend() public {
        (bytes32[] memory others, uint256[] memory otherSpents) = _others();
        _deposit(keyHash, 100e6);
        // the router served 30 of usage, then its root omitted the key: the key exits with all 100
        _request(100e6);
        _postTree(others, otherSpents, 10e6);
        _finalizeAbsent(keyHash, others, otherSpents);
        assertEq(credits.withdrawn(keyHash), 100e6);

        // settlement's next root caps the key at deposited - withdrawn = 0 (the 30 is its loss)
        (bytes32[] memory keys, uint256[] memory spents) = _othersWithKey(0);
        vm.warp(block.timestamp + 1 hours);
        _request(1e6);
        _postTree(keys, spents, 10e6);
        credits.finalizeWithdrawal(keyHash, 0, 2, 5, SpentTree.proof(SpentTree.leaves(keys, spents), 2));
        assertEq(credits.withdrawn(keyHash), 100e6);

        // a root that re-counts the old usage cannot pay twice either, and absence no longer applies
        (keys, spents) = _othersWithKey(30e6);
        vm.warp(block.timestamp + 1 hours);
        _request(1e6);
        _postTree(keys, spents, 40e6);
        vm.expectRevert(ICredits.NotBracketed.selector);
        credits.finalizeWithdrawalAbsent(keyHash, 5, 2, _below(keys, spents, 2), _above(keys, spents, 2));
        credits.finalizeWithdrawal(keyHash, 30e6, 2, 5, SpentTree.proof(SpentTree.leaves(keys, spents), 2));
        assertEq(credits.withdrawn(keyHash), 100e6);

        // a new deposit: the later root's spend nets against every earlier withdrawal
        _deposit(keyHash, 50e6);
        (keys, spents) = _othersWithKey(20e6);
        vm.warp(block.timestamp + 1 hours);
        _request(100e6);
        _postTree(keys, spents, 40e6);
        credits.finalizeWithdrawal(keyHash, 20e6, 2, 5, SpentTree.proof(SpentTree.leaves(keys, spents), 2));
        assertEq(credits.withdrawn(keyHash), 130e6);
        assertEq(usdg.balanceOf(recipient), 130e6);
        assertEq(usdg.balanceOf(address(credits)), 20e6);
        assertLe(credits.withdrawn(keyHash), credits.deposited(keyHash));
    }

    function test_absent_laterOmissionIsSettlementsLoss() public {
        _deposit(keyHash, 100e6);
        _request(10e6);
        _postSingle(keyHash, 30e6, 30e6);
        credits.finalizeWithdrawal(keyHash, 30e6, 0, 1, _empty());
        // the key was in the last root with 30 spent; a root that drops it releases that spend
        (bytes32[] memory keys, uint256[] memory spents) = _others();
        vm.warp(block.timestamp + 1 hours);
        _request(100e6);
        _postTree(keys, spents, 30e6);
        _finalizeAbsent(keyHash, keys, spents);
        assertEq(usdg.balanceOf(recipient), 100e6);
        assertEq(credits.withdrawn(keyHash), credits.deposited(keyHash));
    }

    function test_malformedTree_keyFinalizesWithLowestProvableSpend() public {
        uint256 k = uint256(keyHash);
        _deposit(keyHash, 100e6);
        // duplicated leaves: either verifies, and the key picks the lower spend
        bytes32[] memory keys = new bytes32[](3);
        uint256[] memory spents = new uint256[](3);
        (keys[0], keys[1], keys[2]) = (keyHash, bytes32(k + 5), keyHash);
        (spents[0], spents[1], spents[2]) = (50e6, 0, 10e6);
        bytes32[] memory leaves = SpentTree.leaves(keys, spents);
        _request(100e6);
        _postTree(keys, spents, 60e6);
        assertTrue(
            credits.verifySpentInclusion(
                SpentTree.root(keys, spents), keyHash, 50e6, 0, 3, SpentTree.proof(leaves, 0)
            )
        );
        credits.finalizeWithdrawal(keyHash, 10e6, 2, 3, SpentTree.proof(leaves, 2));
        assertEq(usdg.balanceOf(recipient), 90e6);

        // unsorted: the key has a leaf, yet an adjacent pair still brackets it; the lower (0) wins
        (keys[0], keys[1], keys[2]) = (bytes32(k + 5), keyHash, bytes32(k - 5));
        (spents[0], spents[1], spents[2]) = (0, 10e6, 0);
        _deposit(keyHash, 10e6);
        vm.warp(block.timestamp + 1);
        _request(100e6);
        _postTree(keys, spents, 60e6);
        credits.finalizeWithdrawalAbsent(
            keyHash, 3, 0, SpentTree.sentinel(), SpentTree.neighbour(keys, spents, 0)
        );
        assertEq(usdg.balanceOf(recipient), 110e6);
    }

    /// In a sorted tree, a key either has exactly one provable leaf or exactly one bracketing gap.
    function testFuzz_inclusionXorAbsence(uint256 seed, uint256 n, uint256 pick, bool present) public view {
        n = bound(n, 0, 17);
        bytes32[] memory keys = new bytes32[](n);
        uint256[] memory spents = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            keys[i] = keccak256(abi.encode(seed, i));
            spents[i] = uint256(keccak256(abi.encode(seed, i, "spent"))) % 1e15;
        }
        SpentTree.sort(keys, spents);
        bytes32 root = SpentTree.root(keys, spents);
        bytes32[] memory leaves = SpentTree.leaves(keys, spents);
        bytes32 probe = present && n != 0 ? keys[pick % n] : keccak256(abi.encode(seed, pick, "absent"));

        uint256 inclusions;
        for (uint256 i; i < n; ++i) {
            if (credits.verifySpentInclusion(root, probe, spents[i], i, n, SpentTree.proof(leaves, i))) {
                ++inclusions;
            }
        }
        uint256 absences;
        for (uint256 gap; gap <= n; ++gap) {
            if (credits.verifySpentAbsence(
                    root, probe, n, gap, _below(keys, spents, gap), _above(keys, spents, gap)
                )) {
                ++absences;
            }
        }
        assertEq(inclusions, present && n != 0 ? 1 : 0);
        assertEq(absences, present && n != 0 ? 0 : 1);
    }

    /// Completeness needs no honest sorting: in any tree (unsorted, duplicated) an absent key is bracketed.
    function testFuzz_absentKeyIsBracketedInAnyTree(uint256 seed, uint256 n, uint256 probeSeed) public view {
        n = bound(n, 0, 12);
        uint256 probe = bound(probeSeed, 8, type(uint256).max - 8);
        bytes32[] memory keys = new bytes32[](n);
        uint256[] memory spents = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 offset = 1 + uint256(keccak256(abi.encode(seed, i))) % 4;
            keys[i] = bytes32(
                uint256(keccak256(abi.encode(seed, i, "side"))) % 2 == 0 ? probe - offset : probe + offset
            );
            spents[i] = i;
        }
        bytes32 root = SpentTree.root(keys, spents);
        bool found;
        for (uint256 gap; gap <= n && !found; ++gap) {
            found = credits.verifySpentAbsence(
                root, bytes32(probe), n, gap, _below(keys, spents, gap), _above(keys, spents, gap)
            );
        }
        assertTrue(found);
    }

    function testFuzz_absentWithdrawal(uint256 dep, uint256 prior, uint256 req) public {
        dep = bound(dep, 1, 5_000_000e6);
        prior = bound(prior, 0, dep);
        req = bound(req, 1, 10_000_000e6);
        (bytes32[] memory keys, uint256[] memory spents) = _others();
        _deposit(keyHash, dep);
        if (prior != 0) {
            _request(prior);
            _postSingle(keyHash, 0, 0);
            credits.finalizeWithdrawal(keyHash, 0, 0, 1, _empty());
            vm.warp(block.timestamp + 1);
        }
        _request(req);
        _postTree(keys, spents, 10e6);
        _finalizeAbsent(keyHash, keys, spents);
        uint256 expected = req < dep - prior ? req : dep - prior;
        assertEq(usdg.balanceOf(recipient), prior + expected);
        assertEq(credits.withdrawn(keyHash), prior + expected);
        assertLe(credits.withdrawn(keyHash), dep);
        assertEq(usdg.balanceOf(address(credits)), dep - prior - expected);
    }

    // =============================================================================================
    // sweep
    // =============================================================================================

    function test_sweep_revertsNotSettlement() public {
        vm.prank(owner);
        vm.expectRevert(ICredits.NotSettlement.selector);
        credits.sweep(owner, 1);
    }

    function test_sweep_revertsZeroAmount() public {
        vm.prank(settlement);
        vm.expectRevert(ICredits.InvalidAmount.selector);
        credits.sweep(recipient, 0);
    }

    function test_sweep_revertsZeroTo() public {
        vm.prank(settlement);
        vm.expectRevert(Credits.ZeroAddress.selector);
        credits.sweep(address(0), 1);
    }

    function test_sweep_revertsWithoutRoot() public {
        _deposit(keyHash, 100e6);
        vm.prank(settlement);
        vm.expectRevert(ICredits.SweepExceedsSpent.selector);
        credits.sweep(recipient, 1);
    }

    function test_sweep_boundedByTotalSpent() public {
        _deposit(keyHash, 100e6);
        _postSingle(keyHash, 40e6, 40e6);
        _approveSweep(recipient, 25e6);
        vm.startPrank(settlement);
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.Swept(recipient, 25e6);
        credits.sweep(recipient, 25e6);
        vm.expectRevert(ICredits.SweepExceedsSpent.selector);
        credits.sweep(recipient, 15e6 + 1);
        _approveSweep(recipient, 15e6);
        credits.sweep(recipient, 15e6);
        vm.expectRevert(ICredits.SweepExceedsSpent.selector);
        credits.sweep(recipient, 1);
        vm.stopPrank();
        assertEq(credits.totalSwept(), 40e6);
        assertEq(usdg.balanceOf(recipient), 40e6);
        assertEq(usdg.balanceOf(address(credits)), 60e6);

        vm.warp(block.timestamp + 1);
        _postSingle(keyHash, 50e6, 50e6);
        vm.prank(settlement);
        _approveSweep(recipient, 10e6);
        credits.sweep(recipient, 10e6);
        assertEq(credits.totalSwept(), 50e6);
    }

    function testFuzz_sweep(uint256 dep, uint256 spent, uint256 amt) public {
        dep = bound(dep, 1, 5_000_000e6);
        spent = bound(spent, 0, dep);
        amt = bound(amt, 1, dep);
        _deposit(keyHash, dep);
        _postSingle(keyHash, spent, spent);
        vm.prank(settlement);
        if (amt > spent) {
            vm.expectRevert(ICredits.SweepExceedsSpent.selector);
            credits.sweep(recipient, amt);
        } else {
            _approveSweep(recipient, amt);
            credits.sweep(recipient, amt);
            assertEq(usdg.balanceOf(recipient), amt);
            assertEq(credits.totalSwept(), amt);
        }
    }

    // =============================================================================================
    // Admin
    // =============================================================================================

    function test_setSettlement() public {
        address s2 = makeAddr("s2");
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.SettlementSet(s2);
        vm.prank(owner);
        credits.setSettlement(s2);
        assertEq(credits.settlement(), s2);
        vm.prank(settlement);
        vm.expectRevert(ICredits.NotSettlement.selector);
        credits.postSpentRoot(keccak256("r"), uint64(block.timestamp), 0);
        vm.prank(s2);
        _approveRoot(keccak256("r"), uint64(block.timestamp), 0);
        credits.postSpentRoot(keccak256("r"), uint64(block.timestamp), 0);
    }

    function test_setSettlement_onlyOwner() public {
        vm.prank(settlement);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, settlement));
        credits.setSettlement(settlement);
    }

    function test_setSettlement_revertsZero() public {
        vm.prank(owner);
        vm.expectRevert(Credits.ZeroAddress.selector);
        credits.setSettlement(address(0));
    }

    function test_ownership_twoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        credits.transferOwnership(newOwner);
        assertEq(credits.owner(), owner);
        assertEq(credits.pendingOwner(), newOwner);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        credits.acceptOwnership();
        vm.prank(newOwner);
        credits.acceptOwnership();
        assertEq(credits.owner(), newOwner);
    }
}

/// Production-sized trees (also the gas benchmark: forge test --match-contract CreditsLargeTreeTest --gas-report).
contract CreditsLargeTreeTest is CreditsBase {
    uint256 internal constant N = 1024;

    /// N keys evenly spread over the key space (already sorted); keyHash falls between keys[pos] and
    /// keys[pos + 1], or replaces keys[pos] when `withKey`.
    function _spread(bool withKey)
        internal
        view
        returns (bytes32[] memory keys, uint256[] memory spents, uint256 pos)
    {
        uint256 step = type(uint256).max / N;
        pos = uint256(keyHash) / step;
        require(pos + 1 < N && uint256(keyHash) % step != 0, "keyHash placement");
        keys = new bytes32[](N);
        spents = new uint256[](N);
        for (uint256 i; i < N; ++i) {
            (keys[i], spents[i]) = (bytes32(i * step), 1e6);
        }
        if (withKey) (keys[pos], spents[pos]) = (keyHash, 10e6);
    }

    function test_largeTree_inclusion() public {
        (bytes32[] memory keys, uint256[] memory spents, uint256 pos) = _spread(true);
        _deposit(keyHash, 100e6);
        _request(100e6);
        _postTree(keys, spents, N * 1e6 + 9e6);
        bytes32[] memory proof = SpentTree.proof(SpentTree.leaves(keys, spents), pos);
        assertEq(proof.length, 10);
        credits.finalizeWithdrawal(keyHash, 10e6, pos, N, proof);
        assertEq(usdg.balanceOf(recipient), 90e6);
    }

    function test_largeTree_absence() public {
        (bytes32[] memory keys, uint256[] memory spents, uint256 pos) = _spread(false);
        _deposit(keyHash, 100e6);
        _request(100e6);
        _postTree(keys, spents, N * 1e6);
        credits.finalizeWithdrawalAbsent(
            keyHash,
            N,
            pos + 1,
            SpentTree.neighbour(keys, spents, pos),
            SpentTree.neighbour(keys, spents, pos + 1)
        );
        assertEq(usdg.balanceOf(recipient), 100e6);
    }
}

// =================================================================================================
// Invariants. Honest settlement: sum_k (deposited - spent - withdrawn) + totalSpent - totalSwept ==
// USDG balance. Omitting settlement: every exit still finalizes, pays exactly what the latest root
// proves, and the only shortfall is usage settlement lost to its own omissions.
// =================================================================================================

contract CreditsHandler is CommonBase, StdCheats, StdUtils {
    uint256 internal constant N = 5;

    Credits public immutable credits;
    MockUSDG public immutable usdg;
    address public immutable settlement;
    address public immutable creditor;
    address public immutable depositor;
    address public immutable sink;
    /// Settlement leaves funded keys out of its roots at random (a buggy or malicious router).
    bool public immutable omitting;

    uint256[N] public pks;
    address[N] public keyAddrs;
    bytes32[N] public keyHashes;

    // off-chain router state: usage served (never above the key's net funding)
    uint256[N] public liveSpent;
    // provable spend in the latest root; 0 for a key the root leaves out
    uint256[N] public rootSpent;
    bool[N] public inRoot;
    // the latest root's leaves, sorted by key hash
    bytes32[] internal rootKeys;
    uint256[] internal rootSpents;

    // served usage that an exit left uncovered (omitted key or stale escape root): settlement's loss
    uint256 public settlementLoss;
    // USDG settlement paid into the pool because an exit would otherwise have found it short; the
    // pool's balance is always deposited - withdrawn - swept + madeGood
    uint256 public madeGood;
    uint256 public calls;
    uint256 public finalizations;
    uint256 public escapes;
    uint256 public absences;

    constructor(Credits credits_, MockUSDG usdg_, address settlement_, address creditor_, bool omitting_) {
        credits = credits_;
        usdg = usdg_;
        settlement = settlement_;
        creditor = creditor_;
        omitting = omitting_;
        depositor = makeAddr("depositor");
        sink = makeAddr("sink");
        for (uint256 i; i < N; ++i) {
            pks[i] = 0xC0FFEE + i;
            keyAddrs[i] = vm.addr(pks[i]);
            keyHashes[i] = keccak256(abi.encodePacked(keyAddrs[i]));
        }
        vm.prank(depositor);
        usdg.approve(address(credits), type(uint256).max);
        vm.prank(creditor);
        usdg.approve(address(credits), type(uint256).max);
    }

    // Existing accounting tests explicitly model the independent reviewer as well as settlement.
    function _approveRoot(bytes32 root, uint64 asOf, uint256 total) internal {
        (VmSafe.CallerMode mode, address sender, address origin) = vm.readCallers();
        vm.stopPrank();
        uint256 epoch = credits.latestEpoch() + 1;
        vm.prank(credits.owner());
        credits.approveSpentRoot(epoch, root, asOf, total);
        if (mode == VmSafe.CallerMode.RecurrentPrank) vm.startPrank(sender, origin);
        else if (mode == VmSafe.CallerMode.Prank) vm.prank(sender, origin);
    }

    function _approveSweep(address to, uint256 amount) internal {
        (VmSafe.CallerMode mode, address sender, address origin) = vm.readCallers();
        vm.stopPrank();
        uint256 swept = credits.totalSwept();
        vm.prank(credits.owner());
        credits.approveSweep(swept, to, amount);
        if (mode == VmSafe.CallerMode.RecurrentPrank) vm.startPrank(sender, origin);
        else if (mode == VmSafe.CallerMode.Prank) vm.prank(sender, origin);
    }

    function _pending(uint256 i) internal view returns (uint256 amt, uint64 at) {
        (amt,, at) = credits.pendingWithdrawal(keyHashes[i]);
    }

    function _net(uint256 i) internal view returns (uint256) {
        return credits.deposited(keyHashes[i]) - credits.withdrawn(keyHashes[i]);
    }

    function deposit(uint256 seed, uint256 amount) external {
        uint256 i = seed % N;
        amount = bound(amount, 1, 1_000_000e6);
        usdg.mint(depositor, amount);
        vm.prank(depositor);
        credits.deposit(keyHashes[i], amount);
        ++calls;
    }

    function credit(uint256 seed, uint256 amount) external {
        uint256 i = seed % N;
        amount = bound(amount, 1, 1_000_000e6);
        usdg.mint(creditor, amount);
        vm.prank(creditor);
        credits.credit(keyHashes[i], amount);
        ++calls;
    }

    /// Router serves usage (off-chain). It never serves a key with a pending withdrawal and never lets
    /// spend exceed the key's balance.
    function spend(uint256 seed, uint256 amount) external {
        uint256 i = seed % N;
        (uint256 p,) = _pending(i);
        if (p != 0) return;
        uint256 net = _net(i);
        if (net <= liveSpent[i]) return;
        liveSpent[i] += bound(amount, 0, net - liveSpent[i]);
        ++calls;
    }

    /// Settlement posts a root: each included key's spend is capped at what the key can still back.
    /// An omitting router drops about a quarter of the keys from each root.
    function postRoot(uint256 gap, uint256 omitSeed) external {
        vm.warp(block.timestamp + bound(gap, 1, 2 hours));
        uint256 sum;
        uint256 n;
        for (uint256 i; i < N; ++i) {
            uint256 net = _net(i);
            uint256 s = liveSpent[i] < net ? liveSpent[i] : net;
            inRoot[i] = !omitting || (omitSeed >> (2 * i)) % 4 != 0;
            rootSpent[i] = inRoot[i] ? s : 0;
            sum += rootSpent[i];
            if (inRoot[i]) ++n;
        }
        bytes32[] memory ks = new bytes32[](n);
        uint256[] memory ss = new uint256[](n);
        n = 0;
        for (uint256 i; i < N; ++i) {
            if (!inRoot[i]) continue;
            (ks[n], ss[n]) = (keyHashes[i], rootSpent[i]);
            ++n;
        }
        SpentTree.sort(ks, ss);
        rootKeys = ks;
        rootSpents = ss;
        (,, uint256 prevTotal) = credits.spentRoot(credits.latestEpoch());
        uint256 total = sum > prevTotal ? sum : prevTotal;
        bytes32 root = SpentTree.root(rootKeys, rootSpents);
        vm.prank(settlement);
        _approveRoot(root, uint64(block.timestamp), total);
        credits.postSpentRoot(root, uint64(block.timestamp), total);
        ++calls;
    }

    function requestWithdrawal(uint256 seed, uint256 amount) external {
        uint256 i = seed % N;
        (uint256 p,) = _pending(i);
        if (p != 0) return;
        amount = bound(amount, 1, 2_000_000e6);
        uint256 dl = block.timestamp + 1 hours;
        bytes32 digest = credits.withdrawDigest(keyHashes[i], amount, sink, credits.nonces(keyHashes[i]), dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], digest);
        credits.requestWithdrawal(keyAddrs[i], amount, sink, dl, abi.encodePacked(r, s, v));
        ++calls;
    }

    function cancelWithdrawal(uint256 seed) external {
        uint256 i = seed % N;
        (uint256 p,) = _pending(i);
        if (p == 0) return;
        uint256 dl = block.timestamp;
        bytes32 digest = credits.withdrawDigest(keyHashes[i], 0, address(0), credits.nonces(keyHashes[i]), dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], digest);
        credits.cancelWithdrawal(keyAddrs[i], dl, abi.encodePacked(r, s, v));
        ++calls;
    }

    /// Any pending key can always finalize once timing allows: with an inclusion proof when the latest
    /// root has its leaf, else with an absence proof (the genesis root is the empty tree).
    function finalizeWithdrawal(uint256 seed) external {
        uint256 i = seed % N;
        bytes32 kh = keyHashes[i];
        (uint256 p, uint64 at) = _pending(i);
        if (p == 0) return;
        (, uint64 asOf,) = credits.spentRoot(credits.latestEpoch());
        bool escape = asOf < at;
        if (escape && block.timestamp < uint256(at) + credits.ESCAPE_DELAY()) return;
        bool included = inRoot[i] && credits.latestEpoch() != 0;
        uint256 provable = included ? rootSpent[i] : 0;
        uint256 before = credits.withdrawn(kh);
        uint256 net = _net(i);
        _makeGoodIfShort(min(p, net > provable ? net - provable : 0));
        if (included) {
            uint256 idx;
            while (rootKeys[idx] != kh) ++idx;
            bytes32[] memory proof = SpentTree.proof(SpentTree.leaves(rootKeys, rootSpents), idx);
            credits.finalizeWithdrawal(kh, provable, idx, rootKeys.length, proof);
        } else {
            uint256 n = rootKeys.length;
            uint256 gap = SpentTree.gapOf(rootKeys, kh);
            ICredits.SpentLeafProof memory below =
                gap == 0 ? SpentTree.sentinel() : SpentTree.neighbour(rootKeys, rootSpents, gap - 1);
            ICredits.SpentLeafProof memory above =
                gap == n ? SpentTree.sentinel() : SpentTree.neighbour(rootKeys, rootSpents, gap);
            credits.finalizeWithdrawalAbsent(kh, n, gap, below, above);
            ++absences;
        }
        // exactly min(requested, deposited - withdrawn - provable spend): never more
        uint256 avail = net > provable ? net - provable : 0;
        require(credits.withdrawn(kh) - before == (p < avail ? p : avail), "payout");
        // usage the exit left without funding is settlement's loss; the next root is capped below it
        uint256 netAfter = _net(i);
        if (liveSpent[i] > netAfter) {
            settlementLoss += liveSpent[i] - netAfter;
            liveSpent[i] = netAfter;
        }
        // settlement only ever tops the pool up by usage it lost; honest settlement never has to
        require(madeGood <= settlementLoss, "top-up beyond loss");
        ++finalizations;
        if (escape) ++escapes;
        ++calls;
    }

    /// An exit pays what the latest root proves. When a root left out a key whose usage was already swept,
    /// that key can still take its whole deposit and the pool holds less than that (the doc's "settlement's
    /// loss"): the transfer reverts, the request stays pending, and the exit goes through once settlement
    /// pays the shortfall in. Only an omitting router can cause this.
    function _makeGoodIfShort(uint256 pay) internal {
        uint256 bal = usdg.balanceOf(address(credits));
        if (pay <= bal) return;
        require(omitting, "honest pool short");
        usdg.mint(address(credits), pay - bal);
        madeGood += pay - bal;
    }

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// The approver keeps sweeps within the latest total and, for an omitting router, within the
    /// usage deposits still cover (so spend an exit released is never swept).
    function sweep(uint256 amount) external {
        (,, uint256 cap) = credits.spentRoot(credits.latestEpoch());
        if (omitting) {
            uint256 covered = sumLiveSpent();
            if (covered < cap) cap = covered;
        }
        uint256 swept = credits.totalSwept();
        if (cap <= swept) return;
        amount = bound(amount, 1, cap - swept);
        vm.prank(settlement);
        _approveSweep(sink, amount);
        credits.sweep(sink, amount);
        ++calls;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 8 days));
    }

    function sumTerms() external view returns (int256 sum, uint256 sumOwedPositive) {
        for (uint256 i; i < N; ++i) {
            int256 t = int256(credits.deposited(keyHashes[i])) - int256(rootSpent[i])
                - int256(credits.withdrawn(keyHashes[i]));
            sum += t;
            // forge-lint: disable-next-line(unsafe-typecast)
            if (t > 0) sumOwedPositive += uint256(t);
        }
    }

    function sumDepositedMinusWithdrawn() external view returns (uint256 s) {
        for (uint256 i; i < N; ++i) {
            s += _net(i);
        }
    }

    function sumLiveSpent() public view returns (uint256 s) {
        for (uint256 i; i < N; ++i) {
            s += liveSpent[i];
        }
    }

    /// What keys are owed by the router's own ledger: deposited - withdrawn - usage served.
    function fairOwed() external view returns (uint256 s) {
        for (uint256 i; i < N; ++i) {
            s += _net(i) - liveSpent[i];
        }
    }

    function keyHashAt(uint256 i) external view returns (bytes32) {
        return keyHashes[i];
    }
}

abstract contract CreditsInvariantBase is Test {
    MockUSDG internal usdg;
    Credits internal credits;
    CreditsHandler internal handler;

    function _setUp(bool omitting) internal {
        vm.chainId(4663);
        vm.warp(1_750_000_000);
        address owner = makeAddr("owner");
        address settlement = makeAddr("settlement");
        address creditor = makeAddr("creditor");
        usdg = new MockUSDG();
        credits = new Credits(IERC20(address(usdg)), owner, settlement);
        vm.prank(owner);
        credits.setCreditor(creditor, true);
        handler = new CreditsHandler(credits, usdg, settlement, creditor, omitting);

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = CreditsHandler.deposit.selector;
        selectors[1] = CreditsHandler.credit.selector;
        selectors[2] = CreditsHandler.spend.selector;
        selectors[3] = CreditsHandler.postRoot.selector;
        selectors[4] = CreditsHandler.requestWithdrawal.selector;
        selectors[5] = CreditsHandler.cancelWithdrawal.selector;
        selectors[6] = CreditsHandler.finalizeWithdrawal.selector;
        selectors[7] = CreditsHandler.sweep.selector;
        selectors[8] = CreditsHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _assertBoundedAndIdentity() internal view {
        uint256 bal = usdg.balanceOf(address(credits));
        (,, uint256 totalSpent) = credits.spentRoot(credits.latestEpoch());
        assertLe(credits.totalSwept(), totalSpent);
        assertEq(bal, handler.sumDepositedMinusWithdrawn() + handler.madeGood() - credits.totalSwept());
        for (uint256 i; i < 5; ++i) {
            bytes32 kh = handler.keyHashAt(i);
            assertLe(credits.withdrawn(kh), credits.deposited(kh));
            assertLe(handler.liveSpent(i), credits.deposited(kh) - credits.withdrawn(kh));
        }
    }
}

contract CreditsInvariantTest is CreditsInvariantBase {
    function setUp() public {
        _setUp(false);
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_balanceIdentity() public view {
        (int256 sum,) = handler.sumTerms();
        (,, uint256 totalSpent) = credits.spentRoot(credits.latestEpoch());
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 lhs = sum + int256(totalSpent) - int256(credits.totalSwept());
        assertEq(lhs, int256(usdg.balanceOf(address(credits))));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_solventAndBounded() public view {
        _assertBoundedAndIdentity();
        assertEq(handler.madeGood(), 0);
        (, uint256 owed) = handler.sumTerms();
        assertGe(usdg.balanceOf(address(credits)), owed);
    }
}

/// Settlement omits funded keys from its roots. No exit is ever blocked (fail-on-revert: every
/// finalization succeeds), each pays exactly what the latest root proves (checked in the handler), and
/// what keys are owed by the router's own ledger is covered by the balance plus settlement's losses.
contract CreditsOmissionInvariantTest is CreditsInvariantBase {
    function setUp() public {
        _setUp(true);
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_exitsBoundedAndIdentity() public view {
        _assertBoundedAndIdentity();
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_settlementBearsOmissions() public view {
        assertGe(usdg.balanceOf(address(credits)) + handler.settlementLoss(), handler.fairOwed());
    }

    /// Without a top-up the pool is exactly deposits - withdrawals - sweeps, and a top-up never exceeds
    /// the usage settlement lost: the contract itself never pays out of thin air.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_topUpsBoundedByLoss() public view {
        assertLe(handler.madeGood(), handler.settlementLoss());
    }

    /// The path the fuzzer reaches only sometimes: spend is swept, then a root omits the key and it exits
    /// with everything. The pool is short by exactly the loss settlement must make good.
    function test_omittedKeyExitsAfterSweep_lossIsSettlements() public {
        handler.deposit(0, 100e6);
        handler.deposit(1, 50e6);
        handler.spend(0, 30e6);
        handler.postRoot(1, type(uint256).max); // includes every key
        handler.sweep(30e6);
        assertEq(credits.totalSwept(), 30e6);
        handler.requestWithdrawal(0, 2_000_000e6);
        handler.postRoot(1, 0); // omits every key
        assertFalse(handler.inRoot(0));
        handler.finalizeWithdrawal(0);
        assertEq(handler.absences(), 1);
        assertEq(credits.withdrawn(handler.keyHashAt(0)), 100e6);
        assertEq(handler.settlementLoss(), 30e6);
        // key 1 is owed its 50; the pool holds 20 until settlement covers its 30 loss
        assertEq(handler.fairOwed(), 50e6);
        assertEq(usdg.balanceOf(address(credits)), 20e6);
        invariant_exitsBoundedAndIdentity();
        invariant_settlementBearsOmissions();
    }

    /// The sequence the fuzzer shrinks to: one funded key, its spend swept, then a later root drops the
    /// key. The absence exit is owed the whole deposit but the pool only holds deposit - swept, so it
    /// reverts and the request stays pending until settlement pays in what it lost. This is the contract
    /// working as documented (the omitted spend is settlement's loss), not a solvency bug: sweeps only
    /// ever moved spend an earlier root proved.
    function test_omittedKeyExitWaitsForSettlementToCoverLoss() public {
        handler.deposit(0, 17_293);
        handler.spend(0, 13_226);
        handler.postRoot(1, type(uint256).max); // includes the key: 13_226 settled
        handler.sweep(4_067);
        handler.requestWithdrawal(0, 2_000_000e6);
        handler.postRoot(1, 0); // omits the key
        assertFalse(handler.inRoot(0));
        bytes32 kh = handler.keyHashAt(0);
        assertEq(usdg.balanceOf(address(credits)), 17_293 - 4_067);

        // the root is the empty tree, so the key exits by absence: sentinels stand for both neighbours
        ICredits.SpentLeafProof memory none = SpentTree.sentinel();
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, address(credits), 17_293 - 4_067, 17_293
            )
        );
        credits.finalizeWithdrawalAbsent(kh, 0, 0, none, none);
        (uint256 amt,,) = credits.pendingWithdrawal(kh);
        assertEq(amt, 2_000_000e6, "request survives the failed exit");
        assertEq(credits.withdrawn(kh), 0);

        // settlement covers the 4_067 it swept and then left out: the same exit now completes in full
        usdg.mint(address(credits), 4_067);
        credits.finalizeWithdrawalAbsent(kh, 0, 0, none, none);
        assertEq(credits.withdrawn(kh), 17_293);
        assertEq(usdg.balanceOf(handler.sink()), 4_067 + 17_293);
        assertEq(usdg.balanceOf(address(credits)), 0);
        (amt,,) = credits.pendingWithdrawal(kh);
        assertEq(amt, 0);
    }
}
