# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/setyamickala/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/setyamickala/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

LaunchLens — a token launch radar for make.fun's token-radar-01 bounty. It reads the sealed DefiLlama snapshot, learns a per-sector valuation multiple from the snapshot's own live-token protocols (median market-cap / TVL by category), and ranks every pre-token protocol by an implied value = TVL × sector multiple × 7-day momentum × token-timing × conviction. The dashboard is a sortable, filterable board with a detail view and a costed farm plan for each protocol.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ./input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=tvfbjxfd&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
