---
name: supabase
description: Supabase CLI and local development workflow. Use for database migrations, linking local to production, RLS policies, storage buckets, and schema management.
---

# Supabase CLI Reference

Reference for Supabase CLI, local development, and database management.

## Quick Reference

| Task | Command |
|------|---------|
| Start local Supabase | `supabase start` |
| Stop local Supabase | `supabase stop` |
| Check status | `supabase status` |
| Link to production | `supabase link --project-ref <your-project-ref>` |
| Create migration | `supabase migration new <name>` |
| Push to production | `supabase db push` |
| Pull from production | `supabase db pull` |
| Reset local DB | `supabase db reset` ⚠️ WIPES DATA |
| List migrations | `supabase migration list` |
| Show diff | `supabase db diff` |

---

## 1. Local Development Setup

### Starting Local Supabase

```bash
# Start all services
supabase start

# Check what's running
supabase status
```

**Local URLs after start:**
- API: http://127.0.0.1:54321
- Studio (GUI): http://127.0.0.1:54323
- Database: postgresql://postgres:postgres@127.0.0.1:54322/postgres

### Connecting to Local Database

```bash
# psql connection
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# Or use the SUPABASE_DATABASE_URL from .env
```

### Stopping Local Supabase

```bash
# Stop with data preservation (default)
supabase stop

# Stop and remove all data
supabase stop --no-backup  # ⚠️ DESTRUCTIVE
```

---

## 2. Linking Local to Production

### One-Time Setup

```bash
# Link to production project
supabase link --project-ref <your-project-ref>

# Verify link
supabase projects list
```

### After Linking You Can

```bash
# Pull production schema to local
supabase db pull

# Push local migrations to production
supabase db push

# See what would change
supabase db diff
```

---

## 3. Migration Workflow

### Option A: Incremental Migrations (Recommended for Teams)

```bash
# 1. Create a new migration file
supabase migration new add_user_preferences

# 2. Edit the generated file in supabase/migrations/
# File: supabase/migrations/YYYYMMDDHHMMSS_add_user_preferences.sql

# 3. Test locally
supabase db reset  # ⚠️ Wipes local data

# 4. Push to production
supabase db push
```

### Option B: Direct SQL (Simpler for Solo Dev)

```bash
# 1. Test SQL locally
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" << 'EOF'
ALTER TABLE users ADD COLUMN preferences JSONB DEFAULT '{}';
EOF

# 2. Run same SQL in production via SQL Editor
# https://supabase.com/dashboard/project/<your-project-ref>/sql/new

# 3. Update the schema file manually
# supabase/migrations/00000000000001_schema.sql
```

### Option C: Schema Diffing

```bash
# Make changes directly to local DB, then generate migration
supabase db diff -f my_changes

# This creates a migration file with the differences
```

---

## 4. Common Database Operations

### Running SQL Locally

```bash
# One-liner
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "SELECT * FROM posters LIMIT 5;"

# Multi-line with heredoc
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" << 'EOF'
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public';
EOF
```

### Checking RLS Policies

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" << 'EOF'
SELECT schemaname, tablename, policyname, cmd, qual 
FROM pg_policies 
WHERE schemaname IN ('public', 'storage')
ORDER BY tablename, policyname;
EOF
```

### Checking Storage Policies

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" << 'EOF'
SELECT policyname, cmd 
FROM pg_policies 
WHERE tablename = 'objects' AND schemaname = 'storage';
EOF
```

---

## 5. Storage Buckets

### Bucket Configuration

Buckets are defined in `supabase/config.toml`:

```toml
[storage.buckets.posters]
public = true
file_size_limit = "10MB"
allowed_mime_types = ["image/png", "image/jpeg", "image/webp", "image/gif"]

[storage.buckets.drafts]
public = true
file_size_limit = "10MB"
allowed_mime_types = ["image/png", "image/jpeg", "image/webp", "image/gif"]
```

### Storage RLS Policies

**CRITICAL SECURITY**: Storage policies control who can read/write files.

```sql
-- Public read only (SECURE)
CREATE POLICY "Allow public read" ON storage.objects
    FOR SELECT TO public USING (bucket_id IN ('drafts', 'posters'));

-- NO public INSERT/UPDATE/DELETE
-- Backend services use service_role which bypasses RLS
```

**NEVER allow public INSERT/UPDATE/DELETE on storage.objects** unless you want anyone on the internet to upload/delete files.

