// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockPancakeInfinityUniversalRouter {
    using SafeERC20 for IERC20;

    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        address hooks;
        address poolManager;
        bytes hookData;
        bytes32 parameters;
    }

    struct CLSwapExactInputParams {
        address currencyIn;
        PathKey[] path;
        uint128 amountIn;
        uint128 amountOutMinimum;
    }

    uint256 public orbdPerUsdtRate = 2e18;
    CLSwapExactInputParams public lastSwap;

    function setOrbdPerUsdtRate(uint256 rate) external {
        orbdPerUsdtRate = rate;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256) external payable {
        require(commands.length == 1 && uint8(commands[0]) == 0x10, "INVALID_COMMAND");
        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        require(actions.length == 3, "INVALID_ACTIONS");
        require(uint8(actions[0]) == 0x07, "INVALID_SWAP_ACTION");
        require(uint8(actions[1]) == 0x0c, "INVALID_SETTLE_ACTION");
        require(uint8(actions[2]) == 0x0f, "INVALID_TAKE_ACTION");

        CLSwapExactInputParams memory swapParams = abi.decode(params[0], (CLSwapExactInputParams));
        (address outputCurrency, uint256 takeMinimum) = abi.decode(params[2], (address, uint256));
        require(swapParams.path.length > 0, "EMPTY_PATH");
        require(outputCurrency == swapParams.path[swapParams.path.length - 1].intermediateCurrency, "BAD_OUTPUT");

        uint256 amountOut = (uint256(swapParams.amountIn) * orbdPerUsdtRate) / 1e18;
        require(amountOut >= swapParams.amountOutMinimum && amountOut >= takeMinimum, "INSUFFICIENT_OUTPUT");

        delete lastSwap.path;
        lastSwap.currencyIn = swapParams.currencyIn;
        lastSwap.amountIn = swapParams.amountIn;
        lastSwap.amountOutMinimum = swapParams.amountOutMinimum;
        for (uint256 i = 0; i < swapParams.path.length; i++) {
            lastSwap.path.push(swapParams.path[i]);
        }

        IERC20(outputCurrency).safeTransfer(msg.sender, amountOut);
    }
}
