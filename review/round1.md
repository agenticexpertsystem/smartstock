只读审核完成。核心判断：当前代码没有明显的“未来价格直接写入特征”的硬性前视错误，`searchsorted(..., side="right")` 的“披露日后首个交易日收盘入场”逻辑也是正确的；但统计推断和卖 put 定价假设存在足以改变结论可信度的重大问题。

## 主要问题

1. **高｜`tools/put_backtest.py:54-59, 329-342`｜全样本定义流动性股票池，产生幸存者/前视选择偏差**

`liquid_universe()`用整个历史样本内的 13F 持有人数筛股票；一只股票只要“未来某时”变得热门，就会进入“过去”的基准面板。并且事件组多数并未限制为该股票池，却与该股票池基准比较。

这会令“内部人买入 + MA200 上方”的超额收益混入股票可交易性、规模、存活性差异。

建议按每个信号日以前已知的持有人数构造时点股票池，并对事件、基准施加完全相同的可交易条件。例如：

```python
# 以披露日前已公开的 13F 事件构造当日可交易池
f = pd.read_parquet(os.path.join(OUT, "events_13f.parquet"))
f["event_date"] = pd.to_datetime(f["event_date"])

def liquid_asof(date, min_holders=100):
    known = f.loc[f.event_date < date]
    return set(
        known.groupby("ticker")["entity_id"].nunique()
        .loc[lambda s: s >= min_holders].index
    )

# 对每个事件日和基准日使用 liquid_asof(date)，并仅比较共同股票池。
```

2. **高｜`tools/put_backtest.py:124-135, 143-168, 178-193`｜25 日持有期、5 日抽样造成重叠样本，按日期或月份单向聚类不能修正**

同一股票每五天开一笔、每笔持有 25 天，任意相邻五笔共享大部分未来收益路径。当前：
- 面板回归只按 `date` 聚类；
- 事件统计按 `month` 聚类；
- 没有按股票聚类，也没有对重叠持有期使用 HAC / block bootstrap。

因此 `t=4.28`、HV 分组 t 值等大概率被高估。

最低成本修复是非重叠建仓；更推荐双向聚类并按持有期做 embargo。例如：

```python
# 只保留每 hold 个交易日一次的独立起点
rows = np.arange(260, len(px) - hold, hold)
```

若保留密集面板，使用双向聚类：

```python
from linearmodels.panel import PanelOLS

d = df.loc[m, ["date", "ticker", y]].join(X.loc[m]).set_index(["ticker", "date"])
fit = PanelOLS(d[y], d[X.columns], entity_effects=False, time_effects=False)
res = fit.fit(cov_type="clustered", cluster_entity=True, cluster_time=True)
```

事件研究还应按“事件日 + ticker”双向聚类，或按交易日 block bootstrap。

3. **高｜`tools/put_backtest.py:62-91`｜HV 代替 IV 使“高 HV 卖 put 更好”近似成为模型设定结果，而非实证结论**

权利金由：

```python
sig = np.maximum(hv, iv_floor) * vrp
```

决定；当 HV 更高，模拟 IV 与模拟权利金机械地更高。常数 `VRP=1.10` 假设所有股票、所有时期的 IV/HV 比值相同，忽略财报、跳空、偏度、期限结构、流动性和 bid-ask。

因此，报告中 `HV > 70%` 的同月同 HV 结果 `t=10.25` 不能解释为“真实市场中高 HV 卖 put 更优”。它至多说明：在“IV 恒等于 HV×常数”的模型中，高 HV 的模拟收益更高。

修复方向：必须接入历史期权链的 bid/ask、IV、到期日与 delta；若暂时没有，只能将输出明确标为“模型敏感性分析”，不得作为策略结论。最少应做 VRP 分层敏感性：

```python
for vrp in (0.9, 1.0, 1.1, 1.25, 1.5):
    sim = simulate(px, delta, hold, vrp, slip, rate, iv_floor)
    # 报告各分组结论是否在所有 vrp 下方向一致
```

4. **高｜`tools/smart_money.py:405-445`、`tools/entity_winrate.py:116-123`、`tools/follow_horizon.py:162-163`｜所谓样本外切分没有对 63 日标签做 purge/embargo**

训练样本按事件日的前 60% 切分，但训练事件的 `ex63` 可以使用切分点之后 63 个交易日的价格；测试事件则紧接切分点开始。两侧标签共享大量收益期，测试并不独立。

建议按“标签完成日”切分，并在训练、测试间留出最大预测期限的 embargo：

