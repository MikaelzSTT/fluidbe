# Fluid Runtime Phase 1 Probes

Set these first:

```sh
BASE_URL=http://127.0.0.1:5000
PROJECT_A=<runtime-enabled-project-id>
PROJECT_B=<another-runtime-enabled-project-id>
```

Enable the runtime explicitly for test projects in MongoDB:

```js
db.projects.updateMany(
  { _id: { $in: [ObjectId(PROJECT_A), ObjectId(PROJECT_B)] } },
  { $set: { runtimeEnabled: true } }
)
```

Isolation:

```sh
curl -sS -X POST "$BASE_URL/api/runtime/$PROJECT_A/collections/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"title":"A only","owner":"alpha"}'

curl -sS -X POST "$BASE_URL/api/runtime/$PROJECT_B/collections/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"title":"B only","owner":"beta"}'

curl -sS "$BASE_URL/api/runtime/$PROJECT_B/collections/tasks"
```

Expected: the project B response contains `B only` and does not contain `A only`.

Security:

```sh
curl -sS -i -X POST "$BASE_URL/api/runtime/$PROJECT_A/collections/tasks" \
  -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJECT_B\",\"title\":\"blocked\"}"

curl -sS -i "$BASE_URL/api/runtime/$PROJECT_A/collections/users"

curl -sS -i -X POST "$BASE_URL/api/runtime/$PROJECT_A/collections/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"$where":"this.owner == alpha"}'

DOC_ID=<document-id-created-under-project-a>
curl -sS -i -X PATCH "$BASE_URL/api/runtime/$PROJECT_A/collections/tasks/$DOC_ID" \
  -H 'Content-Type: application/json' \
  -d '{"$unset":{"owner":true}}'

curl -sS "$BASE_URL/api/runtime/$PROJECT_A/collections/tasks?limit=999"
```

Expected:
- `projectId` body override returns HTTP 400.
- blocked collection names return HTTP 400.
- keys starting with `$` return HTTP 400.
- `$unset` or `$rename` patch attempts return HTTP 400.
- pagination response has `pagination.limit` of `100` or less.

Runtime Auth:

```sh
REGISTER_A=$(
  curl -sS -X POST "$BASE_URL/api/runtime/$PROJECT_A/auth/register" \
    -H 'Content-Type: application/json' \
    -d '{"email":"runtime-user@example.com","password":"123456","role":"buyer"}'
)
echo "$REGISTER_A"

TOKEN_A=$(printf '%s' "$REGISTER_A" | node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8')).token")

LOGIN_A=$(
  curl -sS -X POST "$BASE_URL/api/runtime/$PROJECT_A/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"runtime-user@example.com","password":"123456"}'
)
echo "$LOGIN_A"

curl -sS "$BASE_URL/api/runtime/$PROJECT_A/auth/me" \
  -H "Authorization: Bearer $TOKEN_A"

curl -sS -i "$BASE_URL/api/runtime/$PROJECT_B/auth/me" \
  -H "Authorization: Bearer $TOKEN_A"

curl -sS -X POST "$BASE_URL/api/runtime/$PROJECT_B/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"email":"runtime-user@example.com","password":"123456","role":"seller"}'

printf '%s\n%s\n' "$REGISTER_A" "$LOGIN_A" | grep -i passwordHash
```

Expected:
- Registering in project A returns a runtime user and token.
- Logging in project A returns a runtime user and token.
- `/auth/me` with the project A token returns the project A runtime user.
- Using the project A token against project B returns HTTP 403.
- The same email can register in project B.
- The final `grep` prints nothing; `passwordHash` must not appear in auth responses.
