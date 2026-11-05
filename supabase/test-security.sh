#!/usr/bin/env bash
# Security test for supabase/schema.sql (Row Level Security + audit chain).
# Runs against a LOCAL PostgreSQL (not your live Supabase). Usage:
#   PGHOST=... PGPORT=... PGUSER=postgres bash supabase/test-security.sh
# It creates a throwaway database "ll_test", a stand-in for Supabase's auth
# schema, loads schema.sql, then plays taxpayer / attacker / accountant.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
Q="psql -tA -q -v ON_ERROR_STOP=1"
$Q -d postgres -c "drop database if exists ll_test" -c "create database ll_test" >/dev/null
$Q -d ll_test >/dev/null <<'SQL'
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
grant usage on schema auth to anon, authenticated; grant usage on schema public to anon, authenticated;
SQL
$Q -d ll_test -f "$DIR/schema.sql" >/dev/null 2>&1 || { echo "schema.sql failed to load"; exit 1; }
Q="psql -tA -q -d ll_test"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1 (expected '$3', got '$2')"; fail=$((fail+1)); fi; }
as() { psql -tA -q -d ll_test -c "begin; set local role authenticated; set local request.jwt.claim.sub = '$1'; $2; commit;" 2>&1 | tail -1; }
newuser() { $Q -c "insert into auth.users(email,raw_user_meta_data) values ('$1','$2') returning id"; }

ALEX=$(newuser alex@demo.com '{"full_name":"Alex Nguyen","role":"taxpayer"}')
EVE=$(newuser eve@demo.com '{"full_name":"Eve","role":"accountant","practice_code":"WRONG"}')
JORDAN=$(newuser jordan@demo.com '{"full_name":"Jordan Lee","role":"accountant","practice_code":"LUMINARA-2026"}')

check "wrong practice code -> taxpayer" "$($Q -c "select role from profiles where id='$EVE'")" "taxpayer"
check "right practice code -> accountant" "$($Q -c "select role from profiles where id='$JORDAN'")" "accountant"
as $ALEX "insert into returns(id, owner_name, financial_year, risk_score) values ('R-1','Alex Nguyen','2025-26',5)" >/dev/null
check "taxpayer cannot change own role" "$(as $ALEX "update profiles set role='accountant'" | grep -c 'permission denied')" "1"
as $ALEX "update returns set status='approved' where id='R-1'" >/dev/null
check "taxpayer cannot self-approve" "$($Q -c "select status from returns where id='R-1'")" "draft"
check "other taxpayer cannot read the return" "$(as $EVE "select count(*) from returns")" "0"
check "cannot create a return for someone else" "$(as $EVE "insert into returns(id, owner, financial_year) values ('R-X','$ALEX','2025-26')" | grep -c 'row-level security')" "1"
as $ALEX "update returns set status='submitted' where id='R-1'" >/dev/null
as $ALEX "update returns set risk_score=0 where id='R-1'" >/dev/null
check "taxpayer cannot edit after submitting" "$($Q -c "select risk_score from returns where id='R-1'")" "5"
check "accountant can read all returns" "$(as $JORDAN "select count(*) from returns")" "1"
as $JORDAN "update returns set status='approved', approved_by='Someone Else' where id='R-1'" >/dev/null
check "approver name is stamped by the server" "$($Q -c "select approved_by from returns where id='R-1'")" "Jordan Lee"
as $ALEX "insert into audit_log(action, return_id) values ('submitted','R-1')" >/dev/null
as $JORDAN "insert into audit_log(action, return_id, field, from_value, to_value, justification) values ('override','R-1','wfhHours.value','1120','1100','Leave')" >/dev/null
check "cannot fake who wrote an audit entry" "$(as $ALEX "insert into audit_log(action, user_name) values ('x','Jordan Lee')" | grep -c 'permission denied')" "1"
check "audit entries link by hash" "$($Q -c "select (select prev_hash from audit_log where seq=2) = (select hash from audit_log where seq=1)")" "t"
check "accountant cannot edit audit entries" "$(as $JORDAN "update audit_log set justification='x'" | grep -c 'permission denied')" "1"
check "accountant cannot delete audit entries" "$(as $JORDAN "delete from audit_log" | grep -c 'permission denied')" "1"
check "taxpayer sees only own audit entries" "$(as $ALEX "select count(*) from audit_log")" "1"
check "chain verifies when untouched" "$(as $ALEX "select ok from verify_audit_chain()")" "t"
$Q -c "update audit_log set to_value='1500' where seq=2"
check "direct tampering is detected at entry 2" "$(as $JORDAN "select ok::text||','||broken_at from verify_audit_chain()")" "false,2"
check "anonymous visitors are refused" "$(psql -tA -q -d ll_test -c "begin; set local role anon; select count(*) from returns; commit;" 2>&1 | grep -c 'permission denied')" "1"
echo "---- $pass passed, $fail failed"
[ "$fail" = 0 ]
