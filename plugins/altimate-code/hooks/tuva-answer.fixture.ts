// A real impact_analysis answer, from the Tuva project (tuva-health/tuva, Apache-2.0) at its manifest: core__medical_claim's
// paid_amount, traced downstream. The model-level answer and the model's SQL come from the same project.
// Kept as altimate-code gave them, less the model-level lists the band does not read (downstream, column_reach, findings).

export const TUVA_MEDICAL_CLAIM_SQL = "{{ config(\n     enabled = the_tuva_project.tuva_boolean_var('claims_enabled', false)\n   )\n}}\n\n{%- set tuva_core_columns -%}\n      med.medical_claim_id\n    , med.claim_id\n    , med.claim_line_number\n    , cast(x.encounter_id as {{ dbt.type_string() }}) as encounter_id\n    , cast(x.encounter_type as {{ dbt.type_string() }}) as encounter_type\n    , cast(x.encounter_group as {{ dbt.type_string() }}) as encounter_group\n    , med.claim_type\n    , med.person_id\n    , med.member_id\n    , med.payer\n    , med.{{ quote_column('plan') }}\n    , med.claim_start_date\n    , med.claim_end_date\n    , med.claim_line_start_date\n    , med.claim_line_end_date\n    , med.admission_date\n    , med.discharge_date\n    , cast(srv_group.service_category_1 as {{ dbt.type_string() }}) as service_category_1\n    , cast(srv_group.service_category_2 as {{ dbt.type_string() }}) as service_category_2\n    , cast(srv_group.service_category_3 as {{ dbt.type_string() }}) as service_category_3\n    , med.admit_source_code\n    , med.admit_source_description\n    , med.admit_type_code\n    , med.admit_type_description\n    , med.discharge_disposition_code\n    , med.discharge_disposition_description\n    , med.place_of_service_code\n    , med.place_of_service_description\n    , med.bill_type_code\n    , med.bill_type_description\n    , med.drg_code_type\n    , med.drg_code\n    , med.drg_description\n    , med.revenue_center_code\n    , med.revenue_center_description\n    , med.service_unit_quantity\n    , med.hcpcs_code\n    , med.hcpcs_modifier_1\n    , med.hcpcs_modifier_2\n    , med.hcpcs_modifier_3\n    , med.hcpcs_modifier_4\n    , med.hcpcs_modifier_5\n    , med.rendering_npi\n    , med.rendering_tin\n    , med.rendering_name\n    , med.billing_npi\n    , med.billing_tin\n    , med.billing_name\n    , med.facility_npi\n    , med.facility_name\n    , med.paid_date\n    , med.paid_amount\n    , med.allowed_amount\n    , med.charge_amount\n    , med.coinsurance_amount\n    , med.copayment_amount\n    , med.deductible_amount\n    , med.total_cost_amount\n    , med.in_network_flag\n    , cast(\n        case\n            when enroll.claim_id is not null then 1\n            else 0\n        end as {{ dbt.type_int() }}\n      ) as enrollment_flag\n    , cast(enroll.member_month_id as {{ dbt.type_string() }}) as member_month_id\n{%- endset -%}\n\n{%- set tuva_extension_columns -%}\n    {{ select_extension_columns(ref('normalized__medical_claim'), alias='med') }}\n{%- endset -%}\n\n{%- set tuva_metadata_columns -%}\n    , med.file_date\n    , med.ingest_datetime\n    , med.file_name\n    , cast('{{ var('tuva_last_run') }}' as {{ dbt.type_timestamp() }}) as tuva_last_run\n    , med.data_source\n{%- endset %}\n\nwith all_encounters as (\n    select\n        claim_id\n        , claim_line_number\n        , data_source\n        , encounter_id\n        , encounter_type\n        , encounter_group\n    from {{ ref('encounters__combined_claim_line_crosswalk') }}\n    where claim_line_attribution_number = 1\n\n    union all\n\n    select\n        claim_id\n        , claim_line_number\n        , data_source\n        , encounter_id\n        , encounter_type\n        , encounter_group\n    from {{ ref('encounters__orphaned_claims') }}\n)\n\nselect\n    {{ tuva_core_columns }}\n    {{ tuva_extension_columns }}\n    {{ tuva_metadata_columns }}\nfrom {{ ref('normalized__medical_claim') }} as med\ninner join {{ ref('service_category__service_category_grouper') }} as srv_group\n    on med.claim_id = srv_group.claim_id\n    and med.claim_line_number = srv_group.claim_line_number\n    and med.data_source = srv_group.data_source\n    and srv_group.duplicate_row_number = 1\ninner join all_encounters as x\n    on med.claim_id = x.claim_id\n    and med.claim_line_number = x.claim_line_number\n    and med.data_source = x.data_source\nleft outer join {{ ref('claims_enrollment__flag_claims_with_enrollment') }} as enroll\n    on med.claim_id = enroll.claim_id\n    and med.claim_line_number = enroll.claim_line_number\n    and med.person_id = enroll.person_id\n    and med.payer = enroll.payer\n    and med.{{ quote_column('plan') }} = enroll.{{ quote_column('plan') }}\n    and med.data_source = enroll.data_source\n"

