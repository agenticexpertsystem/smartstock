# 工具总览

美股量化分析系统。目标：**找到强买入信号，通过卖 put 盈利**。

所有工具在 `aiagent/tools/`，数据在 `aiagent/data/`，报告在 `aiagent/data/review/` 与 `aiagent/reportdata/`，
对外发布的报告与数据在 `aiagent/smartstockrepo/`（GitHub Pages: https://agenticexpertsystem.github.io/smartstock/）。

---

## 先读这一节：哪些结论是真的

这个系统的价值不在于工具多，而在于它**证伪了大部分看起来有用的东西**。下面这张表是所有回测的净结果。

### ✅ 通过样本外检验

| 信号 | 效果 | 出处 |
|---|---|---|
| **内部人公开市场买入（Form 4 code P）+ 价格在 MA200 上方** | 卖 put 同月同 HV 分层超额 **+0.78%/笔，t=2.98** | `put_backtest.py` |

**就这一条。** 这是全部。

### ❌ 检验后否定

| 说法 | 实测结果 | 出处 |
|---|---|---|
| 跟随高胜率 13F 机构 | 样本外无效，持续性 β=−0.09 (t=−3.7)，**为负** | `entity_winrate.py` `follow_horizon.py` |
| 跟随国会议员 / 内部人**个人**胜率 | 3588 家机构、1479 位内部人、69 位议员**无一通过**；训练期胜率最高的一组，测试期胜率反而最低 | `entity_winrate.py` |
| 波动收缩（均线粘合 / 布林带宽 / ATR 收缩）预告拉升 | **标签污染**。门槛用 HV20 时 AUC 0.630，改用 HV120 后符号翻转、AUC **0.504**（= 无预测力）；且对上涨(−11.8%)与下跌(−11.5%)完全对称，**不含方向信息** | `markup_backtest.py` |
| 筹码集中 / 下方密集支撑 / 单峰密集 | 全部 0.93–1.02×，无一跑赢基础率；**单峰密集是反向指标**（上涨 −4.8% / 下跌 +4.7%） | `markup_backtest.py` |
| 放量吸筹（≥2 个放量上涨日 + OBV 向上） | 事件率 7.5% vs 基础 13.6% = **0.55×，可靠地反向** | `markup_backtest.py` |
| 高 HV 更适合卖 put | 权利金模型假设 IV=HV×VRP 造成的**定价假象**；效果随 VRP 缩放（+0.97% @0.9 → +3.16% @1.5），而内部人信号在各 VRP 下稳定在 +0.79% | `put_backtest.py` |
| ECL 放量之后会涨 | 原始 p=0.025，BH 校正后 **q=0.48，不显著**（此前临时脚本给的 p=0.003 是错的） | `event_study.py` |

### ⚠️ 有迹象但不足以下注

| 说法 | 实测 |
|---|---|
| 缩量企稳 + 站上 MA200 | 干净口径下 1.15×（t=+2.55），是唯一站住的形态规则 |
| 长上下影线 + 跳空高开 | 上涨 +4.9% / 下跌 −4.7%，方向相反=有真实方向性，但只有约 5 个百分点 |

---

## 一、统计检验与回测（系统的核心）

这几个工具的共同点：**强制做正确的统计**。时点股票池、非重叠样本、聚类标准误、多重比较校正、训练/测试切分。

### `put_backtest.py` — 卖 put 回测
什么条件下卖现金担保 put 更赚钱、更少被击穿。没有历史期权报价，权利金用 Black-Scholes 近似（sigma = HV 混合 × VRP，默认 1.10）。

关键设计：时点股票池（`liquid_matrix` 按日累计持有人数，**不能按月取整**，否则前视）、非重叠样本（`step=hold`）、同月同 HV 十分位配对基准、双向聚类标准误（Cameron-Gelbach-Miller，含 PSD 回退）、BH q 值、VRP 敏感性（每个 VRP 重算自己的基准）。

```bash
python tools/put_backtest.py
```

### `markup_backtest.py` — 拉升前特征回测
把"庄家拉升"定义成可验证事件，检验 34 个前置特征（均线收敛 / 筹码分布 / 量价 / 开收盘 / 位置）。

**两个开关必须用，否则结论是假的：**
- `--vol-window 120`：事件门槛改用长期波动，与 `hv_ratio` 的分子脱钩。用默认的 20 会造成标签污染。
- `--direction down`：对称检验。如果一个特征对涨跌预测力一样，它就不含方向信息。

