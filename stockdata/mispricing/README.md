# 定价偏离扫描留痕 (mispricing log)

`mispricing_log_YYYYMMDD.parquet` — 每个**交易日**一个文件，由
`aiagent/tools/mispricing_scan.py` 在当天扫描后写入。

## 为什么要按日存档

这份数据存在的唯一目的，是几个月后回答那个真正重要的问题：

> **Mispricing Score 高的候选，未来实际盈亏是不是真的更好？（扣掉点差与滑点之后）**

所以每一行都必须是**当时**的报价与模型输出，事后不可重算 —— 用今天的数据重算
昨天的 `surface_z`/`fair_value` 会引入前视，整个检验就作废了。

## 字段

| 字段 | 含义 |
|---|---|
| `date` `ticker` `expiry` `strike` `dte` `spot` | 合约与当时的标的价 |
| `bid` `ask` `spread` `oi` `volume` | 当时的可成交报价与流动性 |
| `iv` `delta` | 当时的市场隐含波动率与希腊字母 |
| `surface_iv` `surface_z` | 同到期日 IV 曲面拟合值与稳健 z |
| `term_z` `term_z_rel` | 期限结构 z；`_rel` 已减去当日截面中位数（剔除财报季/FOMC 等共同日历效应） |
| `rv_forecast` `har_r2` | HAR-RV 预测的未来已实现波动与其样本内 R² |
| `vrp` `vrp_x` | IV − 预测RV；`_x` 为当日横截面 z（**不是**时间序列 z） |
| `iv_hv` `event_suspect` | IV/HV20；≥2 标记为疑似未知事件定价 |
| `fair_value` `fair_se` | 块 bootstrap 蒙特卡洛公允价与标准误 |
| `exec_price` `raw_edge` `net_edge` `edge_pct` `edge_x` | 卖方按 **bid** 成交的边际，`net_` 已扣滑点/MC误差/波动预测误差 |
| `score` | 四层加权得分 |
| `earn_before_expiry` `days_to_earnings` | 到期前是否有财报（用真实的下次财报日） |

## 事后评估

```bash
python aiagent/tools/mispricing_scan.py --evaluate
```

对已到期的候选计算卖出该 put 的真实盈亏（`exec_price − max(K − 结算价, 0)`），
按 score 分组对比，并给出相关系数。

**在这张表有统计意义之前，扫描结果只是研究线索，不是交易信号。**
