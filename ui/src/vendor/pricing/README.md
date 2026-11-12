# ERP's pricing engine, built for the browser (vendored, not edited)

`ferrum_erp_pricing.js` and `ferrum_erp_pricing_bg.wasm` are what ERP's `scripts/pricing-wasm.sh` builds from its pure
pricing crate (`priceBasket(json) -> json`); `ferrum_erp_pricing.d.ts` is the glue's own typing. The till loads them
only to price a sale offline (`../../lib/pricing.ts`), and its worker keeps them for use with no network.

| | |
|---|---|
| ERP commit | `1bbf893` (ERP 0.26.0, branch `gaps/pricing-crate`) |
| Crate | `ferrum-erp-pricing` 0.1.0, wasm-bindgen 0.2.129 |
| Snapshot schema | 1 (`docs/pricing.md` in ERP) |
| `ferrum_erp_pricing.js` | `sha256 a8ed9da59fcc22a89e1c7a67e5ea49f25c503f1d31cee5ce257670b072f42c2e` |
| `ferrum_erp_pricing_bg.wasm` | `sha256 0af3f89d16f5cee53f602ce9156229436e6a5fc9c6e4b035fb5feefacb3632be` |

To update: build again in ERP (`scripts/pricing-wasm.sh --check`), copy the two files, and change this table. A new
snapshot schema needs a new build and a new `PRICING_SCHEMA` in `lib/pricing.ts`.