筹码分布用换手衰减模型逐日推进（每日 `chips × (1 − 成交量/流通股)`，当日成交量按 [最低,最高] 三角权重分配），只用当天及之前的数据。

```bash
python tools/markup_backtest.py --vol-adjust --runup 1.5 --hold 0.8 --vol-window 120
python tools/markup_backtest.py --vol-adjust --runup 1.5 --hold 0.8 --vol-window 120 --direction down
```

模型样本外 AUC < 0.55 时**拒绝输出候选名单** —— 给一份看起来具体、实则等同随机的清单比不给更有害。

### `event_study.py` — 任意条件的事件研究
"这只股票放量之后会不会涨"这类问题的通用答案。**所有此类问题都应该走这个工具，不要手写脚本。**

三道强制关卡：
1. 基准 = 同一只股票同期的**无条件**前向收益（不是 0，也不是 SPY）
2. 移动块 bootstrap 随机化检验，块长 = 持有期，处理前向窗口重叠
3. BH FDR 校正，覆盖本次运行的**全部**（条件 × 持有期 × 标的）

`--pooled` 时按**日期块**抽样而非按行，处理同日横截面相关（不这么做 p 值会小一个数量级）。

```bash
python tools/event_study.py --tickers ECL --preset volume --horizons 5,10,20
python tools/event_study.py --tickers AAPL,MSFT --event "chip_profit>=0.8 and above_ma200>0" --pooled
python tools/event_study.py --list-vars     # 40+ 变量，与 markup_backtest 口径一致
```
预设：`volume` `squeeze` `chips` `reversal`

### `mispricing_scan.py` — 期权定价偏离扫描
判断一张期权贵不贵没有意义，必须先有**基准**。四层基准，前两层不需要任何预测模型：

| 层 | 指标 | 基准是什么 |
|---|---|---|
| 1 | `surface_z` | 同一到期日的 IV 曲面（IV vs ln(K/F)，Huber 加权拟合，异常点不会把基准拉过去） |
| 2 | `term_z` / `term_z_rel` | 同一 delta 桶的期限结构（IV vs √T）。**`term_z_rel` 减掉了当日截面中位数** —— 同一到期日在很多股票上同时偏贵是财报季/FOMC/三巫日的共同效应，不是个股偏离 |
| 3 | `vrp` / `vrp_z` | HAR-RV 预测的未来已实现波动 |
| 4 | `price_edge` | 块 bootstrap 蒙特卡洛公允价 |

**公允价不用 Black-Scholes**：BS 假设对数正态，而股票收益有肥尾和负偏，恰恰是 OTM put 最吃亏的地方，用 BS 会系统性低估 put 的真实价值、凭空造出一堆"便宜"的卖出机会。这里用该股票自己过去两年的日收益做块 bootstrap（保留肥尾与波动聚集），整体缩放到 HAR 预测的波动，再风险中性折现。

**净边际**按卖方实际成交的 **bid**（不是中间价）计算，再扣滑点、蒙特卡洛误差、以及波动预测误差造成的公允价上移。

漏斗（每层都在删东西）：350,088 张 → 流动性 751 → 剔除财报 607 → 曲面/期限异常 19 → 扣成本后 15。

三个关键设计：
- **第三层默认不启用**。IV 长期高于已实现波动是**波动率风险溢价**，是承担风险的报酬，不是定价错误。把"IV−预测RV 为正"当入池条件会被这个普遍现象刷屏。要等 IV 快照积累 ≥20 天，能算出"这只股票自己历史上正常的 VRP"之后才自动启用。
- **财报用真实的下次财报日**（`yfinance.get_earnings_dates`，本地缓存），不用 `info['earningsTimestamp']` —— 后者经常停在**上一次**财报。第一版就是因为这个漏判，候选全是十月底财报季的科技股。
- **`IV/HV20 ≥ 2` 自动标注"事件嫌疑"**。财报能自动查，诉讼/监管/并购/临床不能。

```bash
python tools/mispricing_scan.py --universe sp500      # 每天跑，自动留痕
python tools/mispricing_scan.py --evaluate            # 到期后回看真实盈亏
```

每天把候选写入 `data/analysis/mispricing_log.parquet`。**在"score 高的候选未来实际盈亏是否真的更好"这张图出来之前，这份名单只是研究线索，不是交易信号。**

