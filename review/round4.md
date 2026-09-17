复核结论：多数修复方向正确，但有 4 个会影响实证结论的关键缺陷需要继续修。

1. `smart_money.py` 的 `ols()`

判定：修对了（部分），有新问题。

已修对：

- NaN 行在聚类标签取值前同步过滤，索引对齐正确。
- `MIN_CLUSTERS=12` 会阻止小簇数下输出伪显著 t 值。
- CGM 公式 `V1 + V2 - V12` 实现正确。
- 有限样本修正形式基本合理。

问题：

- “非正定回退”只检查协方差矩阵对角线是否为负；矩阵仍可能不半正定。
- 回退时按 meat 的 trace 选择单向聚类，不能保证对每个系数都是更保守的标准误。
- 未检查 `X` 的秩亏；`pinv` 会给出表面可用、实际上不可识别的系数与 t 值。
- `cluster=None, cluster2!=None` 时会完全忽略第二维聚类。

建议替换核心退化处理：

```python
rank = np.linalg.matrix_rank(X)
if rank < k:
    return None

# ...
cov = sandwich(cl1)
if cl2 is not None:
    both = np.array(list(zip(cl1, cl2)), dtype=object)
    _, both = np.unique(both, axis=0, return_inverse=True)
    cov = cov + sandwich(cl2) - sandwich(both)

    # CGM 有限样本下可非 PSD；不只检查对角线
    eig_min = np.linalg.eigvalsh((cov + cov.T) / 2).min()
    if eig_min < -1e-12:
        c1, c2 = sandwich(cl1), sandwich(cl2)
        # 逐系数选择较大的方差，避免 trace 规则在某个系数上反而更激进
        cov = np.diag(np.maximum(np.diag(c1), np.diag(c2)))
```

若目标是“保持单向聚类协方差结构”，应明确选定主聚类维度，而不要把 trace 当作“保守性”判断。

2. `put_backtest.py`

判定：部分修对；时点矩阵仍未修对，另有 VRP 与敏感性口径问题。

已修对：

- 默认 `step=hold` 时，同一股票第 `t` 日开仓、`t+hold` 日到期结算，下一笔才开仓，持有区间没有重叠；边界日同日结算/再开仓是可接受的。
- 13F 共识由“季度终态人数”改为公开顺序累计，方向正确。
- 内部人集群人数在 `attach()` 去重前计算，且用不同 `entity_id` 计数，正确。
- 现金担保 put 的 `K × (e^(rT)-1)` 利息方向正确；但严格说，收到的权利金也应在持有期计息。
- 回归的双向聚类、BH q 值计算正确。

未修对：`liquid_matrix()` 存在明确前视。

当前代码将 `event_date` 降为月份：

```python
e["m"] = pd.to_datetime(e.event_date).values.astype("datetime64[M]")
```

例如 5 月 15 日披露的第 100 位机构持仓，会被记入 5 月 1 日；随后日频 `ffill` 使 5 月 1–14 日也“已知”该信息。这是前视偏差。

另外，它基于 `events_13f.parquet` 的 NEW/ADD 事件首次出现累计，而不是每份公开 13F 的实际持仓快照：

- 未新建/加仓、但持续持有的机构不会计入；
- 后续卖出/清仓不会扣除；
- 因而其名称“持有机构数”与实际含义不符。

至少先修复月初回填，并让共识只在第 20 个独立机构披露时触发：

```python
# 不要转为 datetime64[M]；按真实公开日累计
e["known_date"] = pd.to_datetime(e["event_date"]).dt.normalize()
first = (e.sort_values("known_date")
           .drop_duplicates(["ticker", "entity_id"], keep="first"))

daily = (first.groupby(["known_date", "ticker"]).size()
              .unstack("ticker", fill_value=0)
              .cumsum())

daily = daily.reindex(px.index, method="ffill").fillna(0)
ok = daily.ge(min_holders).reindex(columns=px.columns, fill_value=False)
```

但这仍只是“曾公开 NEW/ADD 的机构累计数”，不是真实持有人数。正确实现应从 `positions.parquet` 按每位管理人的每次公开持仓快照生成增减量；新快照中的新增 ticker 加 1、旧快照中消失 ticker 减 1，并以披露后的首个交易日生效。

13F 共识建议改为避免 `groupby().first()` 对不同列分别取首个非空值：

```python
f = f.sort_values(["ticker", "period", "event_date", "entity_id"])
f = f.drop_duplicates(["ticker", "period", "entity_id"], keep="first")
f["n_known"] = f.groupby(["ticker", "period"]).cumcount() + 1

# 第 20 位首次公开时才产生事件
cons = f.loc[f["n_known"].eq(20)].copy()
```

