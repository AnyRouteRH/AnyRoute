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
}
