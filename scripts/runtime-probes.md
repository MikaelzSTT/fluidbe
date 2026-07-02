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
