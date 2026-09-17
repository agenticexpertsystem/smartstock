# S&P 500 期权快照 / S&P 500 options snapshot

每个交易日一组文件, 由 `aiagent/tools/option_snapshot.py --sp500 --out-dir <此目录>` 生成。

| 文件 | 内容 |
|---|---|
| `chains_YYYYMMDD.parquet` | 完整期权链: 每个合约一行, **全部已挂牌到期日**, 行权价在现价 ±35% 内 (JSON 约 15 倍体积, 每日快照会让仓库迅速膨胀, 故用 parquet) |
| `summary_YYYYMMDD.csv` | 每只股票一行: 现价、IV30、HV20、IV/HV、PCR、以及 30-45 天 ~0.20 delta 的 put 报价 |
| `meta_YYYYMMDD.json` | 快照来源、覆盖率、缺失代码、字段说明与局限 |

## chains 字段
`ticker, date, expiry, type (C/P), strike, bid, ask, last, iv, delta, gamma, theta, vega, oi, volume, dte, mid, sector`

需要人可读的 JSON 时按需导出单只股票 (约 200KB):
```bash
python aiagent/tools/options_view.py --json AAPL          # -> AAPL_20260917.json
```
结构如下:
```json
{ "ticker": "AAPL", "name": "Apple Inc.", "sector": "Information Technology",
  "snapshot_date": "20260917", "spot": 336.71, "iv30": 0.2337, "hv20": 0.237,
  "iv_hv_ratio": 0.986, "pcr_oi": 0.66,
  "expiries": [
    { "expiry": "2026-10-16", "dte": 29, "call_oi": 380588, "put_oi": 193909,
      "calls": [ {"strike": 300.0, "bid": 39.9, "ask": 40.4, "mid": 40.15, "iv": 0.2681,
                  "delta": 0.8452, "gamma": 0.0049, "theta": -0.0729, "vega": 0.2233,
                  "oi": 12345, "volume": 678, "last": 40.1}, ... ],
      "puts":  [ ... ] }, ... ] }
```
每个合约字段: `strike, bid, ask, mid, iv, delta, gamma, theta, vega, oi, volume, last`

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
本快照含 **全部已挂牌到期日** (默认不再截断): 从最近周度一直到 **2028 年的 LEAPS**, AAPL 等大盘股有 24 个到期日。
`by_expiry_YYYYMMDD.csv` 为 **股票 × 到期日** 一行, 共 5,642 行, 字段:
`ticker, expiry, dte, spot, call_oi, put_oi, pcr_oi, call_vol, put_vol, atm_iv, implied_move_pct,
max_pain, max_pain_vs_spot_pct, call_oi_wall, put_oi_wall, p20_strike/delta/bid/ask/mid/iv/oi/ann_yield, sector`

## 两个工具
```bash
# 1) 采集 (一条命令完成: 股票池 -> CBOE -> 导出四个文件 + 本地历史库)
python aiagent/tools/options_collect.py                      # 标普500, 全部到期日 (默认)
python aiagent/tools/options_collect.py --max-dte 120        # 只要 120 天内
python aiagent/tools/options_collect.py --universe liquid --max-dte 120
python aiagent/tools/options_collect.py --tickers NVDA ALMS

# 2) 查看明细
python aiagent/tools/options_view.py --ticker AAPL                       # 全部到期日 + 每个行权价
python aiagent/tools/options_view.py --ticker AAPL --expiry 2027-01-15 --type P
python aiagent/tools/options_view.py --list --sort ann_yield --min-oi 500 --max-spread 0.10
python aiagent/tools/options_view.py --html                              # 索引页 + 每只股票一页
```
`--html` 生成的 `view/` 约 57MB, 未入库 (见 .gitignore), 需要时本地重建即可。
