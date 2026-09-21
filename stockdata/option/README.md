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
# 采集 (默认: 标普500, 全部到期日, python aiagent/tools/options_collect.py
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

## 保留策略：逐日累积，不删除

`chains_YYYYMMDD.parquet` —— 每个**交易日**一个文件，全部保留。

之所以不再只留当天：**CBOE 只提供当前报价，没有历史接口。** 今天不存，这一天的
IV 曲面就永远补不回来了。而 `mispricing_scan.py` 的第三层（`vrp_z`，即"这只股票
自己历史上正常的 IV−RV 是多少"）与 IV Rank 都必须靠逐日累积才能算出来。

文件按**交易日**命名（见 `aiagent/tools/market_cal.py`），周末/假日/开盘前采集
会归到上一个交易日，不会造出重复的假交易日。

### 体积

每天约 7 MB（35 万张合约 × 28 字段）。按每年约 252 个交易日估算，**一年约 1.8 GB**，
而 git 会永久保留每个文件。GitHub 建议单仓库控制在 1 GB 以内、硬上限 5 GB，
所以大约**半年后需要处理**。届时可选：

1. 老数据瘦身——只保留研究真正用到的部分（如 |delta| 0.05–0.50 的合约），体积可降一个量级
2. 改用 Git LFS 或独立的数据仓库 / Release 附件
3. 本地保留全量（`aiagent/data/options/chains/`），仓库只发布瘦身版

暂时**不做** zstd 压缩：只省约 17%（7.1 → 5.9 MB），但网页浏览器用的 hyparquet
原生只支持 snappy，换掉会让在线浏览器直接读不了。