```python
H = 63
cut_pos = np.searchsorted(px.index.values, np.datetime64(cut), side="right")

d = d.copy()
d["entry_pos"] = np.searchsorted(
    px.index.values, d.event_date.values.astype("datetime64[ns]"), side="right"
)

train = d[d.entry_pos + H < cut_pos]  # 训练标签已在切点前完成
test = d[d.entry_pos >= cut_pos]      # 测试从切点后入场
# 中间 H 天自动剔除
```

`persistence_test()`、`entity_table()`和`horizon_stats()`应统一采用这一规则。

5. **高｜`tools/smart_money.py:272-274`、`tools/put_backtest.py:231-238`｜13F“共识”特征使用整季最终人数，存在信息前视**

代码对同一 `ticker, period` 的全体申报人计数，然后把这个最终人数赋给该季最早披露的事件：

```python
cnt = d.groupby(["ticker", "period"]).entity_id.transform("nunique")
```

以及：

```python
cons = f[cnt >= 20].sort_values("event_date").drop_duplicates(["ticker", "period"])
```

最早披露日不可能知道之后才披露的机构也买入。因此“20 家以上同季买入”不是可交易信号。

应只使用当时已经公开的申报，且将第 N 家披露当天作为信号日：

```python
f = f.sort_values(["ticker", "period", "event_date"]).copy()
f["known_consensus"] = f.groupby(["ticker", "period"]).cumcount() + 1

# 第 20 家公开后才允许入场
cons = (
    f.loc[f["known_consensus"] >= 20]
     .groupby(["ticker", "period"], as_index=False)
     .first()
)
```

6. **高｜`tools/follow_horizon.py:181-183, 226-229`｜OOS 判定使用含测试期的数据作为基准**

`oos_ok` 与 `base_month_win` 比较，但 `base_month_win=base_m` 是全样本（训练+测试）月胜率；这让测试期基准含有自身数据，且在市场状态变化时基准不正确。

应比较纯测试期类别基准：

```python
ent = ent.assign(
    base_month_win_train=base_m_tr,
    base_month_win_test=base_m_te,
)
st["oos_ok"] = (
    st.train_top20
    & (st.test_months >= 2)
    & (st.test_month_win > st.base_month_win_test)
    & (st.test_avg_ex > 0)
)
```

7. **中｜`tools/smart_money.py:218-243`｜OLS 未过滤 NaN、未限制聚类数，聚类 t 值不稳健**

`ols()`默认假定输入无 NaN；调用处不总是显式过滤。聚类时即使只有极少月度簇也照常返回 t 值，有限样本修正不足以解决少簇推断问题。

建议在公共 OLS 函数入口统一过滤，并对少于约 30 个簇的结果标为不可推断或使用 wild-cluster bootstrap：

```python
def ols(y, X, cluster=None):
    y = np.asarray(y, float)
    X = np.asarray(X, float)
    ok = np.isfinite(y) & np.isfinite(X).all(axis=1)
    if cluster is not None:
        cluster = np.asarray(cluster)[ok]
        if len(np.unique(cluster)) < 30:
            return None
    y, X = y[ok], X[ok]
    # 后续保持原计算
```

8. **中｜`tools/smart_money.py:261-313`、`tools/put_backtest.py:171-193`｜大量分组/因子检验未做多重检验校正**

`signal_factors`测试多个头衔、规模、共识、行业等特征；put 回测同时测试趋势、HV、RSI、回撤、组合条件、事件子组和多个 delta。报告直接用 `|t| >= 2` 作为显著标准，错误发现率会很高。

`entity_winrate.py` 虽对实体训练期 p 值做了 BH，但这些 p 值本身仍建立在相关事件独立的二项分布假设上。

至少应输出 BH q 值，并把结论门槛从 t 值改为 q 值：

```python
from scipy.stats import norm

out = pd.DataFrame({"feature": names, "t": r[2]})
out["p"] = 2 * norm.sf(np.abs(out["t"]))
out["q_bh"] = bh_qvalues(out["p"])
out["significant_fdr_10pct"] = out["q_bh"] < 0.10
```

更严谨的做法是预注册少数主假设，其余均标记为探索性结果。

9. **中｜`tools/put_backtest.py:67-70`、`tools/smart_money.py:67-70`｜拆股与缺失价格处理不可靠**

- 日收益绝对值大于 50% 被设为 NaN，无法真正修正未调整拆股；
- `load_prices()`对每只股票前向填充五天；
- 大幅跳空或退市期可能被剔除、平滑或错误处理；
- 无法确认 `close.parquet` 是否为复权收盘价。

这会偏向低估极端损失，尤其对卖 put 最关键。

建议只使用经过拆股、现金分红一致处理的复权价；不要在收益计算前通用 `ffill`：

```python
def load_prices():
    px = pd.read_parquet(_p("prices", "adj_close.parquet"))
    px.index = pd.to_datetime(px.index)
    return px.sort_index()   # 缺失值保留，逐笔收益自然变 NaN
```

