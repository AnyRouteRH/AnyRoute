// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CreditMintEvents} from "../../src/seal/CreditMintEvents.sol";

contract CreditMintEventsTest is Test {
    CreditMintEvents internal cme;
    address internal owner = makeAddr("owner");
    address internal mint = makeAddr("mint");
    address internal rando = makeAddr("rando");

    bytes32 internal constant QUOTE = keccak256("quote-1");
    bytes32 internal constant KEYSET = bytes32(bytes8(0x00ad268c4d1f5826));
    bytes32 internal constant PUBKEYS = keccak256("pubkeys");
    bytes32 internal constant REKOR = keccak256("rekor");

    event Purchased(bytes32 indexed quoteIdHash, uint256 amount, CreditMintEvents.Rail rail);
    event KeysetPublished(bytes32 indexed id, bytes32 pubkeysHash, bytes32 rekorRef);
    event MintSignerSet(address indexed mintSigner);

    function setUp() public {
        cme = new CreditMintEvents(owner, mint);
    }

    function test_constructor() public {
        assertEq(cme.owner(), owner);
        assertEq(cme.mintSigner(), mint);
        vm.expectRevert(CreditMintEvents.ZeroAddress.selector);
        new CreditMintEvents(owner, address(0));
    }

    function test_recordPurchaseEmits() public {
        vm.expectEmit(address(cme));
        emit Purchased(QUOTE, 65_536, CreditMintEvents.Rail.UsdgX402);
        vm.prank(mint);
        cme.recordPurchase(QUOTE, 65_536, CreditMintEvents.Rail.UsdgX402);
        assertTrue(cme.purchased(QUOTE));
        assertEq(cme.purchaseCount(), 1);

        vm.prank(mint);
        cme.recordPurchase(keccak256("quote-2"), 1024, CreditMintEvents.Rail.Lightning);
        assertEq(cme.purchaseCount(), 2);
    }

    function test_purchaseEventCarriesNoAddress() public {
        vm.recordLogs();
        vm.prank(mint);
        cme.recordPurchase(QUOTE, 4096, CreditMintEvents.Rail.ShieldedUsdg);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics.length, 2); // signature + quoteIdHash only
        assertEq(logs[0].topics[1], QUOTE);
        assertEq(logs[0].data, abi.encode(uint256(4096), uint8(CreditMintEvents.Rail.ShieldedUsdg)));
    }

    function test_recordPurchaseValidation() public {
        vm.prank(rando);
        vm.expectRevert(CreditMintEvents.NotMintSigner.selector);
        cme.recordPurchase(QUOTE, 1, CreditMintEvents.Rail.UsdgX402);
        vm.prank(owner);
        vm.expectRevert(CreditMintEvents.NotMintSigner.selector);
        cme.recordPurchase(QUOTE, 1, CreditMintEvents.Rail.UsdgX402);

        vm.startPrank(mint);
        vm.expectRevert(CreditMintEvents.ZeroValue.selector);
        cme.recordPurchase(0, 1, CreditMintEvents.Rail.UsdgX402);
        vm.expectRevert(CreditMintEvents.ZeroValue.selector);
        cme.recordPurchase(QUOTE, 0, CreditMintEvents.Rail.UsdgX402);
        cme.recordPurchase(QUOTE, 1, CreditMintEvents.Rail.UsdgX402);
        vm.expectRevert(CreditMintEvents.AlreadyRecorded.selector);
        cme.recordPurchase(QUOTE, 2, CreditMintEvents.Rail.PrepaidCredits);
        vm.stopPrank();
    }

    function test_recordPurchaseRejectsUnknownRail() public {
        vm.prank(mint);
        (bool ok,) =
            address(cme).call(abi.encodeWithSelector(cme.recordPurchase.selector, QUOTE, 1, uint8(4)));
        assertFalse(ok);
    }

    function test_publishKeyset() public {
        vm.expectEmit(address(cme));
        emit KeysetPublished(KEYSET, PUBKEYS, REKOR);
        vm.prank(mint);
        cme.publishKeyset(KEYSET, PUBKEYS, REKOR);
        assertTrue(cme.keysetPublished(KEYSET));
        assertEq(cme.keysetCount(), 1);
    }

    function test_publishKeysetValidation() public {
        vm.prank(rando);
        vm.expectRevert(CreditMintEvents.NotMintSigner.selector);
        cme.publishKeyset(KEYSET, PUBKEYS, REKOR);

        vm.startPrank(mint);
        vm.expectRevert(CreditMintEvents.ZeroValue.selector);
        cme.publishKeyset(0, PUBKEYS, REKOR);
        vm.expectRevert(CreditMintEvents.ZeroValue.selector);
        cme.publishKeyset(KEYSET, 0, REKOR);
        vm.expectRevert(CreditMintEvents.ZeroValue.selector);
        cme.publishKeyset(KEYSET, PUBKEYS, 0);
        cme.publishKeyset(KEYSET, PUBKEYS, REKOR);
        vm.expectRevert(CreditMintEvents.AlreadyRecorded.selector);
        cme.publishKeyset(KEYSET, keccak256("other"), REKOR);
        vm.stopPrank();
    }

    function test_setMintSigner() public {
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        cme.setMintSigner(rando);
        vm.prank(owner);
        vm.expectRevert(CreditMintEvents.ZeroAddress.selector);
        cme.setMintSigner(address(0));

        vm.expectEmit(address(cme));
        emit MintSignerSet(rando);
        vm.prank(owner);
        cme.setMintSigner(rando);

        vm.prank(mint);
        vm.expectRevert(CreditMintEvents.NotMintSigner.selector);
        cme.recordPurchase(QUOTE, 1, CreditMintEvents.Rail.UsdgX402);
        vm.prank(rando);
        cme.recordPurchase(QUOTE, 1, CreditMintEvents.Rail.UsdgX402);
    }

    function testFuzz_recordPurchase(bytes32 quote, uint256 amount, uint8 railRaw) public {
        vm.assume(quote != 0 && amount != 0);
        CreditMintEvents.Rail rail = CreditMintEvents.Rail(bound(railRaw, 0, 3));
        vm.expectEmit(address(cme));
        emit Purchased(quote, amount, rail);
        vm.prank(mint);
        cme.recordPurchase(quote, amount, rail);
        assertTrue(cme.purchased(quote));
    }
}
