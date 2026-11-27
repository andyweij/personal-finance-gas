-- 0019_custom_categories_and_templates.sql:
-- Add custom_categories_json and quick_templates_json to app_settings (zero extra D1 queries, backward compatible)
ALTER TABLE app_settings ADD COLUMN custom_categories_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE app_settings ADD COLUMN quick_templates_json TEXT NOT NULL DEFAULT '[]';
