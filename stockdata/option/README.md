# S&P 500 期权快照 / S&P 500 options snapshot

每个交易日一组文件, 由 `aiagent/tools/option_snapshot.py --sp500 --out-dir <此目录>` 生成。

| 文件 | 内容 |
|---|---|
| `chains_YYYYMMDD.parquet` | 完整期权链: 每个合约一行 (到期 <= 75 天, 行权价在现价 ±35% 内) |
| `summary_YYYYMMDD.csv` | 每只股票一行: 现价、IV30、HV20、IV/HV、PCR、以及 30-45 天 ~0.20 delta 的 put 报价 |
| `meta_YYYYMMDD.json` | 快照来源、覆盖率、缺失代码、字段说明与局限 |

## chains 字段
`ticker, date, expiry, type (C/P), strike, bid, ask, last, iv, delta, gamma, theta, vega, oi, volume, dte, mid, sector`

- `mid` 仅在 **双边报价** (bid>0 且 ask>0) 时计算, 否则为空 — 单边报价的中间价会低估权利金。
- `iv` / 希腊字母来自 CBOE 的延迟报价计算值。

## summary 关键字段
- `iv30` CBOE 的 30 天 ATM 隐含波动率; `hv20` 本地 20 日历史波动率(年化); `iv_hv_ratio = iv30 / hv20`
- `p20_*` 30-45 天内、delta 最接近 -0.20 且有买价的 put: 行权价、买卖价、中间价、IV、未平仓、点差比例、年化权利金收益率
- `iv_rank` / `iv_pctl` 需要 >= 20 天本地历史快照, 积累完成前为空

## 局限 (重要)
- CBOE 延迟报价 (约 15 分钟), **不可用于成交决策**
- 未平仓量 (OI) 不含买卖方向, **不等于支撑/阻力**
- 无期权、停牌或当日抓取失败的成分股不在文件中 (见 meta 的 `tickers_missing`)
