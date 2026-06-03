// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

contract MockPancakeV2Pair {
    address public immutable token0;
    address public immutable token1;

    uint112 private _reserve0;
    uint112 private _reserve1;
    uint32 private _blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    uint256 private constant Q112 = 2 ** 112;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function setReserves(uint112 reserve0, uint112 reserve1) external {
        _syncCumulatives();
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = _currentTimestamp();
    }

    function sync() external {
        _syncCumulatives();
        _blockTimestampLast = _currentTimestamp();
    }

    function getReserves() external view returns (
        uint112 reserve0,
        uint112 reserve1,
        uint32 blockTimestampLast
    ) {
        return (_reserve0, _reserve1, _blockTimestampLast);
    }

    function _syncCumulatives() internal {
        if (_reserve0 == 0 || _reserve1 == 0) return;

        uint32 blockTimestamp = _currentTimestamp();
        uint32 elapsed;
        unchecked {
            elapsed = blockTimestamp - _blockTimestampLast;
            price0CumulativeLast += (uint256(_reserve1) * Q112 / _reserve0) * elapsed;
            price1CumulativeLast += (uint256(_reserve0) * Q112 / _reserve1) * elapsed;
        }
    }

    function _currentTimestamp() internal view returns (uint32) {
        return uint32(block.timestamp % 2 ** 32);
    }
}
