// For tests: what core's savings rules return, captured from core's compiled binding (`databricksSavings`)
// called with the synthetic facts below. It has every finding kind Databricks has, a cluster with no
// auto-termination setting and a warehouse with no size (core sends null for both), and what-if rows for one
// warehouse id in two workspaces. Regenerate by passing the facts, as JSON, to the binding the CLI ships.

/** The `DatabricksSavingsInput` core was given. */
export const DATABRICKS_FACTS = {
  "lookback_days": 7,
  "warehouses": [
    {
      "warehouse_id": "wh-synth-classic",
      "workspace_id": "1001",
      "warehouse_name": "synth_classic",
      "warehouse_type": "CLASSIC",
      "warehouse_size": "SMALL",
      "wall_clock_uptime_sec": 40000,
      "cluster_weighted_uptime_sec": 40000,
      "idle_ratio": 0.95,
      "total_dbu_consumed": 120,
      "total_cost": 66,
      "price_per_dbu": 0.55,
      "serverless_price_per_dbu": 0.7,
      "total_query_count": 3000,
      "parallelism_query_count": 3000,
      "parallelism_ratio_p50": 0.5,
      "parallelism_ratio_p99": 2,
      "parallelism_ratio_max": 3,
      "no_spill_query_pct": 1,
      "no_queue_query_pct": 1
    },
    {
      "warehouse_id": "wh-synth-classic",
      "workspace_id": "1002",
      "warehouse_name": "synth_classic",
      "warehouse_type": "CLASSIC",
      "warehouse_size": "SMALL",
      "wall_clock_uptime_sec": 30000,
      "cluster_weighted_uptime_sec": 30000,
      "idle_ratio": 0.9,
      "total_dbu_consumed": 90,
      "total_cost": 49.5,
      "price_per_dbu": 0.55,
      "serverless_price_per_dbu": 0.7,
      "total_query_count": 2000,
      "parallelism_query_count": 2000,
      "parallelism_ratio_p50": 0.5,
      "parallelism_ratio_p99": 2,
      "parallelism_ratio_max": 3,
      "no_spill_query_pct": 1,
      "no_queue_query_pct": 1
    },
    {
      "warehouse_id": "wh-synth-nosize",
      "workspace_id": "1002",
      "warehouse_name": "synth_nosize",
      "warehouse_type": "PRO",
      "wall_clock_uptime_sec": 20000,
      "cluster_weighted_uptime_sec": 20000,
      "idle_ratio": 0.92,
      "total_dbu_consumed": 60,
      "total_cost": 42,
      "price_per_dbu": 0.7,
      "serverless_price_per_dbu": 0.7,
      "total_query_count": 900,
      "parallelism_query_count": 900,
      "parallelism_ratio_p50": 0.5,
      "parallelism_ratio_p99": 1,
      "parallelism_ratio_max": 2,
      "no_spill_query_pct": 1,
      "no_queue_query_pct": 1
    },
    {
      "warehouse_id": "wh-synth-pro",
      "workspace_id": "1001",
      "warehouse_name": "synth_pro",
      "warehouse_type": "PRO",
      "warehouse_size": "LARGE",
      "wall_clock_uptime_sec": 500000,
      "cluster_weighted_uptime_sec": 500000,
      "idle_ratio": 0.1,
      "total_dbu_consumed": 5000,
      "total_cost": 3500,
      "price_per_dbu": 0.7,
      "total_query_count": 90000,
      "parallelism_query_count": 90000,
      "parallelism_ratio_p50": 1,
      "parallelism_ratio_p99": 4,
      "parallelism_ratio_max": 6,
      "no_spill_query_pct": 1,
      "no_queue_query_pct": 1
    }
  ],
  "clusters": [
    {
      "cluster_id": "cl-synth-idle",
      "workspace_id": "1001",
      "cluster_name": "synth_idle",
      "auto_termination_minutes": 0,
      "total_node_minutes": 20000,
      "active_util_days": 5,
      "total_worker_minutes": 16000,
      "idle_node_minutes": 18000,
      "avg_cpu_active_pct": 3,
      "peak_cpu_active_pct": 10,
      "total_cost": 900
    },
    {
      "cluster_id": "cl-synth-noterm",
      "workspace_id": "1002",
      "cluster_name": "synth_noterm",
      "total_node_minutes": 9000,
      "active_util_days": 4,
      "total_worker_minutes": 8000,
      "idle_node_minutes": 4000,
      "avg_cpu_active_pct": 20,
      "peak_cpu_active_pct": 70,
      "total_cost": 400
    }
  ],
  "jobs": [
    {
      "job_id": "job-synth",
      "workspace_id": "1001",
      "job_name": "synth_job",
      "task_key": "main",
      "trigger_type": "CRON",
      "host_cluster_id": "cl-synth-shared",
      "host_cluster_name": "synth_shared",
      "task_runs": 300,
      "task_hours": 120,
      "host_cluster_cost": 800,
      "host_cluster_dbus": 1200,
      "host_cluster_billed_hours": 200,
      "jobs_rate_per_dbu": 0.15
    },
    {
      "job_id": "job-synth-norate",
      "workspace_id": "1002",
      "job_name": "synth_job_norate",
      "task_key": "main",
      "trigger_type": "PERIODIC",
      "host_cluster_id": "cl-synth-shared2",
      "host_cluster_name": "synth_shared2",
      "task_runs": 50,
      "task_hours": 30,
      "host_cluster_cost": 300,
      "host_cluster_dbus": 400,
      "host_cluster_billed_hours": 60,
      "jobs_rate_per_dbu": null
    }
  ]
} as const

