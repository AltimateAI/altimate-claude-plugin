// What `altimate tool run finops_snowflake_savings --json` answered on Altimate's own Snowflake account, for
// the seven days to 2026-11-18, with warehouse names that could identify people or projects replaced and
// the tool's text output shortened. The tests read it so the pane is held to the tool's real answer.
export const SNOWFLAKE_CAPTURE = {
 "status": "ok",
 "title": "Snowflake Savings: $342–$489 a month on 7 warehouses",
 "output": "Snowflake savings: 69 warehouses checked",
 "metadata": {
  "success": true,
  "window": {
   "start": "2026-11-11",
   "end": "2026-11-18"
  },
  "warehouse": "snowflake",
  "ran_on": "ALTIMATE_WH",
  "warehouses_checked": 69,
  "price": {
   "per_credit": 3,
   "source": "rate_sheet",
   "as_of": "2026-08-05"
  },
  "skipped": [],
  "limited": [],
  "warehouses": [
   {
    "id": "6163",
    "name": "ALTIMATE_METRICS_WH",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0.48906166500000003
   },
   {
    "id": "107",
    "name": "ALTIMATE_WH",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0.0024208350000000005
   },
   {
    "id": "1",
    "name": "COMPUTE_WH",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 12.519939225000002
   },
   {
    "id": "3003",
    "name": "DBT_INTEGRATION_TEST_WH",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 72.86214285300001
   },
   {
    "id": "2863",
    "name": "NATIVE_APP_WH",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 45.75015684899999
   },
   {
    "id": "2240",
    "name": "SA_WH",
    "type": "STANDARD",
    "size": "Medium",
    "window_cost": 18.763462368000003
   },
   {
    "id": "6223",
    "name": "TELEMETRY_DASHBOARD_WH",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 1.551656667
   },
   {
    "id": "2323",
    "name": "TEST_WH_A",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0.070725
   },
   {
    "id": "WAREHOUSE_01",
    "name": "WAREHOUSE_01",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_02",
    "name": "WAREHOUSE_02",
    "type": "STANDARD",
    "size": "Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_03",
    "name": "WAREHOUSE_03",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_04",
    "name": "WAREHOUSE_04",
    "type": "STANDARD",
    "size": "Large",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_05",
    "name": "WAREHOUSE_05",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_06",
    "name": "WAREHOUSE_06",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_07",
    "name": "WAREHOUSE_07",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_08",
    "name": "WAREHOUSE_08",
    "type": "STANDARD",
    "size": "Medium",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_09",
    "name": "WAREHOUSE_09",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_10",
    "name": "WAREHOUSE_10",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_11",
    "name": "WAREHOUSE_11",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_12",
    "name": "WAREHOUSE_12",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_13",
    "name": "WAREHOUSE_13",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_14",
    "name": "WAREHOUSE_14",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_15",
    "name": "WAREHOUSE_15",
    "type": "STANDARD",
    "size": "Medium",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_16",
    "name": "WAREHOUSE_16",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_17",
    "name": "WAREHOUSE_17",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_18",
    "name": "WAREHOUSE_18",
    "type": "STANDARD",
    "size": "X-Large",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_19",
    "name": "WAREHOUSE_19",
    "type": "STANDARD",
    "size": "Large",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_20",
    "name": "WAREHOUSE_20",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_21",
    "name": "WAREHOUSE_21",
    "type": "STANDARD",
    "size": "Large",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_22",
    "name": "WAREHOUSE_22",
    "type": "STANDARD",
    "size": "Medium",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_23",
    "name": "WAREHOUSE_23",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_24",
    "name": "WAREHOUSE_24",
    "type": "STANDARD",
    "size": "Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_25",
    "name": "WAREHOUSE_25",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_26",
    "name": "WAREHOUSE_26",
    "type": "STANDARD",
    "size": "Medium",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_27",
    "name": "WAREHOUSE_27",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_28",
    "name": "WAREHOUSE_28",
    "type": "STANDARD",
    "size": "Medium",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_29",
    "name": "WAREHOUSE_29",
    "type": "STANDARD",
    "size": "Medium",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_30",
    "name": "WAREHOUSE_30",
    "type": "STANDARD",
    "size": "Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_31",
    "name": "WAREHOUSE_31",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_32",
    "name": "WAREHOUSE_32",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_33",
    "name": "WAREHOUSE_33",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_34",
    "name": "WAREHOUSE_34",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_35",
    "name": "WAREHOUSE_35",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_36",
    "name": "WAREHOUSE_36",
    "type": "STANDARD",
    "size": "Medium",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_37",
    "name": "WAREHOUSE_37",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_38",
    "name": "WAREHOUSE_38",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_39",
    "name": "WAREHOUSE_39",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_40",
    "name": "WAREHOUSE_40",
    "type": "STANDARD",
    "size": "X-Large",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_41",
    "name": "WAREHOUSE_41",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_42",
    "name": "WAREHOUSE_42",
    "type": "STANDARD",
    "size": "Medium",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_43",
    "name": "WAREHOUSE_43",
    "type": "STANDARD",
    "size": "Medium",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_44",
    "name": "WAREHOUSE_44",
    "type": "STANDARD",
    "size": "Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_45",
    "name": "WAREHOUSE_45",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_46",
    "name": "WAREHOUSE_46",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_47",
    "name": "WAREHOUSE_47",
    "type": "STANDARD",
    "size": "Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_48",
    "name": "WAREHOUSE_48",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_49",
    "name": "WAREHOUSE_49",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_50",
    "name": "WAREHOUSE_50",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_51",
    "name": "WAREHOUSE_51",
    "type": "STANDARD",
    "size": "Large",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_52",
    "name": "WAREHOUSE_52",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_53",
    "name": "WAREHOUSE_53",
    "type": "STANDARD",
    "size": "Medium",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_54",
    "name": "WAREHOUSE_54",
    "type": "STANDARD",
    "size": "Medium",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_55",
    "name": "WAREHOUSE_55",
    "type": "STANDARD",
    "size": "Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_56",
    "name": "WAREHOUSE_56",
    "type": "STANDARD",
    "size": "Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_57",
    "name": "WAREHOUSE_57",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_58",
    "name": "WAREHOUSE_58",
    "type": "STANDARD",
    "size": "X-Small",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_59",
    "name": "WAREHOUSE_59",
    "type": "STANDARD",
    "size": "X-Large",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_60",
    "name": "WAREHOUSE_60",
    "type": "STANDARD",
    "size": "X-Large",
    "window_cost": 0
   },
   {
    "id": "WAREHOUSE_61",
    "name": "WAREHOUSE_61",
    "type": "STANDARD",
    "size": "X-Large",
    "window_cost": 0
   }
  ],
  "report": {
   "findings": [
    {
     "check_id": "high_idle_time",
     "daily_max": 9.378225778643243,
     "daily_min": 6.56475804505027,
     "evidence": {
      "active_seconds": 48628,
      "credits_used": 24.287380951000003,
      "flagged_days": [
       "2026-11-11",
       "2026-11-12",
       "2026-11-13",
       "2026-11-16",
       "2026-11-17"
      ],
      "idle_ratio": 0.9009624084889364,
      "idle_seconds": 43812,
      "kind": "high_idle_time",
      "price_per_credit": 3,
      "wasted_cost": 65.6475804505027
     },
     "monthly_max": 281.3467733592973,
     "monthly_min": 196.9427413515081,
     "resource_id": "3003",
     "resource_name": "DBT_INTEGRATION_TEST_WH",
     "resource_type": "sql_warehouse",
     "severity": "critical",
     "title": "High Idle Time",
     "workspace_id": null
    },
    {
     "check_id": "high_idle_time",
     "daily_max": 4.294229484507595,
     "daily_min": 3.005960639155316,
     "evidence": {
      "active_seconds": 26807,
      "credits_used": 15.294370331999998,
      "flagged_days": [
       "2026-11-11",
       "2026-11-12",
       "2026-11-13",
       "2026-11-14",
       "2026-11-15",
       "2026-11-16",
       "2026-11-17"
      ],
      "idle_ratio": 0.6562465027791249,
      "idle_seconds": 17592,
      "kind": "high_idle_time",
      "price_per_credit": 3,
      "wasted_cost": 30.05960639155316
     },
     "monthly_max": 128.82688453522783,
     "monthly_min": 90.17881917465948,
     "resource_id": "2863",
     "resource_name": "NATIVE_APP_WH",
     "resource_type": "sql_warehouse",
     "severity": "high",
     "title": "High Idle Time",
     "workspace_id": null
    },
    {
     "check_id": "high_idle_time",
     "daily_max": 1.3474941117907626,
     "daily_min": 0.9432458782535338,
     "evidence": {
      "active_seconds": 4787,
      "credits_used": 6.327360788,
      "flagged_days": [
       "2026-11-11",
       "2026-11-12",
       "2026-11-13",
       "2026-11-14",
       "2026-11-15",
       "2026-11-16",
       "2026-11-17"
      ],
      "idle_ratio": 0.4973887612283267,
      "idle_seconds": 2381,
      "kind": "high_idle_time",
      "price_per_credit": 3,
      "wasted_cost": 9.432458782535338
     },
     "monthly_max": 40.42482335372288,
     "monthly_min": 28.297376347606015,
     "resource_id": "2240",
     "resource_name": "SA_WH",
     "resource_type": "sql_warehouse",
     "severity": "medium",
     "title": "High Idle Time",
     "workspace_id": null
    },
    {
     "check_id": "high_idle_time",
     "daily_max": 1.014339786828464,
     "daily_min": 0.7100378507799248,
     "evidence": {
      "active_seconds": 4521,
      "credits_used": 4.178750297,
      "flagged_days": [
       "2026-11-11",
       "2026-11-12",
       "2026-11-13",
       "2026-11-14",
       "2026-11-15",
       "2026-11-16",
       "2026-11-17"
      ],
      "idle_ratio": 0.5857111258571113,
      "idle_seconds": 2648,
      "kind": "high_idle_time",
      "price_per_credit": 3,
      "wasted_cost": 7.100378507799249
     },
     "monthly_max": 30.430193604853923,
     "monthly_min": 21.301135523397743,
     "resource_id": "1",
     "resource_name": "COMPUTE_WH",
     "resource_type": "sql_warehouse",
     "severity": "medium",
     "title": "High Idle Time",
     "workspace_id": null
    },
    {
     "check_id": "frequent_restart_overcharge",
     "daily_max": 0.4385714285714286,
     "daily_min": 0.2928571428571428,
     "evidence": {
      "bounces": 180,
      "credits_per_hour": 1,
      "double_billed_seconds": 2456,
      "flagged_days": [
       "2026-11-11",
       "2026-11-12",
       "2026-11-13",
       "2026-11-16",
       "2026-11-17"
      ],
      "kind": "frequent_restart",
      "price_per_credit": 3
     },
     "monthly_max": 13.157142857142858,
     "monthly_min": 8.785714285714285,
     "resource_id": "3003",
     "resource_name": "DBT_INTEGRATION_TEST_WH",
     "resource_type": "sql_warehouse",
     "severity": "low",
     "title": "Frequent Restart Overcharge",
     "workspace_id": null
    },
    {
     "check_id": "high_idle_time",
     "daily_max": 0.18161862307328921,
     "daily_min": 0.12713303615130245,
     "evidence": {
      "active_seconds": 1185,
      "credits_used": 0.450380554,
      "flagged_days": [
       "2026-11-11",
       "2026-11-12",
       "2026-11-13",
       "2026-11-14",
       "2026-11-17"
      ],
      "idle_ratio": 0.9409282700421941,
      "idle_seconds": 1115,
      "kind": "high_idle_time",
      "price_per_credit": 3,
      "wasted_cost": 1.2713303615130245
     },
     "monthly_max": 5.448558692198676,
     "monthly_min": 3.813991084539073,
     "resource_id": "6223",
     "resource_name": "TELEMETRY_DASHBOARD_WH",
     "resource_type": "sql_warehouse",
     "severity": "critical",
     "title": "High Idle Time",
     "workspace_id": null
    },
    {
     "check_id": "downsize_warehouse",
     "daily_max": 0.1646368156714286,
     "daily_min": 0.09878208940285715,
     "evidence": {
      "cost_basis": 2.3049154194000003,
      "current_size": "Medium",
      "kind": "downsize_warehouse",
      "price_per_credit": 3,
      "query_count": 2001,
      "recommended_size": "Small",
      "short_period_percent": null,
      "sub_five_second_percent": 96.45177411294353
     },
     "monthly_max": 4.939104470142858,
     "monthly_min": 2.963462682085715,
     "resource_id": "2240",
     "resource_name": "SA_WH",
     "resource_type": "sql_warehouse",
     "severity": "medium",
     "title": "Downsize Warehouse",
     "workspace_id": null
    },
    {
     "check_id": "high_idle_time",
     "daily_max": 0.0685693842281775,
     "daily_min": 0.04799856895972425,
     "evidence": {
      "active_seconds": 431,
      "credits_used": 0.163020555,
      "flagged_days": [
       "2026-11-11",
       "2026-11-12",
       "2026-11-13",
       "2026-11-14",
       "2026-11-15",
       "2026-11-16",
       "2026-11-17"
      ],
      "idle_ratio": 0.9814385150812065,
      "idle_seconds": 423,
      "kind": "high_idle_time",
      "price_per_credit": 3,
      "wasted_cost": 0.4799856895972425
     },
     "monthly_max": 2.057081526845325,
     "monthly_min": 1.4399570687917276,
     "resource_id": "6163",
     "resource_name": "ALTIMATE_METRICS_WH",
     "resource_type": "sql_warehouse",
     "severity": "critical",
     "title": "High Idle Time",
     "workspace_id": null
    },
    {
     "check_id": "high_idle_time",
     "daily_max": 0.009907259859484777,
     "daily_min": 0.006935081901639343,
     "evidence": {
      "active_seconds": 61,
      "credits_used": 0.023502222,
      "flagged_days": [
       "2026-11-12"
      ],
      "idle_ratio": 0.9836065573770492,
      "idle_seconds": 60,
      "kind": "high_idle_time",
      "price_per_credit": 3,
      "wasted_cost": 0.06935081901639344
     },
     "monthly_max": 0.2972177957845433,
     "monthly_min": 0.2080524570491803,
     "resource_id": "2323",
     "resource_name": "TEST_WH_A",
     "resource_type": "sql_warehouse",
     "severity": "critical",
     "title": "High Idle Time",
     "workspace_id": null
    }
   ],
   "lookback_days": 7,
   "price_per_credit": 3,
   "total": {
    "monthly_max": 488.83153286793043,
    "monthly_min": 342.1820730075513,
    "resources": 7
   },
   "what_if": []
  },
  "truncated": false
 }
}