### `smart_money.py` — Smart-Money 胜率与回归
找历史上买得最准的机构/内部人/议员及其擅长领域。`ols()` 含 NaN 过滤、秩检验、`MIN_CLUSTERS=12`、双向聚类与 PSD 回退。

### `entity_winrate.py` — 逐实体胜率检验
对每个 13F 机构 / 内部人 / 议员做月度二项检验 + BH，**只在训练期判定显著性**，再看测试期。结论：无一通过。

### `follow_horizon.py` / `follow_backtest.py` — 跟谁、跟多久
1/3/6 个月跟单胜率。区分**议员实际操作日**与**我们最早能跟的公开日**（含申报延时），两个口径都算。`oos_ok` 要求训练期排名前 20%，避免用全样本排名做样本外检验的循环论证。

---

## 二、选股与筛选

### `put_screener.py` — 卖 put 候选（日常主力工具）
只用通过检验的条件。**分档来自信号，排序来自期权性价比，两者分开。**

- A/B 档：有内部人公开市场买入（唯一验证过的信号）。C 档：只有期权性价比，没有方向性依据。
- 硬性剔除：价格在 MA200 下方 · 到期前有财报 · 未平仓不足 · 点差过宽 · 安全垫 < 1σ
- 安全垫 = (现价 − 行权价) / (HV20 × √(DTE/365))，用几个 sigma 衡量，跨股票可比
- **默认只选周期权**（`--expiry weekly`，月度 = 每月第三个星期五）

三个内建的防坑：
- 剔除**同日同价 ≥3 人**的"计划性买入"（董事报酬股票选择，不是主动看多。SPG 曾因此被误判为最强信号）
- `IV/HV > 2` 标记为**未知事件定价**并降权（WBD 正处于 Paramount 并购诉讼中，高 IV 是交易破裂风险，且 HV20 被并购价钉住导致安全垫严重高估）
- Yahoo 财报日停留在**上一次**财报时（502 只里有 145 只如此），标注"日期未知，需人工核对"，不静默放行

```bash
python tools/put_screener.py                          # 周期权，全部档
python tools/put_screener.py --tier A                 # 只看有内部人买入的
python tools/put_screener.py --expiry monthly --min-oi 100
```

### `screen_sp500.py` — 标普 500 综合筛选
500 只全打分 + 每只标的执行方案。**注意：它的权重里包含筹码/均线粘合/MaxPain，而这些已被 `markup_backtest.py` 否定**，所以它更适合当"全景视图"，卖 put 决策以 `put_screener.py` 为准。

基本面走 `data/analysis/fundamentals_cache.parquet`，缓存内（默认 7 天）不重复下载。

---

## 三、数据采集与本地仓库

**原则：下载后留在本地，不重复下载。**

| 工具 | 产出 | 说明 |
|---|---|---|
| `datakit.py` | `data/13f` `data/insider` `data/congress` `data/prices` | 主采集器，每天跑一次，增量更新，可断点续跑（OCR 每 5 份存一次 checkpoint） |
| `ohlcv_store.py` | `data/prices/ohlcv.parquet` | 日线 OHLCV（503 只 × 8 年 ≈ 99 万行 / 26MB）。首次全量，之后只补最新交易日。**筹码分布与量价分析的数据基础**（`close.parquet` 只有收盘价，没有成交量） |
| `options_collect.py` | `smartstockrepo/stockdata/option/chains_YYYYMMDD.parquet` | 一条命令：选股票池 → 抓 CBOE 期权链 → 导出自包含数据集。**只保留当天**，其余可从文件算出的一律不存 |
| `option_snapshot.py` | `data/options/chains/` | 每日快照底层实现，积累自己的 IV 历史 → IV Rank |
| `scrape_insider_trading.py` `insider_trace.py` | Form 3/4/5 | 含 10b5-1 标记 |
| `house_trace.py` `member_backfill.py` `ptr_ocr.py` `ptr_grid.py` | 国会 PTR | 扫描件用 Qwen2.5-VL 本地 OCR；`ptr_grid` 用 OpenCV 做确定性的表格网格与勾选识别 |
| `find13fhr.py` `fund_13f.py` | 13F-HR | 含 PUT/CALL；单位推断 + 价格交叉校验（Duquesne 2023 后以千为单位）；OpenFIGI 只接受**精确名称匹配**（曾把 Hess 映射成 HESM） |
| `earningreport.py` | 8-K Item 2.02 | Playwright |
| `pdf_ocr.py` | 可搜索 PDF | 通用工具 |

