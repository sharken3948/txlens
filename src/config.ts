/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arc } from 'viem/chains'
import { injected } from 'wagmi/connectors'

export const config = createConfig({
  chains: [arc, mainnet], // Arc Mainnet for x402 payments; Ethereum mainnet for ENS
  connectors: [injected()],
  transports: {
    [arc.id]: http(),
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})
