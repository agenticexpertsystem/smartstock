以下为只读审计结果；未修改任何文件。严重程度按“会系统性制造错误结论/错误数据”为最高。

| 严重程度 | 文件:行号 | 问题 | 修复代码/建议 |
|---|---|---|---|
| 严重 | [datakit.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/datakit.py:588) | `update_house` 的检查点反复将 `old + rows(累计)` 写入文件，但 `old` 未更新、`rows` 未清空；最终还会再写一次。中断/长批次会产生重复 PTR 交易，而 `build_congress_table` 不去重。 | 检查点后更新 `old` 并清空 `rows`，或始终按 `doc_id` 覆盖：`old = pd.concat([old, pd.DataFrame(rows)], ignore_index=True).drop_duplicates(["doc_id","trade_date","ticker","action","amount","description"], keep="last"); old.to_parquet(out,index=False); rows=[]`。 |
| 严重 | [datakit.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/datakit.py:572) | 众议院 PDF 解析异常会被置为 `txs=[]`，但随后仍在 585 行加入 `seen`；该申报永久不再处理。非 OCR 模式下，空解析的电子 PDF 也不会重试。结果是“采集成功但交易为零”的静默漏记。 | 只在解析成功且通过基本校验后标记完成；失败记录单独状态：`if parse_ok: seen.add(rec.DocID) else: failed.add(rec.DocID)`。下一次运行重试 `failed`，并写出 `failed_docs.parquet`/报告缺口。 |
| 严重 | [member_backfill.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/member_backfill.py:199) | “修正申报”去重键没有 `member`、`owner`、`doc_id`、资产名称或期权条款；同日同代码同方向同金额的两笔真实交易会被删掉。后续 203 行更激进地把所有非期权同键记录折叠，尤其会错删夫妻/共同账户、分批成交。 | 不把近似键当 amended 关联。保留 `doc_id` 全量记录，另建立显式 amendment 链；至少使用完整业务键：`["member","owner","trade_date","ticker","asset","instrument","action","amount_low","amount_high","description"]`。只有来源明确给出原申报 ID 时才替换。 |
| 严重 | [member_options.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/member_options.py:122) | `pos_on_or_before()` 可返回 `-1`；历史价格不足、退市或交易早于价格起点时，`iloc[-1]` 会把“今天价格”当买入/到期价格，收益会严重失真且不报错。 | `if p0 < 0 or pd.isna(px.at[px.index[p0], t]): row={"status":"无法估值：买入日价格缺失", ...}; out.append(row); continue`。到期日 `pe` 同样检查。 |
| 高 | [member_options.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/member_options.py:130) | 若申报金额上限小于拆股调整后的内在价值，`np.clip(bs0, floor, hi)` 在 `floor > hi` 时可返回 `hi`，即显式违反“成本不低于内在价值”，却继续计算确定性收益。 | 先校验区间：`floor=max(lo,intrinsic0); if pd.notna(hi) and hi < floor: status="申报金额/拆股/条款不一致，拒绝估值"; continue`。 |
| 高 | [member_options.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/member_options.py:133) | 没有平仓记录时，代码将每张买入 call 强制持有至到期；已行权、提前卖出或转仓都会被错误计为到期 payoff。对已到期期权，既可能低估实际卖在高点的收益，也可能高估实际较早止损后的收益；不能称为“实际收益”。 | 把输出改为 `hypothetical_hold_to_expiry_return`，并按同一标的、合约条款匹配 `Sell/Exercise/Expired` 记录。未匹配时状态应为“持仓状态未知；以下为持有到期情景”。汇总仅统计已匹配退出的仓位，未知仓位单列。 |
| 高 | [member_options.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/member_options.py:126) | 用 HV60×1.1 的 Black–Scholes，再用宽泛 PTR 金额区间裁剪，无法可靠反推实际成交成本，尤其深度实值 LEAPS。深实值 call 的融资/股息/美式提前行权价值、历史 IV 微笑都未建模；金额区间还可能是区间披露而非精确期权权利金。 | 不输出单一 `cost_used` 为主结论。输出上下界和敏感性：`cost_low=max(disclosed_low/in shares, intrinsic)`、`cost_high=disclosed_high/shares`；BS 仅作 `model_price`。有历史期权链时优先使用交易日相邻行权价/到期日的 bid-ask。 |
| 高 | [datakit.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/datakit.py:715) | `update_cusip_map` 无条件采用 OpenFIGI 返回的第一项，未核验 `name` 与 13F `issuer`、证券类别、市场或映射置信度；且已存在 CUSIP 永不复核（688 行）。会造成并长期固化类似 Hess / Hess Midstream 的错误映射。 | 保存候选及验证状态；仅在名称归一化匹配且 `securityType` 合理时自动采用，其余 `ticker=None, status="ambiguous"`。例如：`cand=res.get("data",[]); cand=[x for x in cand if name_score(x["name"],issuer)>=0.9]; chosen=cand[0] if len(cand)==1 else None`。加入 `source/issuer_verified/updated` 并定期重验。 |
| 高 | [fund_13f.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/fund_13f.py:138) | 13F 单位判定使用全组合 `value/shares` 中位数 `< $3` 的启发式。合法低价股、ADR、小盘股或异常持仓结构都可能被整体放大 1,000 倍；反过来，现代美元单位文件也不应靠价格阈值猜测。 | 基于 SEC 数据集版本/申报 schema 的明确单位规则，而非组合价格。保留 `value_raw`、`value_unit`、`value_usd`、`unit_inference`；不确定时不进入金额权重和组合回测。 |
| 高 | [datakit.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/datakit.py:361) | 13F 修正申报处理把所有非 `NEW HOLDINGS` amendment 按最晚提交版本替代原表，但没有区分 amendment 类型、也没有保留“首次可知日期”。`NEW HOLDINGS` 的合并逻辑也会把原/修正/补充的语义混在一起。 | 为每个 `(cik, period)` 建立 filing lineage：原始、RESTATEMENT、NEW HOLDINGS 分别保存；分析默认选择最终有效版本，但回测入场日使用该版本实际公开日，并显式标注“事后修正，不可用于当时跟单”。 |
| 中 | [fund_13f.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/fund_13f.py:357) | 退市/并购股票使用持有期最后一个有效价格近似退出价。该价格可能是停牌前价格，不是现金并购对价；报告只在代码注释中说明，用户看到的 clone return 会被当事实。 | 交易期末无价格时将该标的排除并降低 `value_coverage`，或接入 corporate-action 对价；结果中增加 `terminal_price_date`、`stale_days`、`missing_exit_value`，超过阈值不计算该期收益。 |
| 中 | [datakit.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/datakit.py:529) / [datakit.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/datakit.py:607) | House/Senate 请求基本无重试；House 失败直接 `continue`，Senate 的 CSRF、JSON、HTML 结构解析未保护。部分下载/解析失败会造成不完整数据，且没有完成率、失败清单或阻断报告生成。 | 复用 `SecSession` 风格的带指数退避 session；每次运行保存 `requested/succeeded/failed/zero_rows`。若失败数非零，退出码非零或在所有报告页顶部显示数据不完整。 |
| 中 | [member_backfill.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/member_backfill.py:61) | 2020–2023 PTR 解析依赖 `pdfplumber.extract_text()` 的视觉行序和单一 `MAIN_RE`。交易行若发生日期/金额/动作码换行，或资产行被拆到前一行，就不会开启 `cur`，会直接漏记；无页数、原始行数、预期交易数的对账。 | 以坐标表格/列位置解析，或做状态机兼容“日期、金额、动作独立换行”。每份 PDF 输出 `parsed_rows`、`unmatched_candidate_lines`、页码；出现候选交易行但解析为零时标为失败，不可标完成。 |
| 中 | [option_snapshot.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/option_snapshot.py:116) | 缺 bid 或 ask 时把缺失值填 0 后计算 mid，会产生“半个 ask/半个 bid”的伪报价；随后年化收益、IV/HV 排序可能误导。 | `ch["mid"]=np.where(ch.bid.gt(0)&ch.ask.gt(0),(ch.bid+ch.ask)/2,np.nan)`；策略候选必须要求双边报价、时间戳、新鲜度和最低 OI。 |
| 中 | [member_trades.py](C:/Users/ldpat/projects/stocktrading/aiagent/tools/member_trades.py:148) | 同一申报、ticker、方向被压成一个信号，忽略不同交易日、账户及股票与期权两种工具；注释说“分两天买”也合并，导致统计样本数和收益观测被任意删除。 | 若目的是“文档级信号”，单独构建 `signal_id`，保留所有腿及金额；若目的是逐笔统计，不能 `drop_duplicates`。报告同时给出 `filing signals` 与 `transaction legs`。 |

