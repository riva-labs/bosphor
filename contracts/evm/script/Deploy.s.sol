// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/BosphorAdapter.sol";

contract DeployScript is Script {
    // LayerZero EndpointV2 on Sepolia
    address constant LZ_ENDPOINT_SEPOLIA = 0x6EDCE65403992e310A62460808c4b910D972f10f;

    function run() external {
        uint256 deployerKey = vm.envUint("EVM_RELAYER_KEY");
        address deployer = vm.addr(deployerKey);
        address relayer = vm.envOr("EVM_RELAYER_ADDRESS", deployer);

        vm.startBroadcast(deployerKey);
        BosphorAdapter adapter = new BosphorAdapter(LZ_ENDPOINT_SEPOLIA, deployer, relayer);
        vm.stopBroadcast();

        console.log("BosphorAdapter deployed at:", address(adapter));
        console.log("LZ Endpoint:", LZ_ENDPOINT_SEPOLIA);
        console.log("Owner/Delegate:", deployer);
        console.log("Trusted relayer:", relayer);
    }
}