export const TUVA_MODEL_LEVEL = { success: true, severity: 'HIGH', direct_count: 8, transitive_count: 89, test_count: 91 }

export const TUVA_PAID_AMOUNT = {
 "success": true,
 "severity": "HIGH",
 "direct_count": 8,
 "transitive_count": 89,
 "test_count": 91,
 "column_reader_count": 12,
 "has_schema": false,
 "model": "core__medical_claim",
 "column": "paid_amount",
 "change_type": "modify",
 "exposures": [],
 "exposures_declared": 0,
 "column_answer": {
  "version": 1,
  "focus": {
   "model": "model.the_tuva_project.core__medical_claim",
   "column": "paid_amount"
  },
  "direction": "downstream",
  "inputs": {
   "manifest": {
    "generated_at": "2026-11-20T15:08:19.765926Z",
    "older_than_sql": true
   },
   "sql": "compiled_code",
   "catalog": null,
   "engine": "altimate-core 0.9.0",
   "workarounds": [
    "relations keyed database.schema.name",
    "ephemeral parents expanded",
    "parent columns = documented + own lineage targets + SELECT list",
    "aggregate FILTER clause dropped before analysis",
    "WITH nested inside a CTE reported unresolved",
    "reads with zero traced columns reported unresolved"
   ]
  },
  "counts": {
   "columns": 124,
   "models": 13,
   "hops": 5,
   "contracts": 0,
   "ends": 44,
   "may_carry_models": 84,
   "not_traced_models": 31,
   "model_level": 97
  },
  "nodes": [
   {
    "id": "model.the_tuva_project.core__medical_claim",
    "name": "core__medical_claim",
    "folder": "core/final",
    "materialized": "table",
    "contract": false,
    "tests": 10,
    "exposures": []
   },
   {
    "id": "model.semantic_layer.semantic_layer__stg_core__medical_claim",
    "name": "semantic_layer__stg_core__medical_claim",
    "folder": "semantic_layer/staging",
    "materialized": "ephemeral",
    "contract": false,
    "tests": 1,
    "exposures": []
   },
   {
    "id": "model.the_tuva_project.int_cost_service_categories",
    "name": "int_cost_service_categories",
    "folder": "core/intermediate",
    "materialized": "table",
    "contract": false,
    "tests": 0,
    "exposures": []
   },
   {
    "id": "model.fhir_preprocessing.fhir_preprocessing__stg_core__medical_claim",
    "name": "fhir_preprocessing__stg_core__medical_claim",
    "folder": "fhir_preprocessing/staging",
    "materialized": "view",
    "contract": false,
    "tests": 0,
    "exposures": []
   },
   {
    "id": "model.semantic_layer.semantic_layer__fact_claims",
    "name": "semantic_layer__fact_claims",
    "folder": "semantic_layer/final",
    "materialized": "table",
    "contract": false,
    "tests": 5,
    "exposures": []
   },
   {
    "id": "model.the_tuva_project.int_cost_service_category_2_paid_pivot",
    "name": "int_cost_service_category_2_paid_pivot",
    "folder": "core/intermediate",
    "materialized": "table",
    "contract": false,
    "tests": 0,
    "exposures": []
   },
   {
    "id": "model.the_tuva_project.int_cost_service_category_1_paid_pivot",
    "name": "int_cost_service_category_1_paid_pivot",
    "folder": "core/intermediate",
    "materialized": "table",
    "contract": false,
    "tests": 0,
    "exposures": []
   },
   {
    "id": "model.fhir_preprocessing.fhir_preprocessing__int_medical_claim_total",
    "name": "fhir_preprocessing__int_medical_claim_total",
    "folder": "fhir_preprocessing/intermediate",
    "materialized": "table",
    "contract": false,
    "tests": 0,
    "exposures": []
   },
   {
    "id": "model.fhir_preprocessing.fhir_preprocessing__int_medical_claim_item_adjudication",
    "name": "fhir_preprocessing__int_medical_claim_item_adjudication",
    "folder": "fhir_preprocessing/intermediate",
    "materialized": "table",
    "contract": false,
    "tests": 0,
    "exposures": []
   },
   {
    "id": "model.the_tuva_project.core__cost",
    "name": "core__cost",
    "folder": "core/final",
    "materialized": "table",
    "contract": false,
    "tests": 4,
    "exposures": []
   },
   {
    "id": "model.fhir_preprocessing.fhir_preprocessing__int_medical_claim_eob",
    "name": "fhir_preprocessing__int_medical_claim_eob",
    "folder": "fhir_preprocessing/intermediate",
    "materialized": "table",
    "contract": false,
    "tests": 0,
    "exposures": []
   },
   {
    "id": "model.fhir_preprocessing.fhir_preprocessing__int_medical_claim_item",
    "name": "fhir_preprocessing__int_medical_claim_item",
    "folder": "fhir_preprocessing/intermediate",
    "materialized": "table",
    "contract": false,
    "tests": 0,
    "exposures": []
   },
   {
    "id": "model.semantic_layer.semantic_layer__stg_core__cost",
    "name": "semantic_layer__stg_core__cost",
    "folder": "semantic_layer/staging",
    "materialized": "ephemeral",
    "contract": false,
    "tests": 0,
    "exposures": []
   },
   {
    "id": "model.fhir_preprocessing.fhir_preprocessing__explanation_of_benefit",
    "name": "fhir_preprocessing__explanation_of_benefit",
    "folder": "fhir_preprocessing/final",
    "materialized": "table",
    "contract": false,
    "tests": 2,
    "exposures": []
   },
   {
    "id": "model.semantic_layer.semantic_layer__fact_member_months",
    "name": "semantic_layer__fact_member_months",
    "folder": "semantic_layer/final",
    "materialized": "table",
    "contract": false,
    "tests": 3,
    "exposures": []
   }
  ],
  "columns": [
   {
    "model": 0,
    "column": "paid_amount",
    "hop": 0,
    "end": false,
    "how": null,
    "how_from": null
   },
   {
    "model": 1,
    "column": "paid_amount",
    "hop": 1,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 2,
    "column": "total_paid",
    "hop": 1,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 3,
    "column": "paid_amount",
    "hop": 1,
    "end": false,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 4,
    "column": "paid_amount",
    "hop": 1,
    "end": true,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 5,
    "column": "acute_inpatient_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "ambulance_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "ambulatory_surgery_center_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "dialysis_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "durable_medical_equipment_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "emergency_department_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "home_health_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "inpatient_hospice_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "inpatient_long_term_acute_care_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "inpatient_psychiatric_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "inpatient_rehabilitation_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "inpatient_substance_use_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "lab_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "observation_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "office_based_other_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "office_based_ptotst_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "office_based_radiology_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "office_based_surgery_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "office_based_visit_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "other_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "outpatient_hospice_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "outpatient_hospital_or_clinic_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "outpatient_psychiatric_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "outpatient_ptotst_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "outpatient_radiology_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "outpatient_rehabilitation_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "outpatient_substance_use_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "outpatient_surgery_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "pharmacy_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "skilled_nursing_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "telehealth_visit_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 5,
    "column": "urgent_care_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 6,
    "column": "ancillary_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 6,
    "column": "inpatient_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 6,
    "column": "office_based_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 6,
    "column": "other_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 6,
    "column": "outpatient_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 6,
    "column": "pharmacy_paid",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 7,
    "column": "eob_total_list",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 8,
    "column": "eob_item_adjudication_list",
    "hop": 2,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 9,
    "column": "acute_inpatient_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "ambulance_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "ambulatory_surgery_center_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "dialysis_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "durable_medical_equipment_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "emergency_department_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "home_health_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "inpatient_hospice_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "inpatient_long_term_acute_care_paid",
    "hop": 3,
    "end": true,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "inpatient_psychiatric_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "inpatient_rehabilitation_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "inpatient_substance_use_paid",
    "hop": 3,
    "end": true,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "lab_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "observation_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "office_based_other_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "office_based_pt_ot_st_paid",
    "hop": 3,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 9,
    "column": "office_based_radiology_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "office_based_surgery_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "office_based_visit_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "other_paid_2",
    "hop": 3,
    "end": true,
    "how": "?",
    "how_from": null
   },
   {
    "model": 9,
    "column": "outpatient_hospice_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "outpatient_hospital_or_clinic_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "outpatient_psychiatric_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "outpatient_pt_ot_st_paid",
    "hop": 3,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 9,
    "column": "outpatient_radiology_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "outpatient_rehabilitation_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "outpatient_substance_use_paid",
    "hop": 3,
    "end": true,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "outpatient_surgery_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "pharmacy_paid_2",
    "hop": 3,
    "end": true,
    "how": "?",
    "how_from": null
   },
   {
    "model": 9,
    "column": "skilled_nursing_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "telehealth_visit_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "urgent_care_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "ancillary_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "medical_paid",
    "hop": 3,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 9,
    "column": "total_paid",
    "hop": 3,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 9,
    "column": "inpatient_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "office_based_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "other_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "outpatient_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 9,
    "column": "pharmacy_paid",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 10,
    "column": "eob_total_list",
    "hop": 3,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 11,
    "column": "eob_item_list",
    "hop": 3,
    "end": false,
    "how": "?",
    "how_from": null
   },
   {
    "model": 12,
    "column": "acute_inpatient_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "ambulance_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "ambulatory_surgery_center_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "dialysis_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "durable_medical_equipment_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "emergency_department_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "home_health_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "inpatient_hospice_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "inpatient_psychiatric_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "inpatient_rehabilitation_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "lab_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "observation_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "office_based_other_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "office_based_pt_ot_st_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "office_based_radiology_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "office_based_surgery_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "office_based_visit_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "outpatient_hospice_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "outpatient_hospital_or_clinic_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "outpatient_psychiatric_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "outpatient_pt_ot_st_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "outpatient_radiology_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "outpatient_rehabilitation_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "outpatient_surgery_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "skilled_nursing_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "telehealth_visit_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "urgent_care_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "ancillary_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "medical_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "total_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "inpatient_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "office_based_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "other_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "outpatient_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 12,
    "column": "pharmacy_paid",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "engine"
   },
   {
    "model": 13,
    "column": "eob_total_list",
    "hop": 4,
    "end": true,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 10,
    "column": "eob_item_list",
    "hop": 4,
    "end": false,
    "how": "=",
    "how_from": "name"
   },
   {
    "model": 13,
    "column": "eob_item_list",
    "hop": 5,
    "end": true,
    "how": "=",
    "how_from": "name"
   }
  ],
  "edges": [
   [
    0,
    1,
    "="
   ],
   [
    0,
    2,
    "?"
   ],
   [
    0,
    3,
    "="
   ],
   [
    0,
    4,
    "=",
    "name"
   ],
   [
    2,
    5,
    "?"
   ],
   [
    2,
    6,
    "?"
   ],
   [
    2,
    7,
    "?"
   ],
   [
    2,
    8,
    "?"
   ],
   [
    2,
    9,
    "?"
   ],
   [
    2,
    10,
    "?"
   ],
   [
    2,
    11,
    "?"
   ],
   [
    2,
    12,
    "?"
   ],
   [
    2,
    13,
    "?"
   ],
   [
    2,
    14,
    "?"
   ],
   [
    2,
    15,
    "?"
   ],
   [
    2,
    16,
    "?"
   ],
   [
    2,
    17,
    "?"
   ],
   [
    2,
    18,
    "?"
   ],
   [
    2,
    19,
    "?"
   ],
   [
    2,
    20,
    "?"
   ],
   [
    2,
    21,
    "?"
   ],
   [
    2,
    22,
    "?"
   ],
   [
    2,
    23,
    "?"
   ],
   [
    2,
    24,
    "?"
   ],
   [
    2,
    25,
    "?"
   ],
   [
    2,
    26,
    "?"
   ],
   [
    2,
    27,
    "?"
   ],
   [
    2,
    28,
    "?"
   ],
   [
    2,
    29,
    "?"
   ],
   [
    2,
    30,
    "?"
   ],
   [
    2,
    31,
    "?"
   ],
   [
    2,
    32,
    "?"
   ],
   [
    2,
    33,
    "?"
   ],
   [
    2,
    34,
    "?"
   ],
   [
    2,
    35,
    "?"
   ],
   [
    2,
    36,
    "?"
   ],
   [
    2,
    37,
    "?"
   ],
   [
    2,
    38,
    "?"
   ],
   [
    2,
    39,
    "?"
   ],
   [
    2,
    40,
    "?"
   ],
   [
    2,
    41,
    "?"
   ],
   [
    2,
    42,
    "?"
   ],
   [
    3,
    43,
    "?"
   ],
   [
    3,
    44,
    "?"
   ],
   [
    5,
    45,
    "=",
    "name"
   ],
   [
    6,
    46,
    "=",
    "name"
   ],
   [
    7,
    47,
    "=",
    "name"
   ],
   [
    8,
    48,
    "=",
    "name"
   ],
   [
    9,
    49,
    "=",
    "name"
   ],
   [
    10,
    50,
    "=",
    "name"
   ],
   [
    11,
    51,
    "=",
    "name"
   ],
   [
    12,
    52,
    "=",
    "name"
   ],
   [
    13,
    53,
    "=",
    "name"
   ],
   [
    14,
    54,
    "=",
    "name"
   ],
   [
    15,
    55,
    "=",
    "name"
   ],
   [
    16,
    56,
    "=",
    "name"
   ],
   [
    17,
    57,
    "=",
    "name"
   ],
   [
    18,
    58,
    "=",
    "name"
   ],
   [
    19,
    59,
    "=",
    "name"
   ],
   [
    20,
    60,
    "?"
   ],
   [
    21,
    61,
    "=",
    "name"
   ],
   [
    22,
    62,
    "=",
    "name"
   ],
   [
    23,
    63,
    "=",
    "name"
   ],
   [
    24,
    64,
    "?"
   ],
   [
    25,
    65,
    "=",
    "name"
   ],
   [
    26,
    66,
    "=",
    "name"
   ],
   [
    27,
    67,
    "=",
    "name"
   ],
   [
    28,
    68,
    "?"
   ],
   [
    29,
    69,
    "=",
    "name"
   ],
   [
    30,
    70,
    "=",
    "name"
   ],
   [
    31,
    71,
    "=",
    "name"
   ],
   [
    32,
    72,
    "=",
    "name"
   ],
   [
    33,
    73,
    "?"
   ],
   [
    34,
    74,
    "=",
    "name"
   ],
   [
    35,
    75,
    "=",
    "name"
   ],
   [
    36,
    76,
    "=",
    "name"
   ],
   [
    37,
    77,
    "=",
    "name"
   ],
   [
    37,
    78,
    "?"
   ],
   [
    37,
    79,
    "?"
   ],
   [
    38,
    80,
    "=",
    "name"
   ],
   [
    38,
    78,
    "?"
   ],
   [
    38,
    79,
    "?"
   ],
   [
    39,
    78,
    "?"
   ],
   [
    39,
    81,
    "=",
    "name"
   ],
   [
    39,
    79,
    "?"
   ],
   [
    40,
    78,
    "?"
   ],
   [
    40,
    82,
    "=",
    "name"
   ],
   [
    40,
    79,
    "?"
   ],
   [
    41,
    78,
    "?"
   ],
   [
    41,
    83,
    "=",
    "name"
   ],
   [
    41,
    79,
    "?"
   ],
   [
    42,
    84,
    "=",
    "name"
   ],
   [
    42,
    79,
    "?"
   ],
   [
    43,
    85,
    "=",
    "name"
   ],
   [
    44,
    86,
    "?"
   ],
   [
    45,
    87,
    "="
   ],
   [
    46,
    88,
    "="
   ],
   [
    47,
    89,
    "="
   ],
   [
    48,
    90,
    "="
   ],
   [
    49,
    91,
    "="
   ],
   [
    50,
    92,
    "="
   ],
   [
    51,
    93,
    "="
   ],
   [
    52,
    94,
    "="
   ],
   [
    54,
    95,
    "="
   ],
   [
    55,
    96,
    "="
   ],
   [
    57,
    97,
    "="
   ],
   [
    58,
    98,
    "="
   ],
   [
    59,
    99,
    "="
   ],
   [
    60,
    100,
    "="
   ],
   [
    61,
    101,
    "="
   ],
   [
    62,
    102,
    "="
   ],
   [
    63,
    103,
    "="
   ],
   [
    65,
    104,
    "="
   ],
   [
    66,
    105,
    "="
   ],
   [
    67,
    106,
    "="
   ],
   [
    68,
    107,
    "="
   ],
   [
    69,
    108,
    "="
   ],
   [
    70,
    109,
    "="
   ],
   [
    72,
    110,
    "="
   ],
   [
    74,
    111,
    "="
   ],
   [
    75,
    112,
    "="
   ],
   [
    76,
    113,
    "="
   ],
   [
    77,
    114,
    "="
   ],
   [
    78,
    115,
    "="
   ],
   [
    79,
    116,
    "="
   ],
   [
    80,
    117,
    "="
   ],
   [
    81,
    118,
    "="
   ],
   [
    82,
    119,
    "="
   ],
   [
    83,
    120,
    "="
   ],
   [
    84,
    121,
    "="
   ],
   [
    85,
    122,
    "=",
    "name"
   ],
   [
    86,
    123,
    "=",
    "name"
   ],
   [
    123,
    124,
    "=",
    "name"
   ]
  ],
  "also_reads": [],
  "unresolved": [
   {
    "model": 14,
    "reason": "a WITH nested inside a CTE: the engine's columns here are unreliable",
    "code": "unresolved"
   }
  ],
  "may_carry": [
   {
    "id": "model.cms_hcc.cms_hcc__int_demographic_factors",
    "name": "cms_hcc__int_demographic_factors",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.cms_hcc.cms_hcc__int_disabled_interaction_factors",
    "name": "cms_hcc__int_disabled_interaction_factors",
    "reason": "below",
    "via": "cms_hcc__int_eligible_conditions"
   },
   {
    "id": "model.cms_hcc.cms_hcc__int_disease_factors",
    "name": "cms_hcc__int_disease_factors",
    "reason": "below",
    "via": "cms_hcc__int_eligible_conditions"
   },
   {
    "id": "model.cms_hcc.cms_hcc__int_disease_interaction_factors",
    "name": "cms_hcc__int_disease_interaction_factors",
    "reason": "below",
    "via": "cms_hcc__int_eligible_conditions"
   },
   {
    "id": "model.cms_hcc.cms_hcc__int_eligible_conditions",
    "name": "cms_hcc__int_eligible_conditions",
    "reason": "ephemeral"
   },
   {
    "id": "model.cms_hcc.cms_hcc__int_enrollment_interaction_factors",
    "name": "cms_hcc__int_enrollment_interaction_factors",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.cms_hcc.cms_hcc__int_hcc_count_factors",
    "name": "cms_hcc__int_hcc_count_factors",
    "reason": "below",
    "via": "cms_hcc__int_eligible_conditions"
   },
   {
    "id": "model.cms_hcc.cms_hcc__int_hcc_hierarchy",
    "name": "cms_hcc__int_hcc_hierarchy",
    "reason": "below",
    "via": "cms_hcc__int_eligible_conditions"
   },
   {
    "id": "model.cms_hcc.cms_hcc__int_hcc_mapping",
    "name": "cms_hcc__int_hcc_mapping",
    "reason": "below",
    "via": "cms_hcc__int_eligible_conditions"
   },
   {
    "id": "model.cms_hcc.cms_hcc__int_members",
    "name": "cms_hcc__int_members",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.cms_hcc.cms_hcc__int_monthly_collection_dates",
    "name": "cms_hcc__int_monthly_collection_dates",
    "reason": "ephemeral"
   },
   {
    "id": "model.cms_hcc.cms_hcc__patient_risk_factors",
    "name": "cms_hcc__patient_risk_factors",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.cms_hcc.cms_hcc__patient_risk_factors_monthly",
    "name": "cms_hcc__patient_risk_factors_monthly",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.cms_hcc.cms_hcc__patient_risk_scores",
    "name": "cms_hcc__patient_risk_scores",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.cms_hcc.cms_hcc__patient_risk_scores_monthly",
    "name": "cms_hcc__patient_risk_scores_monthly",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.cms_hcc.cms_hcc__patient_risk_scores_monthly_by_factor_type",
    "name": "cms_hcc__patient_risk_scores_monthly_by_factor_type",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.cms_hcc.cms_hcc__stg_core__medical_claim",
    "name": "cms_hcc__stg_core__medical_claim",
    "reason": "ephemeral"
   },
   {
    "id": "model.the_tuva_project.core__location",
    "name": "core__location",
    "reason": "below",
    "via": "core__stg_claims_location"
   },
   {
    "id": "model.the_tuva_project.core__practitioner",
    "name": "core__practitioner",
    "reason": "below",
    "via": "core__stg_claims_practitioner"
   },
   {
    "id": "model.the_tuva_project.core__stg_claims_location",
    "name": "core__stg_claims_location",
    "reason": "star"
   },
   {
    "id": "model.the_tuva_project.core__stg_claims_practitioner",
    "name": "core__stg_claims_practitioner",
    "reason": "star"
   },
   {
    "id": "model.fhir_preprocessing.fhir_preprocessing__int_medical_claim_diagnosis",
    "name": "fhir_preprocessing__int_medical_claim_diagnosis",
    "reason": "reads_value_model",
    "via": "fhir_preprocessing__stg_core__medical_claim"
   },
   {
    "id": "model.fhir_preprocessing.fhir_preprocessing__int_medical_claim_item_modifier",
    "name": "fhir_preprocessing__int_medical_claim_item_modifier",
    "reason": "reads_value_model",
    "via": "fhir_preprocessing__stg_core__medical_claim"
   },
   {
    "id": "model.fhir_preprocessing.fhir_preprocessing__int_medical_claim_procedure",
    "name": "fhir_preprocessing__int_medical_claim_procedure",
    "reason": "reads_value_model",
    "via": "fhir_preprocessing__stg_core__medical_claim"
   },
   {
    "id": "model.fhir_preprocessing.fhir_preprocessing__int_medical_claim_supporting_info",
    "name": "fhir_preprocessing__int_medical_claim_supporting_info",
    "reason": "reads_value_model",
    "via": "fhir_preprocessing__stg_core__medical_claim"
   },
   {
    "id": "model.cms_hcc.hcc_recapture__gap_status",
    "name": "hcc_recapture__gap_status",
    "reason": "below",
    "via": "hcc_recapture__int_all_hccs"
   },
   {
    "id": "model.cms_hcc.hcc_recapture__hcc_status",
    "name": "hcc_recapture__hcc_status",
    "reason": "below",
    "via": "hcc_recapture__int_all_hccs"
   },
   {
    "id": "model.cms_hcc.hcc_recapture__int_all_hccs",
    "name": "hcc_recapture__int_all_hccs",
    "reason": "star"
   },
   {
    "id": "model.cms_hcc.hcc_recapture__int_coded_hccs",
    "name": "hcc_recapture__int_coded_hccs",
    "reason": "below",
    "via": "cms_hcc__int_eligible_conditions"
   },
   {
    "id": "model.cms_hcc.hcc_recapture__int_determine_gap_status",
    "name": "hcc_recapture__int_determine_gap_status",
    "reason": "below",
    "via": "hcc_recapture__int_all_hccs"
   },
   {
    "id": "model.cms_hcc.hcc_recapture__int_eligible_benes",
    "name": "hcc_recapture__int_eligible_benes",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.cms_hcc.hcc_recapture__int_gap_status",
    "name": "hcc_recapture__int_gap_status",
    "reason": "below",
    "via": "hcc_recapture__int_all_hccs"
   },
   {
    "id": "model.cms_hcc.hcc_recapture__int_recapturable_hccs",
    "name": "hcc_recapture__int_recapturable_hccs",
    "reason": "below",
    "via": "hcc_recapture__int_all_hccs"
   },
   {
    "id": "model.cms_hcc.hcc_recapture__recapture_rates",
    "name": "hcc_recapture__recapture_rates",
    "reason": "below",
    "via": "hcc_recapture__int_all_hccs"
   },
   {
    "id": "model.cms_hcc.hcc_recapture__recapture_rates_monthly",
    "name": "hcc_recapture__recapture_rates_monthly",
    "reason": "below",
    "via": "hcc_recapture__int_all_hccs"
   },
   {
    "id": "model.cms_hcc.hcc_recapture__recapture_rates_monthly_ytd",
    "name": "hcc_recapture__recapture_rates_monthly_ytd",
    "reason": "below",
    "via": "hcc_recapture__int_all_hccs"
   },
   {
    "id": "model.cms_hcc.hcc_recapture__stg_eligible_benes",
    "name": "hcc_recapture__stg_eligible_benes",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.the_tuva_project.int_cost_service_category_1_allowed_pivot",
    "name": "int_cost_service_category_1_allowed_pivot",
    "reason": "reads_value_model",
    "via": "int_cost_service_categories"
   },
   {
    "id": "model.the_tuva_project.int_cost_service_category_2_allowed_pivot",
    "name": "int_cost_service_category_2_allowed_pivot",
    "reason": "reads_value_model",
    "via": "int_cost_service_categories"
   },
   {
    "id": "model.quality_measures.quality_measures__int_adh_diabetes_exclusions",
    "name": "quality_measures__int_adh_diabetes_exclusions",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_adh_diabetes_long",
    "name": "quality_measures__int_adh_diabetes_long",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_adh_statins_exclusions",
    "name": "quality_measures__int_adh_statins_exclusions",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_adh_statins_long",
    "name": "quality_measures__int_adh_statins_long",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_adhras_exclusions",
    "name": "quality_measures__int_adhras_exclusions",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_adhras_long",
    "name": "quality_measures__int_adhras_long",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_cqm130_denominator",
    "name": "quality_measures__int_cqm130_denominator",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_cqm130_exclusions",
    "name": "quality_measures__int_cqm130_exclusions",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_cqm130_long",
    "name": "quality_measures__int_cqm130_long",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_cqm130_numerator",
    "name": "quality_measures__int_cqm130_numerator",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_cqm438_denominator",
    "name": "quality_measures__int_cqm438_denominator",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_cqm438_exclusions",
    "name": "quality_measures__int_cqm438_exclusions",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_cqm438_long",
    "name": "quality_measures__int_cqm438_long",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_cqm438_numerator",
    "name": "quality_measures__int_cqm438_numerator",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_nqf0420_denominator",
    "name": "quality_measures__int_nqf0420_denominator",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_nqf0420_exclusions",
    "name": "quality_measures__int_nqf0420_exclusions",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_nqf0420_long",
    "name": "quality_measures__int_nqf0420_long",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_nqf0420_numerator",
    "name": "quality_measures__int_nqf0420_numerator",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_shared_exclusions_advanced_illness",
    "name": "quality_measures__int_shared_exclusions_advanced_illness",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_shared_exclusions_dementia",
    "name": "quality_measures__int_shared_exclusions_dementia",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_shared_exclusions_frailty",
    "name": "quality_measures__int_shared_exclusions_frailty",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_shared_exclusions_hospice_palliative",
    "name": "quality_measures__int_shared_exclusions_hospice_palliative",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_shared_exclusions_institutional_snp",
    "name": "quality_measures__int_shared_exclusions_institutional_snp",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_supd_exclusions",
    "name": "quality_measures__int_supd_exclusions",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__int_supd_long",
    "name": "quality_measures__int_supd_long",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__stg_medical_claim",
    "name": "quality_measures__stg_medical_claim",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__summary_counts",
    "name": "quality_measures__summary_counts",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__summary_long",
    "name": "quality_measures__summary_long",
    "reason": "not_traced"
   },
   {
    "id": "model.quality_measures.quality_measures__summary_wide",
    "name": "quality_measures__summary_wide",
    "reason": "not_traced"
   },
   {
    "id": "model.semantic_layer.semantic_layer__dim_data_source",
    "name": "semantic_layer__dim_data_source",
    "reason": "ephemeral"
   },
   {
    "id": "model.semantic_layer.semantic_layer__dim_date",
    "name": "semantic_layer__dim_date",
    "reason": "ephemeral"
   },
   {
    "id": "model.semantic_layer.semantic_layer__dim_encounter_provider",
    "name": "semantic_layer__dim_encounter_provider",
    "reason": "ephemeral"
   },
   {
    "id": "model.semantic_layer.semantic_layer__fact_encounter_service_bridge",
    "name": "semantic_layer__fact_encounter_service_bridge",
    "reason": "reads_value_model",
    "via": "semantic_layer__fact_claims"
   },
   {
    "id": "model.semantic_layer.semantic_layer__fact_member_months",
    "name": "semantic_layer__fact_member_months",
    "reason": "unresolved"
   },
   {
    "id": "model.semantic_layer.semantic_layer__fact_pharmacy_claims",
    "name": "semantic_layer__fact_pharmacy_claims",
    "reason": "below",
    "via": "core__stg_claims_practitioner"
   },
   {
    "id": "model.semantic_layer.semantic_layer__fact_quality_measures",
    "name": "semantic_layer__fact_quality_measures",
    "reason": "not_traced"
   },
   {
    "id": "model.semantic_layer.semantic_layer__fact_risk_factors",
    "name": "semantic_layer__fact_risk_factors",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.semantic_layer.semantic_layer__fact_risk_scores",
    "name": "semantic_layer__fact_risk_scores",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.semantic_layer.semantic_layer__int_encounter_enrichment",
    "name": "semantic_layer__int_encounter_enrichment",
    "reason": "below",
    "via": "semantic_layer__dim_encounter_provider"
   },
   {
    "id": "model.semantic_layer.semantic_layer__int_member_month_risk",
    "name": "semantic_layer__int_member_month_risk",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.semantic_layer.semantic_layer__stg_cms_hcc__patient_risk_factors",
    "name": "semantic_layer__stg_cms_hcc__patient_risk_factors",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.semantic_layer.semantic_layer__stg_cms_hcc__patient_risk_scores",
    "name": "semantic_layer__stg_cms_hcc__patient_risk_scores",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.semantic_layer.semantic_layer__stg_cms_hcc__patient_risk_scores_monthly",
    "name": "semantic_layer__stg_cms_hcc__patient_risk_scores_monthly",
    "reason": "below",
    "via": "cms_hcc__int_monthly_collection_dates"
   },
   {
    "id": "model.semantic_layer.semantic_layer__stg_core__practitioner",
    "name": "semantic_layer__stg_core__practitioner",
    "reason": "below",
    "via": "core__stg_claims_practitioner"
   },
   {
    "id": "model.semantic_layer.semantic_layer__stg_quality_measures__summary_long",
    "name": "semantic_layer__stg_quality_measures__summary_long",
    "reason": "not_traced"
   }
  ],
  "flags": [
   {
    "model": 14,
    "flag": "nested_with"
   }
  ],
  "consumers": {
   "declared": 0,
   "exposures": []
  },
  "truncated": false,
  "next": null
 },
 "truncated": false
}
