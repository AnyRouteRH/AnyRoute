// B: the Stock Tokens with Chainlink feeds verified on Robinhood Chain mainnet (chain id 4663), copied from
// config/rhc-mainnet.json because nothing under src/ may import outside it (test/src-self-contained.test.ts).
// test/data-tools.test.ts keeps this list identical to the config file.
export const RHC_CHAIN_ID = 4663;
export const RHC_STOCK_TOKENS: readonly { symbol: string; address: string; decimals: number; feed: string }[] = [
  { symbol: "NVDA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", decimals: 18, feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15" },
  { symbol: "TSLA", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", decimals: 18, feed: "0x4A1166a659A55625345e9515b32adECea5547C38" },
  { symbol: "AAPL", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", decimals: 18, feed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0" },
  { symbol: "AMZN", address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", decimals: 18, feed: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C" },
  { symbol: "MSFT", address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", decimals: 18, feed: "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E" },
  { symbol: "GOOGL", address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", decimals: 18, feed: "0xF6f373a037c30F0e5010d854385cA89185AE638b" },
  { symbol: "META", address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", decimals: 18, feed: "0x7C38C00C30BEe9378381E7B6135d7283356D71b1" },
  { symbol: "SPY", address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", decimals: 18, feed: "0x319724394D3A0e3669269846abE664Cd621f9f6A" },
  { symbol: "QQQ", address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", decimals: 18, feed: "0x80901d846d5D7B030F26B480776EE3b29374C2ae" },
  { symbol: "MSTR", address: "0xec262a75e413fAfD0dF80480274532C79D42da09", decimals: 18, feed: "0x396118bdFB181e6240E74D243F266B061c0edc3D" },
  { symbol: "AMD", address: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", decimals: 18, feed: "0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72" },
  { symbol: "PLTR", address: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", decimals: 18, feed: "0x820ABedFF239034956B7A9d2F0a331f9F075eB4c" },
  { symbol: "COIN", address: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", decimals: 18, feed: "0xA3a468A452940B7D6b69991207B508c609a98Ef2" },
];
