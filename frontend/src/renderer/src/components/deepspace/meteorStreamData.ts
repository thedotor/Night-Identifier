// Which /deepspace/orbits body each meteor shower's debris stream rides. The key is the shower `code`
// from eventsSky.ts's SHOWERS; the value is the small-body `id` the backend reports for its parent
// (orbits.py's NOTABLE list), i.e. its SBDB designation lower-cased with '/' and spaces stripped.
export const SHOWER_PARENT: Record<string, string> = {
  QUA: '2003eh1', // 2003 EH1
  LYR: 'c1861g1', // C/1861 G1 (Thatcher)
  ETA: '1p', // 1P/Halley
  SDA: '96p', // 96P/Machholz
  PER: '109p', // 109P/Swift-Tuttle
  GIA: '21p', // 21P/Giacobini-Zinner (Draconids)
  ORI: '1p', // 1P/Halley
  STA: '2p', // 2P/Encke (Southern Taurids)
  NTA: '2p', // 2P/Encke (Northern Taurids)
  LEO: '55p', // 55P/Tempel-Tuttle
  GEM: '3200', // 3200 Phaethon
  URS: '8p' // 8P/Tuttle
}