新问题：

- VRP 敏感性调用 `hv_match()` 时复用了默认 VRP 的 `cells`。因此非默认 VRP 的 `ex_hv` 不是对“同 VRP、同月、同 HV 分桶”的超额收益。
- Delta 敏感性没有应用 `liq` 时点矩阵，和主结果的可交易样本口径不一致。
- `liquid_universe()` 仍用全历史事件数预筛列。即使主面板随后用 `liq` 过滤，也不应把它描述为“时点流动性股票池”。

将 `hv_match` 改为每次独立计算基准：

```python
def hv_match(d: pd.DataFrame) -> pd.DataFrame:
    d = d.copy()
    edges = d.hv20.quantile(np.linspace(0, 1, 11)).values
    d["_m"] = pd.to_datetime(d.date).dt.to_period("M")
    d["_b"] = np.clip(np.searchsorted(edges, d.hv20.values) - 1, 0, 9)

    cells = d.groupby(["_m", "_b"]).agg(
        _br=("roc", "mean"),
        _bb=("breach", "mean"),
    )
    d = d.join(cells, on=["_m", "_b"])
    return d.assign(
        ex_hv=d.roc - d._br,
        br_hv=d.breach - d._bb,
    ).drop(columns=["_m", "_b", "_br", "_bb"])
```

权利金利息若采用“所有现金余额均计息”的口径：

```python
cash_interest = (K + prem) * (np.exp(rate * T) - 1)
roc = (prem - loss + cash_interest) / K
```

3. `sector_biotech.py`

判定：标签优先级与情景标注基本修对；季度 burn 算法未修对。

已修对：

- `CashCashEquivalentsAndShortTermInvestments` 被单独优先用于公司“现金+短期证券”披露口径，这是合理的优先标签。
- 现金、短期投资、长期投资、受限现金被分拆输出，避免将 Yahoo `totalCash` 直接当作现金。
- 三个 burn 假设写在情景名称里：基准、`+40%`、`-20%`；并额外标注了仅流动资金下限。
- sponsor 名称匹配的漏报风险已在模块说明和最终 caveat 中提示。

未修对：YTD OCF 没有转换为单季度 OCF。

目前：

```python
q.append(x["val"] / days * 91.0)
```

对 Q2 YTD / Q3 YTD 只是把累计值年化/季化，不能得到该季度实际净流出。比如 Q2 YTD 为 -60M、Q1 为 -20M，Q2 单季应为 -40M，而当前会算为约 -30M。

建议按同一财年相邻 YTD 现金流相减；只有找不到前一期时才使用近似，并明确标记：

```python
def quarterly_ocf(rows: list[dict]) -> list[float]:
    x = []
    for r in rows:
        if not r.get("start") or r.get("form") not in ("10-Q", "10-K"):
            continue
        start, end = pd.Timestamp(r["start"]), pd.Timestamp(r["end"])
        days = (end - start).days
        if days > 0:
            x.append({**r, "_start": start, "_end": end, "_days": days})

    # 同一结束日保留最新申报，避免 amendment/重复 facts
    x = sorted(x, key=lambda r: (r["_end"], r.get("filed", "")))
    latest = {}
    for r in x:
        latest[(r["_start"], r["_end"])] = r
    x = sorted(latest.values(), key=lambda r: r["_end"])

    out = []
    for r in x:
        # 约一季度时长：直接使用
        if 70 <= r["_days"] <= 110:
            out.append(r["val"])
            continue

        # YTD：与同一 fiscal-year start 的紧邻累计值相减
        prior = [p for p in x
                 if p["_start"] == r["_start"]
                 and p["_end"] < r["_end"]
                 and p["_days"] < r["_days"]]
        if prior:
            out.append(r["val"] - max(prior, key=lambda p: p["_end"])["val"])

    return out[-4:]
```

然后：

```python
q_ocf = quarterly_ocf(ocf)
burn = -float(np.median(q_ocf)) if q_ocf else None
```

新问题：

- 各现金标签目前独立取“最新值”，可能来自不同资产负债表日；`ce + sti` 因而可能混合两个季度。
- `concept()` 仅取最后 6 条，且未优先筛选 10-Q/10-K、最新 filed、同一 `end`；修订文件可能被旧值覆盖。
- `company.split()[0]` 的 openFDA sponsor 查询和去掉 “Therapeutics” 后的 CT.gov 查询都过宽，既可能漏掉子公司，也可能产生同名误匹配。应输出查询词、原始 sponsor、匹配规则和未验证标记，而不能把返回结果视作完整管线。

