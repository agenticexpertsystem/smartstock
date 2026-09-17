# S&P 500 期权快照 / S&P 500 options snapshot

本目录只保留 **当天的一个文件**: `chains_YYYYMMDD.parquet`。
所有汇总 (每股一行、股票 × 到期日、max pain、OI 墙、年化权利金等) 都能由它派生, 因此不再落盘;
旧快照由采集工具自动删除 (完整历史保存在本地 `aiagent/data/options/`, 供 IV Rank 与回测使用)。

## chains_YYYYMMDD.parquet
每个合约一行, 覆盖 **全部已挂牌到期日** (周度 -> LEAPS), 行权价在现价 ±35% 内。

| 字段 | 说明 |
|---|---|
| `ticker, date, expiry, dte, type` | 代码 / 快照日 / 到期日 / 剩余天数 / C=call P=put |
| `strike, bid, ask, mid, last` | 行权价与报价; **`mid` 仅在双边报价 (bid>0 且 ask>0) 时计算**, 否则为空 |
| `iv, delta, gamma, theta, vega` | CBOE 计算的隐含波动率与希腊字母 |
| `oi, volume` | 未平仓量 / 当日成交量 |
| `spot, iv30, hv20, iv_hv_ratio, pcr_oi, put_skew` | 该股票的快照指标 (每行重复, 便于单文件自包含) |
| `iv_rank, iv_pctl` | 需要 >= 20 天本地历史, 积累完成前为空 |
| `name, sector, sub_industry` | 标普 500 成分股信息 |

## 两个工具
```bash
# 采集 (默认: 标普500, 全部到期日, 只保留当天快照)
python aiagent/tools/options_collect.py
python aiagent/tools/options_collect.py --max-dte 120          # 只要 120 天内
python aiagent/tools/options_collect.py --tickers NVDA ALMS
python aiagent/tools/options_collect.py --keep-days 5          # 保留最近 5 天

# 查看 (汇总表即时派生, 无需额外文件)
python aiagent/tools/options_view.py --list --sort ann_yield --min-oi 500 --max-spread 0.10
python aiagent/tools/options_view.py --ticker AAPL             # 按到期日 + 每个行权价
python aiagent/tools/options_view.py --ticker AAPL --expiry 2027-01-15 --type P
python aiagent/tools/options_view.py --json AAPL               # 人可读 JSON (单只股票)
python aiagent/tools/options_view.py --html                    # 索引页 + 每只股票一页 (不入库)
```

## 局限 (重要)
- CBOE 延迟报价 (约 15 分钟), **不可用于成交决策**
- 未平仓量 (OI) 不含买卖方向, **不等于支撑/阻力**
- 无期权、停牌或当日抓取失败的成分股不在文件中