```bash
python tools/datakit.py                      # 每日增量
python tools/ohlcv_store.py                  # 补最新行情
python tools/options_collect.py              # 今日期权快照
```

---

## 四、个股 / 机构 / 人物分析

| 工具 | 用途 |
|---|---|
| `fund_13f.py` | 单个机构历史调仓逐笔（含期权），如 Druckenmiller/Duquesne |
| `member_trades.py` | 单个议员逐笔跟单证据：交易日价 → 公开日后首个可跟价 → 1/3/6/9/12/18/24 个月及至今 |
| `member_options.py` | 议员 call 逐笔到期收益。匹配平仓要求**到期日一致 + 日期窗口**，只按行权价匹配会错 |
| `sector_biotech.py` | 临床管线（ClinicalTrials.gov v2）+ 监管（openFDA）+ 现金跑道（SEC XBRL，YTD 现金流需做差分） |
| `stock_pe.py` | PE 分析，区分 GAAP / Non-GAAP |
| `pricevolumn_distribution.py` | 单只股票的完整换手衰减筹码分布（联网，逐只） |
| `indicators.py` | 市场环境 + 期权指标补充 |
| `macro_eco.py` `fed_scheduler.py` | 宏观日历、FOMC 鹰鸽打分与市场反应 |

---

## 五、报告与展示

| 工具 | 用途 |
|---|---|
| `html_report.py` | 数据包 → 单文件 HTML（不截断），顶部带数据质量横幅 |
| `result_html.py` | Claude 分析 Markdown → 中英双语 HTML；中文比 `_en.md` 新时自动重译 |
| `i18n.py` | 所有报告共用的双语层 |
| `options_view.py` | 期权快照明细：终端按到期日分组 / `--json TICKER` / `--html` |
| `smartstockrepo/options/` | 浏览器内直接读 parquet（hyparquet）。注意 GitHub Pages 会 gzip，Range 请求作用在压缩字节上，所以必须整文件下载 |

---

## 六、典型工作流

**每日**
```bash
python tools/datakit.py                 # 增量更新 13F/内部人/国会/价格
python tools/ohlcv_store.py             # 补最新 OHLCV
python tools/options_collect.py         # 今日期权快照
python tools/put_screener.py            # 卖 put 候选（周期权）
```

**想验证一个想法**
```bash
python tools/event_study.py --list-vars
python tools/event_study.py --tickers XXX --event "<条件>" --horizons 5,10,20
```
不要因为看到一个漂亮的 p 值就相信它 —— 先看 q 值，再看事件数，再看它在 `--direction down` 下是不是一样显著。

**深入一只股票**
```bash
python tools/insider_trace.py XXX
python tools/pricevolumn_distribution.py XXX --chart
python tools/sector_biotech.py XXX          # 生物医药
python tools/options_view.py XXX
```

---

## 七、反复踩过的坑（新工具必须避开）

1. **前视**：任何滚动统计不要按月取整；时点股票池要按日累计。
2. **标签污染**：事件门槛不能与被检验的特征共用同一个量（HV20 事件门槛 vs `hv_ratio` 分子）。
3. **重叠样本**：前向窗口重叠时普通 t 检验的自由度是假的，要么非重叠抽样，要么块 bootstrap，要么按日期聚类。
4. **横截面相关**：同一天几百只股票不是几百个独立观测。按日期聚类或按日期块抽样。
5. **多重比较**：试了几十个条件必然有"显著"的。一律 BH 校正，并且按**实际试过的**数量校正，不是按最终报告的数量。
6. **幸存者偏差**：用今天的成分股回测历史，会系统性高估所有形态的成功率。
7. **方向 vs 幅度**：很多指标只预测波动幅度。必须做 `--direction down` 对称检验。
8. **数据源陷阱**：Yahoo 财报日常停在上一次；OpenFIGI 模糊匹配会张冠李戴；13F 金额单位 2023 前后不同；Form 4 的 P 代码混着董事报酬计划入账。
9. **高 IV 不是便宜**：IV/HV > 2 通常正确反映了并购/诉讼/临床等未知风险，且此时 HV20 被压低，用它算的"安全垫"会严重高估安全性。
10. **报告纪律**：模型样本外没有预测力时，不要输出候选名单。可为空，不可误导。

---

*最后更新：2026-09-18*