4. `html_report.py` 的 `data_quality_banner()`

判定：覆盖方向正确，但实现不够稳健，不能保证覆盖主要风险。

已覆盖：

- Yahoo 与 10-Q 现金口径冲突。
- 13F 滞后。
- 期权 OI 无方向、不可直接推为支撑阻力。
- 13F 本地缓存过期。
- 带非 `ok` 状态的嵌套采集任务失败。

问题：

- 现金冲突依赖单个脆弱正则：`Cash & Equiv:\s*\$...([MB])`。输出标签、货币、单位、语言或空格变化都会静默漏报。
- 未提供 `data_asof` 时，不会显示 13F 本身固有的最长 45 天滞后提醒。
- 期权只有存在对象时才提示，且不检查快照时间戳是否过期；缺失期权数据也不提示。
- 失败检测只遍历一层嵌套 `status`，会漏掉顶层状态、`error` 字段、异常文本、partial/skipped 状态。
- “Yahoo totalCash 含短期投资”不应作为必然事实，应写成“可能与短期投资或其他现金口径不同”。

建议将正则解析降级为兼容性兜底，并在不能解析时明确提示：

```python
sec_txt = html.unescape(str(sec_txt))
patterns = [
    r"Cash\s*(?:&|and)\s*(?:Equiv(?:alents)?|Cash Equivalents)\s*[:：]?\s*\$?\s*([\d,.]+)\s*([KMB])?",
    r"现金(?:及|与)?(?:现金)?等价物\s*[:：]?\s*\$?\s*([\d,.]+)\s*([KMB亿万])?",
]
matches = [re.search(p, sec_txt, flags=re.I) for p in patterns]
m = next((x for x in matches if x), None)

if yc is not None and not m:
    items.append(("info", L(
        "无法从 10-Q 文本可靠解析现金及等价物；现金口径冲突尚未完成核对。",
        "Could not reliably parse 10-Q cash and equivalents; cash reconciliation is incomplete."
    )))
```

并补一个无条件的 13F 说明：

```python
if not asof:
    items.append(("warn", L(
        "13F 截止日缺失；13F 本身通常在季末后最长 45 天披露，不得作为当前资金流判断。",
        "13F as-of date is missing; filings can lag quarter-end by up to 45 days."
    )))
```

5. `framework.md`

判定：规则方向正确、可作为人工执行清单；但存在输出契约冲突，无法稳定自动执行。

已修对：

- 证据分级、数值冲突不自行择优、禁止将 OI/13F 等实体化，规则清楚且必要。
- 缺失关键输入时禁止给精确价格、仓位和止损，要求生物医药专项块，逻辑正确。
- 评分纪律明确禁止主观加减分，并规定不可评分维度从分母剔除。

冲突：

- 第 11 条禁止输出精确入场价、目标价、止损和仓位；但摘要表和 JSON 模板仍要求这些字段为精确数值，且示例用 `0`。`0` 会被误读为真实价格。
- 第 11 条要求评分输出区间；JSON 却强制 `"score": 61` 单值。
- 缺失时只允许“持有观望/回避、低置信度”；第 25 条仍要求五选一但未说明这是对该规则的条件性例外。
- “评分从分母剔除”虽正确，但没有定义有效权重归一化公式，自动化实现会不一致。
- 目标价/评分仍可输出的条件没有与证据等级、关键字段完整性绑定。

建议将 JSON 模板改为允许空值与区间：

```json
{
  "rating": "持有观望",
  "confidence": "低",
  "score": null,
  "score_range": [35, 45],
  "price": null,
  "entry_low": null,
  "entry_high": null,
  "stop_loss": null,
  "target1": null,
  "target2": null,
  "position_pct": null,
  "withheld_fields_reason": [
    "现金构成存在未调节冲突",
    "真实 IV 快照缺失"
  ],
  "scores": {
    "macro": 6,
    "event_risk": null,
    "fundamental": null,
    "flow_chips": 5,
    "technical": 7,
    "options": null
  }
}
```

并补充硬规则：

```text
有效总分 = Σ(维度分数 × 原始权重) / Σ(可评分维度原始权重) × 10。
任一“关键输入”缺失、冲突未调节、或仅有模型估计时：
- rating 仅可为“持有观望”或“回避”；
- confidence 必须为“低”；
- price / entry / stop / target / position 必须为 null；
- score 必须为 null，或仅输出 score_range；
- 不得以技术指标、模型估计或低等级数据填补该限制。
```

总体上，最需要优先修的是：13F 日级可交易矩阵、XBRL YTD burn 差分、VRP 分桶重算，以及 framework 的 nullable 输出契约。