/** Core's `DatabricksSavingsReport` for those facts. */
export const DATABRICKS_REPORT = {
  "findings": [
    {
      "check_id": "wh_oversized",
      "daily_max": 315,
      "daily_min": 180,
      "evidence": {
        "available_cores": 128,
        "current_dbu_per_hour": 40,
        "current_size": "LARGE",
        "kind": "over_sized",
        "no_queue_query_pct": 1,
        "no_spill_query_pct": 1,
        "p99_utilization": 0.03125,
        "parallelism_query_count": 90000,
        "recommended_dbu_per_hour": 4,
        "recommended_size": "2X_SMALL",
        "total_cost": 3500,
        "wasted_cost": 3150
      },
      "monthly_max": 9450,
      "monthly_min": 5400,
      "resource_id": "wh-synth-pro",
      "resource_name": "synth_pro",
      "resource_type": "sql_warehouse",
      "severity": "critical",
      "title": "Over-Sized Warehouse",
      "workspace_id": "1001"
    },
    {
      "check_id": "ap_idle_cluster",
      "daily_max": 77.14285714285715,
      "daily_min": 38.57142857142858,
      "evidence": {
        "active_days": 5,
        "auto_termination_minutes": 0,
        "avg_cpu_active_pct": 3,
        "idle_pattern": "zombie",
        "idle_ratio": 1,
        "kind": "idle_cluster",
        "peak_cpu_active_pct": 10,
        "total_cost": 900,
        "wasted_cost": 900
      },
      "monthly_max": 2314.2857142857147,
      "monthly_min": 1157.1428571428573,
      "resource_id": "cl-synth-idle",
      "resource_name": "synth_idle",
      "resource_type": "cluster",
      "severity": "critical",
      "title": "Idle Cluster Detection",
      "workspace_id": "1001"
    },
    {
      "check_id": "jobs_on_all_purpose_compute",
      "daily_max": 47.83,
      "daily_min": 31.89,
      "evidence": {
        "all_purpose_rate_per_dbu": 0.6666666666666666,
        "estimated_dbus": 720,
        "host_cluster_id": "cl-synth-shared",
        "host_cluster_name": "synth_shared",
        "jobs_rate_estimated": false,
        "jobs_rate_per_dbu": 0.15,
        "kind": "job_on_all_purpose",
        "task_hours": 120,
        "task_runs": 300,
        "trigger_type": "CRON",
        "wasted_cost": 371.99999999999994
      },
      "monthly_max": 1434.8999999999999,
      "monthly_min": 956.7,
      "resource_id": "job-synth",
      "resource_name": "synth_job",
      "resource_type": "job",
      "severity": "medium",
      "title": "Job Running on All-Purpose Compute",
      "workspace_id": "1001"
    },
    {
      "check_id": "ap_idle_cluster",
      "daily_max": 17.142857142857142,
      "daily_min": 8.571428571428571,
      "evidence": {
        "active_days": 4,
        "auto_termination_minutes": null,
        "avg_cpu_active_pct": 20,
        "idle_pattern": "unknown",
        "idle_ratio": 0.5,
        "kind": "idle_cluster",
        "peak_cpu_active_pct": 70,
        "total_cost": 400,
        "wasted_cost": 200
      },
      "monthly_max": 514.2857142857142,
      "monthly_min": 257.1428571428571,
      "resource_id": "cl-synth-noterm",
      "resource_name": "synth_noterm",
      "resource_type": "cluster",
      "severity": "medium",
      "title": "Idle Cluster Detection",
      "workspace_id": "1002"
    },
    {
      "check_id": "wh_classic_pro_to_serverless",
      "daily_max": 8.828571428571427,
      "daily_min": 7.062857142857142,
      "evidence": {
        "current_dbu_cost": 66,
        "idle_ratio": 0.95,
        "kind": "serverless",
        "price_per_dbu": 0.55,
        "projected_serverless_dbu_cost": 4.200000000000004,
        "serverless_price_per_dbu": 0.7,
        "total_query_count": 3000,
        "wall_clock_uptime_hours": 11.11111111111111,
        "warehouse_size": "SMALL",
        "warehouse_type": "CLASSIC",
        "wasted_cost": 61.8
      },
      "monthly_max": 264.85714285714283,
      "monthly_min": 211.88571428571427,
      "resource_id": "wh-synth-classic",
      "resource_name": "synth_classic",
      "resource_type": "sql_warehouse",
      "severity": "critical",
      "title": "Migrate Classic/Pro to Serverless",
      "workspace_id": "1001"
    },
    {
      "check_id": "jobs_on_all_purpose_compute",
      "daily_max": 7.71,
      "daily_min": 5.14,
      "evidence": {
        "all_purpose_rate_per_dbu": 0.75,
        "estimated_dbus": 200,
        "host_cluster_id": "cl-synth-shared2",
        "host_cluster_name": "synth_shared2",
        "jobs_rate_estimated": true,
        "jobs_rate_per_dbu": 0.44999999999999996,
        "kind": "job_on_all_purpose",
        "task_hours": 30,
        "task_runs": 50,
        "trigger_type": "PERIODIC",
        "wasted_cost": 60.000000000000014
      },
      "monthly_max": 231.3,
      "monthly_min": 154.2,
      "resource_id": "job-synth-norate",
      "resource_name": "synth_job_norate",
      "resource_type": "job",
      "severity": "medium",
      "title": "Job Running on All-Purpose Compute",
      "workspace_id": "1002"
    },
    {
      "check_id": "wh_classic_pro_to_serverless",
      "daily_max": 6.171428571428573,
      "daily_min": 4.937142857142859,
      "evidence": {
        "current_dbu_cost": 49.50000000000001,
        "idle_ratio": 0.9,
        "kind": "serverless",
        "price_per_dbu": 0.55,
        "projected_serverless_dbu_cost": 6.299999999999998,
        "serverless_price_per_dbu": 0.7,
        "total_query_count": 2000,
        "wall_clock_uptime_hours": 8.333333333333334,
        "warehouse_size": "SMALL",
        "warehouse_type": "CLASSIC",
        "wasted_cost": 43.20000000000001
      },
      "monthly_max": 185.14285714285717,
      "monthly_min": 148.11428571428576,
      "resource_id": "wh-synth-classic",
      "resource_name": "synth_classic",
      "resource_type": "sql_warehouse",
      "severity": "critical",
      "title": "Migrate Classic/Pro to Serverless",
      "workspace_id": "1002"
    },
    {
      "check_id": "wh_classic_pro_to_serverless",
      "daily_max": 5.5200000000000005,
      "daily_min": 4.416,
      "evidence": {
        "current_dbu_cost": 42,
        "idle_ratio": 0.92,
        "kind": "serverless",
        "price_per_dbu": 0.7,
        "projected_serverless_dbu_cost": 3.3599999999999977,
        "serverless_price_per_dbu": 0.7,
        "total_query_count": 900,
        "wall_clock_uptime_hours": 5.555555555555555,
        "warehouse_size": null,
        "warehouse_type": "PRO",
        "wasted_cost": 38.64
      },
      "monthly_max": 165.60000000000002,
      "monthly_min": 132.48000000000002,
      "resource_id": "wh-synth-nosize",
      "resource_name": "synth_nosize",
      "resource_type": "sql_warehouse",
      "severity": "critical",
      "title": "Migrate Classic/Pro to Serverless",
      "workspace_id": "1002"
    },
    {
      "check_id": "wh_oversized",
      "daily_max": 4.3999999999999995,
      "daily_min": 2.5142857142857142,
      "evidence": {
        "available_cores": 32,
        "current_dbu_per_hour": 12,
        "current_size": "SMALL",
        "kind": "over_sized",
        "no_queue_query_pct": 1,
        "no_spill_query_pct": 1,
        "p99_utilization": 0.0625,
        "parallelism_query_count": 3000,
        "recommended_dbu_per_hour": 4,
        "recommended_size": "2X_SMALL",
        "total_cost": 66,
        "wasted_cost": 44
      },
      "monthly_max": 131.99999999999997,
      "monthly_min": 75.42857142857143,
      "resource_id": "wh-synth-classic",
      "resource_name": "synth_classic",
      "resource_type": "sql_warehouse",
      "severity": "high",
      "title": "Over-Sized Warehouse",
      "workspace_id": "1001"
    },
    {
      "check_id": "wh_oversized",
      "daily_max": 3.3,
      "daily_min": 1.885714285714286,
      "evidence": {
        "available_cores": 32,
        "current_dbu_per_hour": 12,
        "current_size": "SMALL",
        "kind": "over_sized",
        "no_queue_query_pct": 1,
        "no_spill_query_pct": 1,
        "p99_utilization": 0.0625,
        "parallelism_query_count": 2000,
        "recommended_dbu_per_hour": 4,
        "recommended_size": "2X_SMALL",
        "total_cost": 49.5,
        "wasted_cost": 33
      },
      "monthly_max": 99,
      "monthly_min": 56.57142857142858,
      "resource_id": "wh-synth-classic",
      "resource_name": "synth_classic",
      "resource_type": "sql_warehouse",
      "severity": "high",
      "title": "Over-Sized Warehouse",
      "workspace_id": "1002"
    }
  ],
  "lookback_days": 7,
  "total": {
    "monthly_max": 14560.37142857143,
    "monthly_min": 8417.665714285713,
    "resources": 8
  },
  "what_if": [
    {
      "choices": [
        {
          "cores": 0,
          "cores_needed": 4,
          "fits": true,
          "label": "SERVERLESS",
          "monthly_cost": 18.000000000000018,
          "monthly_saving": 264.85714285714283
        },
        {
          "cores": 16,
          "cores_needed": 4,
          "fits": true,
          "label": "X_SMALL",
          "monthly_cost": 141.42857142857142,
          "monthly_saving": 141.42857142857142
        },
        {
          "cores": 8,
          "cores_needed": 4,
          "fits": true,
          "label": "2X_SMALL",
          "monthly_cost": 94.28571428571429,
          "monthly_saving": 188.57142857142856
        }
      ],
      "current_label": "SMALL (CLASSIC)",
      "current_monthly_cost": 282.85714285714283,
      "resource_id": "wh-synth-classic",
      "resource_name": "synth_classic",
      "workspace_id": "1001"
    },
    {
      "choices": [
        {
          "cores": 0,
          "cores_needed": 4,
          "fits": true,
          "label": "SERVERLESS",
          "monthly_cost": 26.999999999999993,
          "monthly_saving": 185.14285714285714
        },
        {
          "cores": 16,
          "cores_needed": 4,
          "fits": true,
          "label": "X_SMALL",
          "monthly_cost": 106.07142857142857,
          "monthly_saving": 106.07142857142857
        },
        {
          "cores": 8,
          "cores_needed": 4,
          "fits": true,
          "label": "2X_SMALL",
          "monthly_cost": 70.71428571428571,
          "monthly_saving": 141.42857142857144
        }
      ],
      "current_label": "SMALL (CLASSIC)",
      "current_monthly_cost": 212.14285714285714,
      "resource_id": "wh-synth-classic",
      "resource_name": "synth_classic",
      "workspace_id": "1002"
    },
    {
      "choices": [
        {
          "cores": 0,
          "cores_needed": 2,
          "fits": true,
          "label": "SERVERLESS",
          "monthly_cost": 14.39999999999999,
          "monthly_saving": 165.60000000000002
        }
      ],
      "current_label": "size unknown (PRO)",
      "current_monthly_cost": 180,
      "resource_id": "wh-synth-nosize",
      "resource_name": "synth_nosize",
      "workspace_id": "1002"
    },
    {
      "choices": [
        {
          "cores": 0,
          "cores_needed": 8,
          "fits": true,
          "label": "SERVERLESS",
          "monthly_cost": 13500,
          "monthly_saving": 1500
        },
        {
          "cores": 64,
          "cores_needed": 8,
          "fits": true,
          "label": "MEDIUM",
          "monthly_cost": 9000,
          "monthly_saving": 6000
        },
        {
          "cores": 32,
          "cores_needed": 8,
          "fits": true,
          "label": "SMALL",
          "monthly_cost": 4500,
          "monthly_saving": 10500
        },
        {
          "cores": 16,
          "cores_needed": 8,
          "fits": true,
          "label": "X_SMALL",
          "monthly_cost": 2250,
          "monthly_saving": 12750
        },
        {
          "cores": 8,
          "cores_needed": 8,
          "fits": true,
          "label": "2X_SMALL",
          "monthly_cost": 1500,
          "monthly_saving": 13500
        }
      ],
      "current_label": "LARGE (PRO)",
      "current_monthly_cost": 15000,
      "resource_id": "wh-synth-pro",
      "resource_name": "synth_pro",
      "workspace_id": "1001"
    }
  ]
} as const
