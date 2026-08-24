// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

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

contract MockERC1271Wallet is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes memory sig) external view returns (bytes4) {
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
        return (err == ECDSA.RecoverError.NoError && rec == signer) ? IERC1271.isValidSignature.selector : bytes4(0);
    }
}

abstract contract CreditsBase is Test {
    uint256 internal constant CHAIN_ID = 4663;
    bytes32 internal constant TYPEHASH =
        keccak256("WithdrawRequest(bytes32 keyHash,uint256 amount,address to,uint256 nonce,uint256 deadline)");
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
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
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
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(block.chainid, address(credits)), structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signRequest(uint256 pk, uint256 amount, address to, uint256 deadline) internal view returns (bytes memory) {
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

    /// Posts a single-leaf root for (kh, spent); proof is empty.
    function _postSingle(bytes32 kh, uint256 spent, uint256 totalSpent) internal {
        vm.prank(settlement);
        credits.postSpentRoot(Merkle.creditsLeaf(kh, spent), uint64(block.timestamp), totalSpent);
    }

    function _empty() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](0);
    }

    function _permitSig(uint256 pk, address ownerAddr, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, ownerAddr, spender, value, usdg.nonces(ownerAddr), deadline));
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
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = credits.eip712Domain();
        assertEq(name, "Anyroute Credits");
        assertEq(version, "1");
        assertEq(chainId, CHAIN_ID);
        assertEq(verifying, address(credits));
    }

    function testFuzz_withdrawDigest_matchesManual(bytes32 kh, uint256 amount, address to, uint256 nonce, uint256 dl)
        public
        view
    {
        assertEq(credits.withdrawDigest(kh, amount, to, nonce, dl), _digest(kh, amount, to, nonce, dl));
    }

    function testFuzz_keyHashOf(address a) public view {
        assertEq(credits.keyHashOf(a), keccak256(abi.encodePacked(a)));
    }

    function testFuzz_spentLeaf_matchesHelper(bytes32 kh, uint256 spent) public view {
        assertEq(credits.spentLeaf(kh, spent), Merkle.creditsLeaf(kh, spent));
        assertEq(credits.spentLeaf(kh, spent), keccak256(bytes.concat(keccak256(abi.encode(kh, spent)))));
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
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(credits), 0, 10e6)
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
        credits.postSpentRoot(keccak256("a"), uint64(block.timestamp - 100), 1);
        credits.postSpentRoot(keccak256("b"), uint64(block.timestamp - 50), 1);
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
        credits.postSpentRoot(keccak256("r"), uint64(block.timestamp), 0);
        vm.expectRevert(ICredits.StaleRoot.selector);
        credits.postSpentRoot(keccak256("r2"), uint64(block.timestamp), 0);
        vm.stopPrank();
    }

    function test_postSpentRoot_revertsStaleLower() public {
        vm.startPrank(settlement);
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
        credits.postSpentRoot(keccak256("r"), uint64(block.timestamp - 1), 10);
        vm.expectRevert(Credits.SpentDecreased.selector);
        credits.postSpentRoot(keccak256("r2"), uint64(block.timestamp), 9);
        // equal is fine
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(1, address(credits)), structHash));
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
        credits.finalizeWithdrawal(keyHash, 0, _empty());
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
            address(wallet), 3e6, recipient, block.timestamp, _sign(ownerPk, _digest(kh, 3e6, recipient, 0, block.timestamp))
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
        credits.finalizeWithdrawal(keyHash, 0, _empty());
    }

    function test_finalize_revertsRootTooOld_noRoot() public {
        _deposit(keyHash, 100e6);
        _request(10e6);
        vm.expectRevert(ICredits.RootTooOld.selector);
        credits.finalizeWithdrawal(keyHash, 0, _empty());
    }

    function test_finalize_revertsRootTooOld_olderRoot() public {
        _deposit(keyHash, 100e6);
        _postSingle(keyHash, 0, 0);
        vm.warp(block.timestamp + 1);
        _request(10e6);
        vm.expectRevert(ICredits.RootTooOld.selector);
        credits.finalizeWithdrawal(keyHash, 0, _empty());
    }

    function test_finalize_rootAtRequestTimestampOk() public {
        _deposit(keyHash, 100e6);
        _request(10e6);
        _postSingle(keyHash, 0, 0);
        credits.finalizeWithdrawal(keyHash, 0, _empty());
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
        credits.finalizeWithdrawal(keyHash, 30e6, _empty());

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
        credits.finalizeWithdrawal(keyHash, 30e6, _empty());
        assertEq(usdg.balanceOf(recipient), 70e6);
        assertEq(credits.withdrawn(keyHash), 70e6);
    }

    function test_finalize_paysZeroWhenFullySpent_stillClears() public {
        _deposit(keyHash, 100e6);
        _request(10e6);
        _postSingle(keyHash, 100e6, 100e6);
        vm.expectEmit(true, true, true, true, address(credits));
        emit ICredits.Withdrawn(keyHash, recipient, 0);
        credits.finalizeWithdrawal(keyHash, 100e6, _empty());
        assertEq(usdg.balanceOf(recipient), 0);
        assertEq(credits.withdrawn(keyHash), 0);
        (uint256 amt,,) = credits.pendingWithdrawal(keyHash);
        assertEq(amt, 0);
    }

    function test_finalize_floorsAtZeroWhenOverspent() public {
        _deposit(keyHash, 100e6);
        _request(10e6);
        _postSingle(keyHash, 150e6, 150e6);
        credits.finalizeWithdrawal(keyHash, 150e6, _empty());
        assertEq(usdg.balanceOf(recipient), 0);
    }

    function test_finalize_accountsForPreviousWithdrawals() public {
        _deposit(keyHash, 100e6);
        _request(60e6);
        _postSingle(keyHash, 10e6, 10e6);
        credits.finalizeWithdrawal(keyHash, 10e6, _empty());
        assertEq(usdg.balanceOf(recipient), 60e6);

        vm.warp(block.timestamp + 1);
        _request(60e6);
        vm.warp(block.timestamp + 1);
        _postSingle(keyHash, 20e6, 20e6);
        credits.finalizeWithdrawal(keyHash, 20e6, _empty());
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
        credits.finalizeWithdrawal(keyHash, 5e6, _empty());
        assertEq(usdg.balanceOf(recipient), 25e6);
    }

    function test_finalize_multiKeyTree() public {
        uint256 n = 7;
        uint256[] memory pks = new uint256[](n);
        bytes32[] memory khs = new bytes32[](n);
        uint256[] memory spents = new uint256[](n);
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            pks[i] = 0x1000 + i;
            khs[i] = keccak256(abi.encodePacked(vm.addr(pks[i])));
            spents[i] = (i + 1) * 3e6;
            _deposit(khs[i], 100e6);
            leaves[i] = Merkle.creditsLeaf(khs[i], spents[i]);
            bytes memory sig = _signRequest(pks[i], 200e6, recipient, block.timestamp);
            credits.requestWithdrawal(vm.addr(pks[i]), 200e6, recipient, block.timestamp, sig);
        }
        vm.warp(block.timestamp + 1 hours);
        vm.prank(settlement);
        credits.postSpentRoot(Merkle.getRoot(leaves), uint64(block.timestamp), 84e6);
        uint256 expected;
        for (uint256 i; i < n; ++i) {
            credits.finalizeWithdrawal(khs[i], spents[i], Merkle.getProof(leaves, i));
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
        credits.finalizeWithdrawal(keyHash, 29e6, _empty());
    }

    function test_finalize_revertsInvalidProof_otherKeysLeaf() public {
        bytes32 other = keccak256("other");
        _deposit(keyHash, 100e6);
        _request(10e6);
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = Merkle.creditsLeaf(keyHash, 90e6);
        leaves[1] = Merkle.creditsLeaf(other, 0);
        vm.prank(settlement);
        credits.postSpentRoot(Merkle.getRoot(leaves), uint64(block.timestamp), 90e6);
        // try using other key's leaf/proof for our key
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 0, Merkle.getProof(leaves, 1));
        // the correct proof works
        credits.finalizeWithdrawal(keyHash, 90e6, Merkle.getProof(leaves, 0));
        assertEq(usdg.balanceOf(recipient), 10e6);
    }

    function test_finalize_revertsInvalidProof_innerNodeAsLeaf() public {
        bytes32[] memory leaves = new bytes32[](4);
        for (uint256 i; i < 4; ++i) {
            leaves[i] = Merkle.creditsLeaf(bytes32(i), i);
        }
        _deposit(keyHash, 100e6);
        _request(10e6);
        vm.prank(settlement);
        credits.postSpentRoot(Merkle.getRoot(leaves), uint64(block.timestamp), 6);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = Merkle.hashPair(leaves[2], leaves[3]);
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 0, proof);
    }

    function test_finalize_usesLatestRootOnly() public {
        _deposit(keyHash, 100e6);
        _request(100e6);
        _postSingle(keyHash, 10e6, 10e6);
        vm.warp(block.timestamp + 1);
        _postSingle(keyHash, 40e6, 40e6);
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 10e6, _empty());
        credits.finalizeWithdrawal(keyHash, 40e6, _empty());
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
        credits.finalizeWithdrawal(keyHash, 20e6, _empty());

        vm.warp(requestedAt + 7 days);
        credits.finalizeWithdrawal(keyHash, 20e6, _empty());
        assertEq(usdg.balanceOf(recipient), 80e6);
    }

    function test_finalize_escapeHatchStillNeedsValidProof() public {
        _deposit(keyHash, 100e6);
        _request(100e6);
        vm.warp(block.timestamp + 7 days);
        // no root ever posted
        vm.expectRevert(ICredits.InvalidProof.selector);
        credits.finalizeWithdrawal(keyHash, 0, _empty());
    }

    function testFuzz_finalize(uint256 dep, uint256 spent, uint256 req) public {
        dep = bound(dep, 1, 5_000_000e6);
        spent = bound(spent, 0, 10_000_000e6);
        req = bound(req, 1, 10_000_000e6);
        _deposit(keyHash, dep);
        _request(req);
        _postSingle(keyHash, spent, spent);
        credits.finalizeWithdrawal(keyHash, spent, _empty());
        uint256 avail = dep > spent ? dep - spent : 0;
        uint256 expected = req < avail ? req : avail;
        assertEq(usdg.balanceOf(recipient), expected);
        assertEq(credits.withdrawn(keyHash), expected);
        assertEq(usdg.balanceOf(address(credits)), dep - expected);
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
}
