// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {UniswapV3Adapter, ISwapRouter02} from "../src/adapters/UniswapV3Adapter.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

interface IMint {
    function mint(address to, uint256 amount) external;
}

/// @dev SwapRouter02 stand-in. Rate per (tokenIn, tokenOut): out = in * num / den. Pulls input from msg.sender
/// via transferFrom, mints output to the recipient. Records the last call for assertions.
contract MockSwapRouter02 is ISwapRouter02 {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => uint256[2])) public rates;
    bytes public lastPath;
    uint24 public lastFee;
    string public lastFn;
    bool public underConsume; // exact-in: consume only half the input (misbehaving router)
    bool public overDeliverShort; // exact-out: deliver one unit less than asked (misbehaving router)

    error TooMuchRequested();
    error TooLittleReceived();

    function setRate(address tokenIn, address tokenOut, uint256 num, uint256 den) external {
        rates[tokenIn][tokenOut] = [num, den];
    }

    function setUnderConsume(bool v) external {
        underConsume = v;
    }

    function setShortDeliver(bool v) external {
        overDeliverShort = v;
    }

    function _in(address tIn, address tOut, uint256 amountOut) internal view returns (uint256) {
        uint256[2] memory r = rates[tIn][tOut];
        return Math.mulDiv(amountOut, r[1], r[0], Math.Rounding.Ceil);
    }

    function _out(address tIn, address tOut, uint256 amountIn) internal view returns (uint256) {
        uint256[2] memory r = rates[tIn][tOut];
        return amountIn * r[0] / r[1];
    }

    function _first(bytes memory p) internal pure returns (address a) {
        assembly {
            a := shr(96, mload(add(p, 32)))
        }
    }

    function _last(bytes memory p) internal pure returns (address a) {
        uint256 l = p.length;
        assembly {
            a := shr(96, mload(add(add(p, 32), sub(l, 20))))
        }
    }

    function exactInputSingle(ExactInputSingleParams calldata p)
        external
        payable
        returns (uint256 amountOut)
    {
        lastFn = "exactInputSingle";
        lastFee = p.fee;
        uint256 used = underConsume ? p.amountIn / 2 : p.amountIn;
        amountOut = _out(p.tokenIn, p.tokenOut, used);
        if (amountOut < p.amountOutMinimum) revert TooLittleReceived();
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), used);
        IMint(p.tokenOut).mint(p.recipient, amountOut);
    }

    function exactInput(ExactInputParams calldata p) external payable returns (uint256 amountOut) {
        lastFn = "exactInput";
        lastPath = p.path;
        address tIn = _first(p.path);
        address tOut = _last(p.path);
        amountOut = _out(tIn, tOut, p.amountIn);
        if (amountOut < p.amountOutMinimum) revert TooLittleReceived();
        IERC20(tIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        IMint(tOut).mint(p.recipient, amountOut);
    }

    function exactOutputSingle(ExactOutputSingleParams calldata p)
        external
        payable
        returns (uint256 amountIn)
    {
        lastFn = "exactOutputSingle";
        lastFee = p.fee;
        amountIn = _in(p.tokenIn, p.tokenOut, p.amountOut);
        if (amountIn > p.amountInMaximum) revert TooMuchRequested();
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IMint(p.tokenOut).mint(p.recipient, overDeliverShort ? p.amountOut - 1 : p.amountOut);
    }

    function exactOutput(ExactOutputParams calldata p) external payable returns (uint256 amountIn) {
        lastFn = "exactOutput";
        lastPath = p.path;
        // exact-output paths are reversed: first = tokenOut, last = tokenIn
        address tOut = _first(p.path);
        address tIn = _last(p.path);
        amountIn = _in(tIn, tOut, p.amountOut);
        if (amountIn > p.amountInMaximum) revert TooMuchRequested();
        IERC20(tIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IMint(tOut).mint(p.recipient, p.amountOut);
    }
}

contract UniswapV3AdapterTest is Test {
    MockSwapRouter02 router;
    UniswapV3Adapter adapter;
    MockStockToken nvda; // 18 dec
    MockStockToken weth; // 18 dec
    MockUSDG usdg; // 6 dec

    address owner = makeAddr("owner");
    address caller = makeAddr("caller"); // PayWithStock / NetworkFeeBurn stand-in
    address recipient = makeAddr("recipient");
    address refundTo = makeAddr("refundTo");
    address stranger = makeAddr("stranger");

    function setUp() public {
        router = new MockSwapRouter02();
        adapter = new UniswapV3Adapter(ISwapRouter02(address(router)), owner);
        nvda = new MockStockToken("NVIDIA xStock", "NVDAx", 18);
        weth = new MockStockToken("Wrapped Ether", "WETH", 18);
        usdg = new MockUSDG();

        // 1 NVDA = 180 USDG ; 1 NVDA = 0.05 WETH ; 1 WETH = 3600 USDG
        router.setRate(address(nvda), address(usdg), 180e6, 1e18);
        router.setRate(address(usdg), address(nvda), 1e18, 180e6);
        router.setRate(address(nvda), address(weth), 5e16, 1e18);

        vm.startPrank(owner);
        adapter.setCaller(caller, true);
        adapter.setPath(
            address(nvda), address(usdg), abi.encodePacked(address(nvda), uint24(3000), address(usdg))
        );
        adapter.setPath(
            address(usdg), address(nvda), abi.encodePacked(address(usdg), uint24(500), address(nvda))
        );
        vm.stopPrank();
    }

    function _fund(address token, uint256 amount) internal {
        MockStockToken(token).mint(address(adapter), amount);
    }

    function _assertClean() internal view {
        assertEq(nvda.balanceOf(address(adapter)), 0);
        assertEq(usdg.balanceOf(address(adapter)), 0);
        assertEq(weth.balanceOf(address(adapter)), 0);
        assertEq(nvda.allowance(address(adapter), address(router)), 0);
        assertEq(usdg.allowance(address(adapter), address(router)), 0);
    }

    // ------------------------------------------------------------------ path registration

    function test_setPathStoresForwardAndReversed() public view {
        (bytes memory p, bytes memory r) = adapter.getPath(address(nvda), address(usdg));
        assertEq(p, abi.encodePacked(address(nvda), uint24(3000), address(usdg)));
        assertEq(r, abi.encodePacked(address(usdg), uint24(3000), address(nvda)));
    }

    function test_setPathMultiHopReverse() public {
        bytes memory fwd =
            abi.encodePacked(address(nvda), uint24(3000), address(weth), uint24(500), address(usdg));
        vm.prank(owner);
        adapter.setPath(address(nvda), address(usdg), fwd);
        (, bytes memory r) = adapter.getPath(address(nvda), address(usdg));
        assertEq(r, abi.encodePacked(address(usdg), uint24(500), address(weth), uint24(3000), address(nvda)));
    }

    function test_setPathValidation() public {
        vm.startPrank(owner);
        vm.expectRevert(UniswapV3Adapter.InvalidPath.selector);
        adapter.setPath(
            address(nvda), address(nvda), abi.encodePacked(address(nvda), uint24(1), address(nvda))
        );
        vm.expectRevert(UniswapV3Adapter.InvalidPath.selector);
        adapter.setPath(address(0), address(usdg), abi.encodePacked(address(0), uint24(1), address(usdg)));
        vm.expectRevert(UniswapV3Adapter.InvalidPath.selector); // wrong start
        adapter.setPath(
            address(nvda), address(usdg), abi.encodePacked(address(weth), uint24(1), address(usdg))
        );
        vm.expectRevert(UniswapV3Adapter.InvalidPath.selector); // wrong end
        adapter.setPath(
            address(nvda), address(usdg), abi.encodePacked(address(nvda), uint24(1), address(weth))
        );
        vm.expectRevert(UniswapV3Adapter.InvalidPath.selector); // bad length
        adapter.setPath(
            address(nvda), address(usdg), abi.encodePacked(address(nvda), uint24(1), address(usdg), hex"00")
        );
        vm.expectRevert(UniswapV3Adapter.InvalidPath.selector); // too many hops (4)
        adapter.setPath(
            address(nvda),
            address(usdg),
            abi.encodePacked(
                address(nvda),
                uint24(1),
                address(weth),
                uint24(1),
                address(weth),
                uint24(1),
                address(weth),
                uint24(1),
                address(usdg)
            )
        );
        // clear
        adapter.setPath(address(nvda), address(usdg), "");
        vm.stopPrank();
        (bytes memory p,) = adapter.getPath(address(nvda), address(usdg));
        assertEq(p.length, 0);
    }

    function test_onlyOwner() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        adapter.setPath(address(nvda), address(usdg), "");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        adapter.setCaller(stranger, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        adapter.rescue(address(nvda), stranger, 1);
        vm.stopPrank();
    }

    function test_onlyWhitelistedCallers() public {
        _fund(address(nvda), 1e18);
        vm.startPrank(stranger);
        vm.expectRevert(UniswapV3Adapter.NotCaller.selector);
        adapter.swapExactOut(address(nvda), address(usdg), 1e6, 1e18, recipient, refundTo);
        vm.expectRevert(UniswapV3Adapter.NotCaller.selector);
        adapter.swapExactIn(address(nvda), address(usdg), 1e18, 0, recipient);
        vm.stopPrank();

        vm.prank(owner);
        adapter.setCaller(caller, false);
        vm.prank(caller);
        vm.expectRevert(UniswapV3Adapter.NotCaller.selector);
        adapter.swapExactOut(address(nvda), address(usdg), 1e6, 1e18, recipient, refundTo);
    }

    // ------------------------------------------------------------------ exact output

    function test_exactOutSingle() public {
        uint256 amountOut = 90e6; // $90 => 0.5 NVDA
        uint256 maxIn = 0.51e18;
        _fund(address(nvda), maxIn);
        vm.prank(caller);
        uint256 amountIn =
            adapter.swapExactOut(address(nvda), address(usdg), amountOut, maxIn, recipient, refundTo);
        assertEq(amountIn, 0.5e18);
        assertEq(usdg.balanceOf(recipient), amountOut);
        assertEq(nvda.balanceOf(refundTo), maxIn - amountIn);
        assertEq(router.lastFee(), 3000);
        assertEq(keccak256(bytes(router.lastFn())), keccak256("exactOutputSingle"));
        _assertClean();
    }

    function test_exactOutMultiHopUsesReversedPath() public {
        router.setRate(address(nvda), address(usdg), 180e6, 1e18); // end-to-end rate used by the mock
        bytes memory fwd =
            abi.encodePacked(address(nvda), uint24(3000), address(weth), uint24(500), address(usdg));
        vm.prank(owner);
        adapter.setPath(address(nvda), address(usdg), fwd);

        _fund(address(nvda), 1e18);
        vm.prank(caller);
        uint256 amountIn = adapter.swapExactOut(address(nvda), address(usdg), 18e6, 1e18, recipient, refundTo);
        assertEq(amountIn, 0.1e18);
        assertEq(keccak256(bytes(router.lastFn())), keccak256("exactOutput"));
        assertEq(
            router.lastPath(),
            abi.encodePacked(address(usdg), uint24(500), address(weth), uint24(3000), address(nvda))
        );
        assertEq(nvda.balanceOf(refundTo), 0.9e18);
        _assertClean();
    }

    function test_exactOutExceedingMaxReverts() public {
        _fund(address(nvda), 0.49e18);
        vm.prank(caller);
        vm.expectRevert(MockSwapRouter02.TooMuchRequested.selector);
        adapter.swapExactOut(address(nvda), address(usdg), 90e6, 0.49e18, recipient, refundTo);
    }

    function test_exactOutRequiresPrefunding() public {
        _fund(address(nvda), 1);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Adapter.InsufficientInputBalance.selector, 1, 1e18));
        adapter.swapExactOut(address(nvda), address(usdg), 90e6, 1e18, recipient, refundTo);
    }

    function test_exactOutNoRoute() public {
        _fund(address(weth), 1e18);
        vm.prank(caller);
        vm.expectRevert(UniswapV3Adapter.NoRoute.selector);
        adapter.swapExactOut(address(weth), address(usdg), 1e6, 1e18, recipient, refundTo);
    }

    function test_exactOutShortDeliveryReverts() public {
        router.setShortDeliver(true);
        _fund(address(nvda), 1e18);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Adapter.InsufficientOutput.selector, 90e6 - 1, 90e6));
        adapter.swapExactOut(address(nvda), address(usdg), 90e6, 1e18, recipient, refundTo);
    }

    function test_exactOutInvalidArgs() public {
        vm.startPrank(caller);
        vm.expectRevert(UniswapV3Adapter.InvalidAmount.selector);
        adapter.swapExactOut(address(nvda), address(usdg), 0, 1, recipient, refundTo);
        vm.expectRevert(UniswapV3Adapter.ZeroAddress.selector);
        adapter.swapExactOut(address(nvda), address(usdg), 1, 1, address(0), refundTo);
        vm.stopPrank();
    }

    function testFuzz_exactOutRefund(uint256 amountOut, uint256 extraBps) public {
        amountOut = bound(amountOut, 1, 1_000_000e6);
        extraBps = bound(extraBps, 0, 5_000);
        uint256 needed = Math.mulDiv(amountOut, 1e18, 180e6, Math.Rounding.Ceil);
        uint256 maxIn = needed + needed * extraBps / 10_000;
        _fund(address(nvda), maxIn);
        vm.prank(caller);
        uint256 amountIn =
            adapter.swapExactOut(address(nvda), address(usdg), amountOut, maxIn, recipient, refundTo);
        assertEq(amountIn, needed);
        assertEq(usdg.balanceOf(recipient), amountOut);
        assertEq(nvda.balanceOf(refundTo), maxIn - needed);
        _assertClean();
    }

    // ------------------------------------------------------------------ exact input (buyback)

    function test_exactInSingle() public {
        _fund(address(usdg), 360e6);
        vm.prank(caller);
        uint256 out = adapter.swapExactIn(address(usdg), address(nvda), 360e6, 2e18, recipient);
        assertEq(out, 2e18);
        assertEq(nvda.balanceOf(recipient), 2e18);
        assertEq(router.lastFee(), 500);
        _assertClean();
    }

    function test_exactInMultiHop() public {
        router.setRate(address(usdg), address(nvda), 1e18, 180e6);
        bytes memory fwd =
            abi.encodePacked(address(usdg), uint24(500), address(weth), uint24(3000), address(nvda));
        vm.prank(owner);
        adapter.setPath(address(usdg), address(nvda), fwd);
        _fund(address(usdg), 180e6);
        vm.prank(caller);
        uint256 out = adapter.swapExactIn(address(usdg), address(nvda), 180e6, 1, recipient);
        assertEq(out, 1e18);
        assertEq(router.lastPath(), fwd);
        _assertClean();
    }

    function test_exactInMinOutReverts() public {
        _fund(address(usdg), 360e6);
        vm.prank(caller);
        vm.expectRevert(MockSwapRouter02.TooLittleReceived.selector);
        adapter.swapExactIn(address(usdg), address(nvda), 360e6, 2e18 + 1, recipient);
    }

    function test_exactInUnderConsumingRouterRefundsCaller() public {
        router.setUnderConsume(true);
        _fund(address(usdg), 360e6);
        vm.prank(caller);
        uint256 out = adapter.swapExactIn(address(usdg), address(nvda), 360e6, 1e18, recipient);
        assertEq(out, 1e18);
        assertEq(usdg.balanceOf(caller), 180e6, "leftover input returned to caller");
        _assertClean();
    }

    // ------------------------------------------------------------------ rescue

    function test_rescue() public {
        _fund(address(nvda), 7);
        vm.prank(owner);
        adapter.rescue(address(nvda), owner, 7);
        assertEq(nvda.balanceOf(owner), 7);
    }
}