---

## 6. Row Level Security (RLS)

### Policy Patterns

**Public read:**
```sql
CREATE POLICY "Anyone can view" ON tablename
    FOR SELECT USING (true);
```

**Authenticated read:**
```sql
CREATE POLICY "Authenticated users can view" ON tablename
    FOR SELECT TO authenticated USING (true);
```

**Owner-only access:**
```sql
CREATE POLICY "Users can view own data" ON tablename
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own data" ON tablename
    FOR UPDATE USING (auth.uid() = user_id);
```

**Email-based access:**
```sql
CREATE POLICY "Users can view own drafts" ON poster_drafts
    FOR SELECT USING (auth.jwt() ->> 'email' = user_email);
```

**Service role (backend):**
```sql
-- Service role bypasses RLS entirely
-- Use for backend services that need full access
-- Policies with USING (true) are effectively service-only when combined with restrictive user policies
```

### Checking Who Can Access What

```sql
-- See all policies for a table
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename = 'your_table';
```

---

## 7. Environment Variables

### Required for Production

```bash
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=eyJ...   # Public anon key (safe for frontend)
SUPABASE_SECRET_KEY=eyJ...        # Service role key (backend only!)
SUPABASE_DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

### Local Development

```bash
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_PUBLISHABLE_KEY=eyJ...   # From `supabase status`
SUPABASE_SECRET_KEY=eyJ...        # From `supabase status`
SUPABASE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

---

## 8. Troubleshooting

### Migration Out of Sync

```bash
# See what migrations have been applied
supabase migration list

# Check migration history in database
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version;"
```

### Reset Local Database

```bash
# ⚠️ WIPES ALL LOCAL DATA
supabase db reset

# This re-runs all migrations from scratch
```

### Connection Issues

```bash
# Check if Supabase is running
supabase status

# Check Docker containers
docker ps | grep supabase

# Restart Supabase
supabase stop && supabase start
```

### Schema Drift

```bash
# See differences between local and production
supabase db diff

# Pull production schema (overwrites local migrations)
supabase db pull --schema public
```

---

## 9. Security Checklist

Before deploying schema changes:

- [ ] **No public INSERT/UPDATE/DELETE on storage** - Only SELECT allowed
- [ ] **RLS enabled on all tables** - `ALTER TABLE x ENABLE ROW LEVEL SECURITY`
- [ ] **User data scoped to owner** - Policies check `auth.uid()` or `auth.jwt()`
- [ ] **Service role for backends only** - Never expose in frontend
- [ ] **Sensitive columns protected** - No public access to PII
- [ ] **Foreign keys have ON DELETE** - Cascade or restrict as appropriate

### Dangerous Patterns to Avoid

```sql
-- ❌ NEVER: Public write to storage
CREATE POLICY "Allow uploads" ON storage.objects FOR INSERT TO public ...

-- ❌ NEVER: Unrestricted delete
CREATE POLICY "Delete anything" ON tablename FOR DELETE USING (true);

-- ❌ NEVER: SELECT * without considering sensitive columns
CREATE POLICY "View all" ON users FOR SELECT USING (true);
-- This exposes password_hash, email, etc.
```

---

## 10. Project File Locations

| Purpose | File |
|---------|------|
| Complete schema | `supabase/migrations/00000000000001_schema.sql` |
| Schema documentation | `supabase/DATABASE.md` |
| Local config | `supabase/config.toml` |
| Seed data | `supabase/seed.sql` |
| Git ignores | `supabase/.gitignore` |

### When Changing Schema

**ALWAYS update both:**
1. `supabase/migrations/00000000000001_schema.sql` - The SQL
2. `supabase/DATABASE.md` - The documentation

Keep schema documentation in sync with the actual SQL.

---

## 11. Useful SQL Queries

### List All Tables

```sql
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' ORDER BY table_name;
```

### List All Columns for a Table

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'posters' ORDER BY ordinal_position;
```

### List All Indexes

```sql
SELECT indexname, indexdef FROM pg_indexes 
WHERE schemaname = 'public' ORDER BY tablename, indexname;
```

### List Storage Buckets

```sql
SELECT id, name, public, file_size_limit, allowed_mime_types 
FROM storage.buckets;
```

### Check Table Row Counts

```sql
SELECT 
  schemaname,
  relname as table_name,
  n_live_tup as row_count
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
```