报告呈现结论：

- `member_options.py` 已说明 BS 成本为“估计”，这是正确方向；但汇总仍以 `win_rate`、`portfolio_return`、`pnl_usd_est` 的确定数值展示，且没有把“未找到退出记录”与“已验证到期/行权”分开，容易被视为事实。
- `fund_13f.py` 将退市/并购的“最后可用价格”写在代码注释而非 HTML 报告；应在每期组合收益和明细中展示覆盖率、缺失估值金额、陈旧价格天数。
- House、Senate、旧 PTR 回填、期权快照均缺“本次应抓取/成功/失败/零交易/未解析”的数据质量摘要。没有这个摘要时，空结果不能与“确无交易”区分。
- 价格源对退市代码缺失时应保留 NaN，不应把旧价前填或默认为零/持有到期；所有收益统计应报告有效样本数与金额覆盖率。

Top 5：

1. House 检查点重复写入，直接污染交易和后续统计。
2. House 解析失败仍标记完成，造成永久静默漏记。
3. PTR/amended 的近似去重会删除真实的不同交易。
4. 期权在历史价格缺失时使用 `iloc[-1]`，可把当前价格错当历史价格。
5. CUSIP 映射盲取 OpenFIGI 首项且永不复核，可能把错误标的持续传递到价格、收益和 13F 分析。