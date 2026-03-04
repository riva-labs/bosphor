// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/BosphorAdapter.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("EVM_RELAYER_KEY");
        address relayer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        BosphorAdapter adapter = new BosphorAdapter(relayer);
        vm.stopBroadcast();

        console.log("BosphorAdapter deployed at:", address(adapter));
        console.log("Trusted relayer:", relayer);
    }
}
