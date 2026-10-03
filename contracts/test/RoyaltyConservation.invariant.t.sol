// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {Royalty} from "../src/Royalty.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
contract RoyaltyConservationHandler is Test {
    Royalty public royalty;
    MockUSDG public token;
    address[3] public creators;
    uint256 public streamed;
    uint256 public claimed;
    constructor(Royalty royalty_, MockUSDG token_) {
        royalty = royalty_; token = token_;
        for (uint256 i; i < 3; i++) creators[i] = address(uint160(0x2000 + i));
        token.approve(address(royalty), type(uint256).max);
        royalty.register(bytes32(uint256(1)), creators[0], 1000);
    }
    function register(uint256 who, uint16 bps) external { royalty.register(bytes32(uint256(1)), creators[who % 3], bps % 2001); }
    function transfer(uint256 who) external {
        (address current,,) = royalty.models(bytes32(uint256(1)));
        vm.prank(current); royalty.transferCreator(bytes32(uint256(1)), creators[who % 3]);
    }
    function stream(uint256 amount) external {
        amount = 1 + amount % 1_000_000e6; token.mint(address(this), amount);
        royalty.stream(bytes32(uint256(1)), amount); streamed += amount;
    }
    function claim(uint256 who, uint256 recipient) external {
        address creator = creators[who % 3]; uint256 amount = royalty.claimable(creator); if (amount == 0) return;
        vm.prank(creator); royalty.claim(creators[recipient % 3]); claimed += amount;
    }
    function assertConservation() external view {
        uint256 liabilities; uint256 paid;
        for (uint256 i; i < 3; i++) { liabilities += royalty.claimable(creators[i]); paid += token.balanceOf(creators[i]); }
        assertEq(token.balanceOf(address(royalty)), liabilities);
        assertEq(liabilities, streamed - claimed); assertEq(paid, claimed);
        assertEq(token.totalSupply(), streamed);
        (,,uint256 totalStreamed) = royalty.models(bytes32(uint256(1))); assertEq(totalStreamed, streamed);
    }
}
contract RoyaltyConservationTest is Test {
    RoyaltyConservationHandler internal handler;
    function setUp() external {
        MockUSDG token = new MockUSDG();
        // Predetermine the handler address so its constructor can register and approve as settlement.
        address actor = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        Royalty royalty = new Royalty(token, address(this), actor, actor);
        handler = new RoyaltyConservationHandler(royalty, token); assertEq(address(handler), actor);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.register.selector; selectors[1] = handler.transfer.selector; selectors[2] = handler.stream.selector; selectors[3] = handler.claim.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }
    function invariant_allCreatorLiabilitiesAreFullyBacked() external view { handler.assertConservation(); }
    function test_oldCreatorKeepsAccruedFundsAfterTransfer() external {
        handler.stream(9); handler.transfer(1); handler.stream(19); handler.claim(0, 2); handler.claim(1, 1);
        handler.assertConservation(); assertEq(handler.streamed(), 30); assertEq(handler.claimed(), 30);
    }
}
