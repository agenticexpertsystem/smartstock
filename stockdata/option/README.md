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

## 到期日覆盖
本快照含 **28 个到期日**, 从最近周度到 **547 天后的 LEAPS** (2028-03)。
`by_expiry_YYYYMMDD.csv` 为 **股票 × 到期日** 一行, 共 5,642 行, 字段:
`ticker, expiry, dte, spot, call_oi, put_oi, pcr_oi, call_vol, put_vol, atm_iv, implied_move_pct,
max_pain, max_pain_vs_spot_pct, call_oi_wall, put_oi_wall, p20_strike/delta/bid/ask/mid/iv/oi/ann_yield, sector`

## 两个工具
```bash
# 1) 采集 (一条命令完成: 股票池 -> CBOE -> 导出四个文件 + 本地历史库)
python aiagent/tools/options_collect.py                      # 标普500, 到期 <= 75 天
python aiagent/tools/options_collect.py --max-dte 550        # 含 LEAPS (本快照)
python aiagent/tools/options_collect.py --universe liquid --max-dte 120
python aiagent/tools/options_collect.py --tickers NVDA ALMS

# 2) 查看明细
python aiagent/tools/options_view.py --ticker AAPL                       # 全部到期日 + 每个行权价
python aiagent/tools/options_view.py --ticker AAPL --expiry 2027-01-15 --type P
python aiagent/tools/options_view.py --list --sort ann_yield --min-oi 500 --max-spread 0.10
python aiagent/tools/options_view.py --html                              # 索引页 + 每只股票一页
```
`--html` 生成的 `view/` 约 57MB, 未入库 (见 .gitignore), 需要时本地重建即可。