若数据源没有复权字段，应暂停给出期权策略绩效结论。

10. **中｜`tools/put_backtest.py:77-87`｜卖 put 的 Delta 反解和 BS 公式正确，但现金担保收益定义不完整**

该式是正确的：

```python
K = S * np.exp(-d1 * sig * np.sqrt(T) + (rate + sig**2 / 2) * T)
```

其中 `d1 = norm.ppf(1-delta)` 对应 put delta 为 `-delta`；BS put 定价也正确。

但 ROC 仅为：

```python
roc = (prem - loss) / K
```

它忽略现金担保 `K` 的无风险利息，且不扣结算、行权、保证金与真实 bid-ask 成本。它可以作为“未计利息的名义担保 ROC”，不能直接同无风险利率或真实策略年化收益比较。

若定义为现金担保总回报：

```python
cash_interest = K * (np.exp(rate * T) - 1)
roc = (prem - loss + cash_interest) / K
```

同时应明确这是简化的欧式、持有到期模型。

11. **中｜`tools/put_backtest.py:135, 209, 393`、`tools/smart_money.py:253-258`、`tools/follow_horizon.py:156-160`｜收益裁剪会改变均值、尾部风险和显著性**

多个地方裁剪收益，例如 `roc.clip(-1, 1)`、超额收益 `[-100%, +150%]`、跟单收益 `[-100%, +300%]`。裁剪不应默默进入主要结论，尤其 CVaR、平均收益和 t 值都会被改写。

建议主结果保留原始、经数据质量验证的收益；裁剪仅作为稳健性列，并明确报告两者：

```python
d["roc_raw"] = d["roc"]
d["roc_winsor"] = d["roc"].clip(d["roc"].quantile(.01), d["roc"].quantile(.99))
# 主表 roc_raw；附录同时报告 roc_winsor
```

12. **中｜`tools/put_backtest.py:216-226`｜内部人“30 天内 >=3 人”被提前去重，可能错误分类**

`attach()`默认按 `ticker,date` 去重，之后才统计 30 天内人数。多个内部人在同一天买同一只股票时，已经只留下任意一条，人数被低估且保留记录不确定。

应先在原始内部人事件上按独立 `entity_id` 计算集群，再附加期权结果：

```python
ins = pd.read_parquet(os.path.join(OUT, "events_insider.parquet"))
ins = ins.sort_values(["ticker", "event_date"])
ins["cluster_n"] = ins.groupby("ticker", group_keys=False).apply(
    lambda g: g.apply(
        lambda r: g.loc[
            g.event_date.between(r.event_date - pd.Timedelta(days=30), r.event_date),
            "entity_id"
        ].nunique(),
        axis=1
    )
)
ins = attach(ins, px, sim, feats, dedupe=True)
```

## 结论可靠性

- **“内部人买入 + MA200 上方卖 put 有超额，t=4.3”**：当前输出确实有该数字：`n=4,062`、同月同 HV 超额约 `+0.49%`、`t=4.28`。但它尚不能作为可靠交易结论：基准股票池有未来选择偏差、事件与基准的流动性条件不一致、持有期收益重叠且标准误错误、并且在多个子组中挑选显著结果而未校正。结论应降级为“待用真实 IV、时点股票池、purged OOS 和双向聚类复核的探索性发现”。

- **“13F / 国会跟单无效”**：方向上，现有样本外持续性结果支持“无法从历史排行榜稳定筛出有效跟单者”。`13F` 的 OOS 横截面 beta 为负且 `t=-2.23`；国会 beta 为负但 `t=-0.22`，后者是“缺乏证据”，不是“已证明无效”。两者仍受标签重叠和切分问题影响，应修复后再下结论。

- **“高 HV / 高 HV 分位卖 put 更好”**：不被当前代码真实支持为市场事实。它主要来自 `IV = HV × 固定 VRP` 的定价设定；没有真实 IV，不能区分风险溢价、事件风险、偏度与模型机械关系。

## Top 5 修复清单（按影响排序）

1. 用历史期权 bid/ask、IV、期限和真实 delta 替换 HV×固定 VRP 模拟；在此之前撤回“高 HV 更好”的交易结论。
2. 改为时点可得的股票池，并对事件和基准统一流动性、价格、交易状态筛选。
3. 对 25/63/126 日标签实施 purge/embargo；所有 OOS 切分以标签完成日为边界。
4. 取消密集重叠建仓，或采用 ticker×date 双向聚类 / block bootstrap；不得再用单月聚类 t 值作为主显著性证据。
5. 修复 13F 共识信号：仅用当时已经公开的申报，达到共识阈值当天才生成可交易信号。