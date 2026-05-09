import { COIN_LOGOS } from './coin-logos.js'

export const COINS = [
  {
    id: 'btc', label: 'Bitcoin', symbol: 'BTC', geckoId: 'bitcoin',
    logo: COIN_LOGOS.BTC,
    networks: [{ label: 'Bitcoin', addrKey: 'btc_address' }],
  },
  {
    id: 'eth', label: 'Ethereum', symbol: 'ETH', geckoId: 'ethereum',
    logo: COIN_LOGOS.ETH,
    networks: [
      { label: 'Ethereum', addrKey: 'eth_address' },
      { label: 'Base', addrKey: 'eth_address' },
      { label: 'Arbitrum', addrKey: 'eth_address' },
    ],
  },
  {
    id: 'usdt', label: 'Tether', symbol: 'USDT', geckoId: 'tether',
    logo: COIN_LOGOS.USDT,
    networks: [
      { label: 'BEP-20 (BSC)', addrKey: 'eth_address' },
      { label: 'Tron (TRC-20)', addrKey: 'tron_address' },
      { label: 'Ethereum (ERC-20)', addrKey: 'eth_address' },
      { label: 'Arbitrum', addrKey: 'eth_address' },
    ],
  },
  {
    id: 'usdc', label: 'USD Coin', symbol: 'USDC', geckoId: 'usd-coin',
    logo: COIN_LOGOS.USDC,
    networks: [
      { label: 'Base', addrKey: 'eth_address' },
      { label: 'Arbitrum', addrKey: 'eth_address' },
      { label: 'Ethereum', addrKey: 'eth_address' },
    ],
  },
  {
    id: 'trx', label: 'TRON', symbol: 'TRX', geckoId: 'tron',
    logo: COIN_LOGOS.TRX,
    networks: [{ label: 'TRON', addrKey: 'tron_address' }],
  },
]
