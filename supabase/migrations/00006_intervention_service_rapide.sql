-- Add 'service_rapide' to the intervention_type enum.
--
-- The application (tool schemas + persistAppointment / persistComplaint) uses
-- 'service_rapide' as a valid interventionType AND as the DEFAULT, but the
-- original enum (00004_apv.sql) only had 'mechanical' / 'bodywork'. As a result
-- every APV rendez-vous or réclamation tagged 'service_rapide' (oil change,
-- quick service — the most common case, and the fallback) failed to insert with
-- an invalid-enum error and was silently lost. This adds the missing value.
alter type public.intervention_type add value if not exists 'service_rapide';
